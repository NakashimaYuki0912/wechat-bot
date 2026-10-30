#!/usr/bin/env node
/**
 * Single-concurrency DSH SDK worker for chat and explicit summary requests.
 * It reads persistent agent_requests, runs one SDK request at a time, and
 * inserts the fixed-target reply into the existing outbox. It never calls the
 * WeChat send API itself.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runSdk } from "../harness/sdk-runner.mjs";
import { ensureBudget, reserveBudget } from "./model-budget.js";
import { ensureRound, reserveRound, releaseRound } from "./acceptance-round.js";
import {
  buildSummaryInput, buildSummaryPrompt, validateSummaryOutput, renderSummary,
  buildChatPrompt, buildRecentChatContext, summaryRangeFor,
} from "./request-routing.js";
import { planSummaryBatches, runSummaryPipeline, finalSummaryFromFacts, condenseFactsForSummary, ensureSummaryBatches } from "./summary-pipeline.js";
import {
  ensureMemorySchema, parseChatEnvelope, applyMemoryActions, retrieveMemories,
  listGroupMemories, parseMemoryCommand, renderMemoryList,
} from "./memory.js";
import { ensureMediaSchema, resolveChatImages, recordMediaFailure, enqueueMediaFetchTask, waitForMediaTask, imageMd5FromContent } from "./media.js";
import { ensureWorkerColumns, claimRequest, recoverExpiredClaims, WORKER_CHAT, WORKER_SUMMARY, WORKER_ALL } from "./worker-common.js";
import { ensureModelCapacity, acquireModelSlot, releaseModelSlot } from "./model-capacity.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONFIG_PATH = process.env.BOT_CONFIG_PATH || path.join(ROOT, "data", "bridge", "config.json");
const DB_PATH = process.env.RELIABILITY_DB || path.join(ROOT, "data", "reliability", "reliability.db");
const LOG_PATH = path.join(ROOT, "data", "reliability", "agent.log");
const WORKER_KIND = process.env.WORKER_KIND || WORKER_ALL;
const WORKER_OWNER = `${WORKER_KIND}:${process.pid}:${crypto.randomUUID()}`;

function nowIso() { return new Date().toISOString(); }
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
function log(level, msg, extra = {}) {
  const line = JSON.stringify({ ts: nowIso(), level, msg, ...extra });
  console.log(line);
  fs.appendFile(LOG_PATH, line + "\n", { mode: 0o600 }).catch(() => {});
}

function ensure(db) {
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS outbox (
      request_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, group_name TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT, confirmed_at TEXT,
      last_error TEXT, response_json TEXT, evidence TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      account_id TEXT NOT NULL, group_id TEXT NOT NULL, session_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active', retired_at TEXT, retired_reason TEXT,
      PRIMARY KEY(account_id, group_id)
    );
    CREATE TABLE IF NOT EXISTS agent_session_history (
      account_id TEXT NOT NULL, group_id TEXT NOT NULL, session_id TEXT NOT NULL,
      retired_at TEXT NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY(account_id, group_id, session_id, retired_at)
    );
    CREATE TABLE IF NOT EXISTS agent_requests (
      request_id TEXT PRIMARY KEY, source_message_id INTEGER NOT NULL UNIQUE,
      source_local_id TEXT, source_account_id TEXT, source_group_id TEXT,
      account_id TEXT NOT NULL, group_id TEXT NOT NULL, sender_id TEXT, sender_display TEXT,
      sender_contact_name TEXT, sender_group_alias TEXT,
      request_type TEXT NOT NULL DEFAULT 'chat', trigger_reason TEXT,
      range_start INTEGER, range_end INTEGER, summary_target_date TEXT,
      snapshot_max_message_id INTEGER, snapshot_at TEXT,
      input_message_count INTEGER, input_truncated INTEGER DEFAULT 0,
      input_truncated_count INTEGER, coverage_json TEXT,
      budget_type TEXT, budget_reserved_at TEXT,
      round_id TEXT, round_reserved_at TEXT,
      prompt_text TEXT NOT NULL, source_json TEXT, status TEXT NOT NULL,
      queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      session_id TEXT, prompt_message_id TEXT, reply_text TEXT, display_chars INTEGER,
      generation_token_cap INTEGER, steps INTEGER, usage_json TEXT,
      error TEXT, cancel_state TEXT, duration_ms INTEGER, reply_request_id TEXT, evidence TEXT,
      summary_json TEXT, validation_status TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_requests_status ON agent_requests(status, queued_at);
    CREATE TABLE IF NOT EXISTS model_budget (
      type TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0,
      limit_value INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS acceptance_round (
      id TEXT PRIMARY KEY, total_limit INTEGER NOT NULL, chat_limit INTEGER NOT NULL,
      summary_limit INTEGER NOT NULL, total_used INTEGER NOT NULL DEFAULT 0,
      chat_used INTEGER NOT NULL DEFAULT 0, summary_used INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const cols = db.prepare("PRAGMA table_info(outbox)").all().map((r) => r.name);
  if (!cols.includes("agent_request_id")) db.exec("ALTER TABLE outbox ADD COLUMN agent_request_id TEXT");
  if (!cols.includes("source_message_id")) db.exec("ALTER TABLE outbox ADD COLUMN source_message_id INTEGER");
  const sessCols = db.prepare("PRAGMA table_info(agent_sessions)").all().map((r) => r.name);
  if (!sessCols.includes("state")) db.exec("ALTER TABLE agent_sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
  if (!sessCols.includes("retired_at")) db.exec("ALTER TABLE agent_sessions ADD COLUMN retired_at TEXT");
  if (!sessCols.includes("retired_reason")) db.exec("ALTER TABLE agent_sessions ADD COLUMN retired_reason TEXT");
  const reqCols = db.prepare("PRAGMA table_info(agent_requests)").all().map((r) => r.name);
  for (const [col, typ] of [
    ["source_local_id","TEXT"],["source_account_id","TEXT"],["source_group_id","TEXT"],
    ["sender_contact_name","TEXT"],["sender_group_alias","TEXT"],
    ["request_type","TEXT NOT NULL DEFAULT 'chat'"],["trigger_reason","TEXT"],
    ["reasoning_effort","TEXT"],["finish_reason","TEXT"],["original_chars","INTEGER"],
    ["range_start","INTEGER"],["range_end","INTEGER"],["summary_target_date","TEXT"],["snapshot_max_message_id","INTEGER"],
    ["snapshot_at","TEXT"],["input_message_count","INTEGER"],
    ["input_truncated","INTEGER DEFAULT 0"],["input_truncated_count","INTEGER"],
    ["coverage_json","TEXT"],["budget_type","TEXT"],["budget_reserved_at","TEXT"],
    ["round_id","TEXT"],["round_reserved_at","TEXT"],
    ["summary_json","TEXT"],["validation_status","TEXT"],
  ]) {
    if (!reqCols.includes(col)) db.exec(`ALTER TABLE agent_requests ADD COLUMN ${col} ${typ}`);
  }
  db.exec(`UPDATE agent_requests SET
    source_local_id=COALESCE(source_local_id,(SELECT local_id FROM messages WHERE messages.id=agent_requests.source_message_id)),
    source_account_id=COALESCE(source_account_id,(SELECT account_id FROM messages WHERE messages.id=agent_requests.source_message_id)),
    source_group_id=COALESCE(source_group_id,(SELECT group_id FROM messages WHERE messages.id=agent_requests.source_message_id))
    WHERE source_local_id IS NULL OR source_account_id IS NULL OR source_group_id IS NULL`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_source_scope ON agent_requests(source_account_id,source_group_id,source_local_id)");
  ensureWorkerColumns(db);
  ensureModelCapacity(db);
  ensureSummaryBatches(db);
  ensureMemorySchema(db);
  ensureMediaSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_tool_events (
      request_id TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL,
      query TEXT, url TEXT, args_json TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(request_id, call_id)
    );
  `);
}

function recoverRunning(db) {
  const rows = db.prepare("SELECT request_id FROM agent_requests WHERE status='running'").all();
  if (!rows.length) return;
  const now = nowIso();
  const stmt = db.prepare(`UPDATE agent_requests SET status='uncertain', finished_at=?,
    error='process restarted while running; not retried automatically',
    cancel_state='unknown_after_restart' WHERE request_id=? AND status='running'`);
  db.exec("BEGIN IMMEDIATE");
  try { for (const r of rows) stmt.run(now, r.request_id); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
  for (const r of rows) {
    const full = db.prepare("SELECT account_id,group_id,session_id,request_type FROM agent_requests WHERE request_id=?").get(r.request_id);
    if ((full?.request_type || "chat") === "chat" && full?.session_id) {
      retireSession(db, full.account_id, full.group_id, full.session_id, "restart_while_running");
    }
  }
  log("warn", "recovered running agent requests as uncertain", { count: rows.length });
}

function claim(db) {
  return claimRequest(db, { kind: WORKER_KIND, owner: WORKER_OWNER, leaseMs: 3600000 });
}

async function runSdkWithCapacity(kind, args) {
  const token = await acquireModelSlot(dbForCapacity, kind, Number(chatCfgGlobal?.model_max_concurrency ?? 4));
  try { return await runSdk(args); } finally { releaseModelSlot(dbForCapacity, token); }
}

function replyCount(db) {
  return db.prepare("SELECT count(*) n FROM outbox WHERE agent_request_id IS NOT NULL").get().n;
}

function sessionFor(db, accountId, groupId) {
  return db.prepare("SELECT session_id FROM agent_sessions WHERE account_id=? AND group_id=? AND state='active'").get(accountId, groupId)?.session_id ?? null;
}

function chatTurns(db, sessionId) {
  return db.prepare(`SELECT count(*) n FROM agent_requests WHERE session_id=? AND COALESCE(request_type,'chat')='chat'
    AND status IN ('succeeded','uncertain','failed')`).get(sessionId).n;
}

function retireSession(db, accountId, groupId, sessionId, reason) {
  if (!sessionId) return;
  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO agent_session_history(account_id,group_id,session_id,retired_at,reason)
    VALUES(?,?,?,?,?)`).run(accountId, groupId, sessionId, now, reason);
  db.prepare(`UPDATE agent_sessions SET state='retired', retired_at=?, retired_reason=?
    WHERE account_id=? AND group_id=? AND session_id=? AND state='active'`)
    .run(now, reason, accountId, groupId, sessionId);
}

function storeSession(db, accountId, groupId, sessionId) {
  const now = nowIso();
  db.prepare(`INSERT INTO agent_sessions(account_id,group_id,session_id,created_at,updated_at,state)
    VALUES(?,?,?,?,?,'active')
    ON CONFLICT(account_id,group_id) DO UPDATE SET session_id=excluded.session_id,
      updated_at=excluded.updated_at, state='active', retired_at=NULL, retired_reason=NULL`)
    .run(accountId, groupId, sessionId, now, now);
}

function quoteFrom(sourceJson) {
  let raw = {};
  try { raw = JSON.parse(sourceJson || "{}"); } catch {}
  return raw.quote || null;
}

function truncateChars(text, max) {
  const chars = Array.from(String(text || ""));
  if (chars.length <= max) return { text: chars.join(""), truncated: false };
  return { text: chars.slice(0, max).join("") + "…", truncated: true };
}

function summaryRows(db, req) {
  return db.prepare(`SELECT id,local_id,create_time,sender_id,sender_display,sender_contact_name,sender_group_alias,
    msg_type,content_text,content_raw,quote_status,quote_json,is_self
    FROM messages WHERE account_id=? AND group_id=? AND id<=? ORDER BY id`)
    .all(req.account_id, req.group_id, req.snapshot_max_message_id);
}

function recentChatRows(db, req, cfg) {
  const maxMessages = Math.max(1, Number(cfg.recent_context_max_messages ?? 8));
  const lookback = Math.max(1, Number(cfg.recent_context_lookback_minutes ?? 180));
  const current = db.prepare("SELECT create_time FROM messages WHERE id=?").get(req.source_message_id);
  const cutoff = current ? Number(current.create_time) - lookback * 60 : 0;
  const rows = db.prepare(`SELECT id,local_id,create_time,sender_id,sender_display,sender_contact_name,sender_group_alias,
    msg_type,content_text,content_raw,quote_status,quote_json,is_self
    FROM messages WHERE account_id=? AND group_id=? AND id<? AND create_time>=?
    ORDER BY id DESC LIMIT ?`)
    .all(req.account_id, req.group_id, req.source_message_id, cutoff, maxMessages * 6);
  return buildRecentChatContext(rows, {
    currentMessageId: req.source_message_id,
    maxMessages,
    maxChars: Number(cfg.recent_context_max_chars ?? 1600),
    lookbackMinutes: lookback,
  });
}

function coverageFor(db, req) {
  const pending = db.prepare("SELECT count(*) n FROM messages WHERE id<=? AND account_id=? AND group_id=? AND processed_at IS NULL").get(req.snapshot_max_message_id, req.account_id, req.group_id).n;
  const earliest = db.prepare("SELECT min(create_time) t FROM messages WHERE account_id=? AND group_id=? AND is_self=0").get(req.account_id, req.group_id).t;
  let note = "仅覆盖 reliability.db 中截至本次快照已补收的群消息；更早历史可能缺失";
  if (pending > 0) note += `；快照前仍有 ${pending} 条消息未处理`;
  if (earliest) note += `；库内最早群消息时间=${new Date(earliest * 1000).toISOString()}`;
  return { pending_before_snapshot: pending, earliest_group_message_epoch: earliest ?? null, note };
}

function failRequest(db, req, cfg, error, extra = {}) {
  // Every accepted request must produce one visible outcome. Model failures
  // already use enqueueFailureNotice; budget/range/precondition failures used
  // to only mark the row failed, leaving the group with no reply.
  const type = req.request_type || "chat";
  const text = type === "summary"
    ? "这次总结未能完成，请稍后重新尝试。"
    : "这次回答未能完成，请稍后重新提问。";
  const base = {
    session_id: null, prompt_message_id: null, usage_json: null, steps: 0,
    max_tokens: 0, reasoning_effort: null, finish_reason: "precondition_failed",
    duration_ms: 0, cancel_state: null, error: String(error).slice(0, 2000),
    evidence: JSON.stringify({ reason: "precondition_failed", ...extra }).slice(0, 4000),
  };
  const queued = enqueueFailureNotice(db, req, cfg, "failed", text, base, error,
    { reason: extra.reason || "precondition_failed", ...extra });
  if (!queued) {
    db.prepare(`UPDATE agent_requests SET status='failed', finished_at=?, error=?, evidence=?
      WHERE request_id=? AND reply_request_id IS NULL`).run(nowIso(), String(error).slice(0, 2000),
        JSON.stringify(extra).slice(0, 4000), req.request_id);
    log("warn", "agent request failed without a send", { request_id: req.request_id, request_type: type, error: String(error).slice(0, 500) });
  }
}

function splitSummaryText(text, cap) {
  const limit = Math.max(300, Number(cap || 5000));
  const chars = Array.from(String(text || ""));
  const parts = [];
  let at = 0;
  while (at < chars.length) {
    let end = Math.min(chars.length, at + limit);
    if (end < chars.length) {
      // Prefer a paragraph/sentence boundary without dropping content.
      const window = chars.slice(at, end).join("");
      const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf("；"));
      if (cut > Math.floor(limit * 0.45)) end = at + Array.from(window.slice(0, cut + 1)).length;
    }
    parts.push(chars.slice(at, end).join(""));
    at = end;
  }
  return parts.length ? parts : [""];
}

function enqueueSummarySuccess(db, req, cfg, sessionId, base, text, displayCap, summaryFields = {}) {
  const parts = splitSummaryText(text, Math.max(300, Number(displayCap || 5000) - 40));
  const renderedParts = parts.map((part, i) => (parts.length > 1 ? `【总结 ${i + 1}/${parts.length}】\n${part}` : part));
  const fullText = renderedParts.join("\n");
  const now = nowIso();
  const ids = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const cap = cfg.auto_reply_cap ?? 5;
    const used = replyCount(db);
    if (cfg.limits?.enforce_auto_reply_cap !== false && used + renderedParts.length > cap) {
      db.prepare(`UPDATE agent_requests SET status='failed', finished_at=?, error=?, evidence=?
        WHERE request_id=?`).run(now, "global auto-reply cap reached; summary parts not enqueued",
          `cap=${cap}; used=${used}; parts=${renderedParts.length}`, req.request_id);
      db.exec("COMMIT");
      log("warn", "summary parts dropped by cap", { request_id: req.request_id, used, cap, parts: renderedParts.length });
      return false;
    }
    for (let i = 0; i < renderedParts.length; i++) {
      const id = crypto.randomUUID(); ids.push(id);
      db.prepare(`INSERT INTO outbox
        (request_id,group_id,group_name,text,status,attempts,created_at,updated_at,agent_request_id,source_message_id,evidence)
        VALUES(?,?,?,?, 'queued',0,?,?,?,?,?)`).run(
        id, cfg.group_id, cfg.group_name, renderedParts[i], now, now, req.request_id, req.source_message_id,
        `summary part ${i + 1}/${renderedParts.length}; request_type=summary; source_message_id=${req.source_message_id}`);
    }
    db.prepare(`UPDATE agent_requests SET status='succeeded', finished_at=?, session_id=?,
      prompt_message_id=?, reply_text=?, display_chars=?, original_chars=?, generation_token_cap=?,
      reasoning_effort=?, finish_reason=?, steps=?, usage_json=?, duration_ms=?, cancel_state=?,
      reply_request_id=?, evidence=?, input_message_count=?, input_truncated=?, input_truncated_count=?,
      coverage_json=?, summary_json=?, validation_status=? WHERE request_id=?`).run(
      now, sessionId, base.prompt_message_id ?? null, fullText, Array.from(fullText).length,
      Array.from(fullText).length, base.max_tokens, base.reasoning_effort ?? null,
      base.finish_reason ?? null, base.steps ?? 0, base.usage_json ?? null, base.duration_ms ?? 0,
      base.cancel_state ?? null, ids[0], `summary parts=${renderedParts.length}; ${base.evidence || ""}`.slice(0, 4000),
      summaryFields.input_message_count ?? null, summaryFields.input_truncated ? 1 : 0,
      summaryFields.input_truncated_count ?? 0, summaryFields.coverage_json ?? null,
      summaryFields.summary_json ?? null, summaryFields.validation_status ?? "valid", req.request_id);
    db.exec("COMMIT");
    log("info", "summary reply queued in parts", { request_id: req.request_id, parts: renderedParts.length, reply_request_id: ids[0] });
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    db.prepare(`UPDATE agent_requests SET status='uncertain', finished_at=?, error=?, cancel_state='summary_outbox_transaction_failed' WHERE request_id=?`)
      .run(nowIso(), String(e).slice(0, 2000), req.request_id);
    log("error", "summary outbox transaction failed", { request_id: req.request_id, error: String(e) });
    return false;
  }
}

function enqueueSuccess(db, req, cfg, sessionId, base, text, displayCap, summaryFields = {}) {
  const chars = Array.from(String(text));
  let display = chars.slice(0, displayCap).join("");
  if (chars.length > displayCap) display += "\n…（显示已截断，完整回答未发送）";
  const displayChars = Array.from(display).length;
  const replyRequestId = crypto.randomUUID();
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const cap = cfg.auto_reply_cap ?? 5;
    const used = replyCount(db);
    if (cfg.limits?.enforce_auto_reply_cap !== false && used >= cap) {
      if ((req.request_type || "chat") === "chat") retireSession(db, req.account_id, req.group_id, sessionId, "reply_cap_after_success");
      db.prepare(`UPDATE agent_requests SET status='failed', finished_at=?,
        error='global auto-reply cap reached', evidence=? WHERE request_id=?`)
        .run(now, `cap=${cap} used=${used}; reply not enqueued`, req.request_id);
      db.exec("COMMIT");
      log("warn", "agent reply dropped by cap", { request_id: req.request_id, used, cap });
      return false;
    }
    db.prepare(`INSERT INTO outbox
      (request_id,group_id,group_name,text,status,attempts,created_at,updated_at,agent_request_id,source_message_id,evidence)
      VALUES(?,?,?,?, 'queued',0,?,?,?,?,?)`)
      .run(replyRequestId, cfg.group_id, cfg.group_name, display, now, now, req.request_id, req.source_message_id,
        `agent reply; request_type=${req.request_type || "chat"}; source_message_id=${req.source_message_id}; sdk_session=${sessionId}`);
    db.prepare(`UPDATE agent_requests SET status='succeeded', finished_at=?, session_id=?,
      prompt_message_id=?, reply_text=?, display_chars=?, original_chars=?, generation_token_cap=?,
      reasoning_effort=?, finish_reason=?, steps=?,
      usage_json=?, duration_ms=?, cancel_state=?, reply_request_id=?, evidence=?,
      input_message_count=?, input_truncated=?, input_truncated_count=?, coverage_json=?,
      summary_json=?, validation_status=? WHERE request_id=?`)
      .run(now, sessionId, base.prompt_message_id, display, displayChars, chars.length, base.max_tokens,
        base.reasoning_effort ?? null, base.finish_reason ?? null, base.steps,
        base.usage_json, base.duration_ms, base.cancel_state, replyRequestId, base.evidence,
        summaryFields.input_message_count ?? null, summaryFields.input_truncated ? 1 : 0,
        summaryFields.input_truncated_count ?? 0, summaryFields.coverage_json ?? null,
        summaryFields.summary_json ?? null, summaryFields.validation_status ?? "n/a", req.request_id);
    db.exec("COMMIT");
    log("info", "agent request succeeded and reply queued", {
      request_id: req.request_id, reply_request_id: replyRequestId,
      request_type: req.request_type || "chat", source_message_id: req.source_message_id,
      display_chars: chars.length, output_tokens: base.usage?.outputTokens ?? null,
      total_tokens: base.usage?.totalTokens ?? null, steps: base.steps, duration_ms: base.duration_ms,
    });
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    if ((req.request_type || "chat") === "chat") retireSession(db, req.account_id, req.group_id, sessionId, "local_outbox_transaction_failed");
    db.prepare(`UPDATE agent_requests SET status='uncertain', finished_at=?,
      error=?, cancel_state='local_outbox_transaction_failed' WHERE request_id=?`)
      .run(nowIso(), String(e).slice(0, 2000), req.request_id);
    log("error", "agent outbox transaction failed", { request_id: req.request_id, error: String(e) });
    return false;
  }
}

function enqueueFailureNotice(db, req, cfg, status, text, base, error, extra = {}) {
  const chars = Array.from(String(text));
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT reply_request_id FROM agent_requests WHERE request_id=?").get(req.request_id);
    if (existing?.reply_request_id) { db.exec("COMMIT"); return false; }
    const cap = cfg.auto_reply_cap ?? 8;
    const used = replyCount(db);
    if (cfg.limits?.enforce_auto_reply_cap !== false && used >= cap) {
      db.prepare(`UPDATE agent_requests SET status=?, finished_at=?, error=?, evidence=? WHERE request_id=?`)
        .run(status, now, `${error}; failure notice blocked by cap`, JSON.stringify(extra).slice(0, 4000), req.request_id);
      db.exec("COMMIT");
      return false;
    }
    const replyRequestId = crypto.randomUUID();
    db.prepare(`INSERT INTO outbox
      (request_id,group_id,group_name,text,status,attempts,created_at,updated_at,agent_request_id,source_message_id,evidence)
      VALUES(?,?,?,?, 'queued',0,?,?,?,?,?)`)
      .run(replyRequestId, cfg.group_id, cfg.group_name, chars.slice(0, 120).join(""), now, now,
        req.request_id, req.source_message_id, `failure notice; no model retry; ${extra.reason || ""}`);
    db.prepare(`UPDATE agent_requests SET status=?, finished_at=?, session_id=?,
      prompt_message_id=?, reply_text=?, display_chars=?, original_chars=?, generation_token_cap=?,
      reasoning_effort=?, finish_reason=?, steps=?, usage_json=?, duration_ms=?,
      cancel_state=?, error=?, reply_request_id=?, evidence=?, validation_status=?,
      summary_json=? WHERE request_id=?`)
      .run(status, now, base.session_id ?? null, base.prompt_message_id ?? null,
        chars.slice(0, 120).join(""), Array.from(chars.slice(0, 120).join("")).length, chars.length, base.max_tokens,
        base.reasoning_effort ?? null, base.finish_reason ?? null, base.steps ?? null,
        base.usage_json ?? null, base.duration_ms ?? 0, base.cancel_state ?? null,
        String(error).slice(0, 2000), replyRequestId, JSON.stringify(extra).slice(0, 4000),
        extra.validation_status ?? "failure_notice", extra.summary_json ?? null, req.request_id);
    db.exec("COMMIT");
    log("warn", "failure feedback queued once", { request_id: req.request_id, status, reply_request_id: replyRequestId });
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    log("error", "failure feedback outbox failed", { request_id: req.request_id, error: String(e) });
    return false;
  }
}

function formatShanghaiDate(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

/** Program-generated no-data reply. It makes no model call and consumes no
 * model budget or acceptance-round call; it does count as a group reply. */
function enqueueFixedSummary(db, req, cfg, text, displayCap, fields) {
  const chars = Array.from(String(text));
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const cap = cfg.auto_reply_cap ?? 8;
    const used = replyCount(db);
    if (cfg.limits?.enforce_auto_reply_cap !== false && used >= cap) {
      db.prepare(`UPDATE agent_requests SET status='failed', finished_at=?,
        error='global auto-reply cap reached', evidence=? WHERE request_id=?`)
        .run(now, `cap=${cap} used=${used}; no model; no fixed reply`, req.request_id);
      db.exec("COMMIT");
      log("warn", "fixed no-data reply dropped by cap", { request_id: req.request_id, used, cap });
      return false;
    }
    const replyRequestId = crypto.randomUUID();
    db.prepare(`INSERT INTO outbox
      (request_id,group_id,group_name,text,status,attempts,created_at,updated_at,agent_request_id,source_message_id,evidence)
      VALUES(?,?,?,?, 'queued',0,?,?,?,?,?)`)
      .run(replyRequestId, cfg.group_id, cfg.group_name, chars.slice(0, displayCap).join(""), now, now,
        req.request_id, req.source_message_id, `no model; no summarizable messages; request_type=summary`);
    db.prepare(`UPDATE agent_requests SET status='succeeded', finished_at=?, session_id=NULL,
      prompt_message_id=NULL, reply_text=?, display_chars=?, original_chars=?, generation_token_cap=0,
      reasoning_effort=NULL, finish_reason='no_messages', steps=0,
      usage_json=NULL, duration_ms=0, cancel_state=NULL, error=NULL, reply_request_id=?,
      evidence=?, input_message_count=0, input_truncated=0, input_truncated_count=0,
      coverage_json=?, summary_json=NULL, validation_status='no_messages' WHERE request_id=?`)
      .run(now, chars.slice(0, displayCap).join(""), Array.from(chars.slice(0, displayCap).join("")).length,
        chars.length, replyRequestId, "no_model; no_summarizable_messages; fixed reply",
        fields.coverage_json ?? null, req.request_id);
    db.exec("COMMIT");
    log("info", "no-data summary fixed reply queued", { request_id: req.request_id, reply_request_id: replyRequestId, display_chars: chars.length });
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    log("error", "fixed summary outbox failed", { request_id: req.request_id, error: String(e) });
    return false;
  }
}

let dbForCapacity = null;
let chatCfgGlobal = null;
async function main() {
  const cfg = await readJson(CONFIG_PATH, {});
  const accountId = cfg.account_id || "wxid_example";
  const groupId = cfg.group_id;
  const groupName = cfg.group_name;
  const cap = cfg.auto_reply_cap ?? 5;
  const chatCfg = cfg.chat || {};
  const summaryCfg = cfg.summary || {};
  if (!groupId || !groupName) throw new Error("target group is not pinned");
  const db = new DatabaseSync(DB_PATH);
  ensure(db);
  dbForCapacity = db;
  chatCfgGlobal = cfg.chat || {};
  ensureBudget(db, cfg);
  const roundId = ensureRound(db, cfg);
  const expired = recoverExpiredClaims(db, WORKER_KIND);
  log("info", "agent worker starting", {
    worker_kind: WORKER_KIND, recovered_expired: expired,
    account_id: accountId, group_id: groupId, cap,
    limits: cfg.limits || null,
    chat: chatCfg, summary: summaryCfg, model_budget: cfg.model_budget || null,
    acceptance_round: cfg.acceptance_round || null, round_id: roundId,
  });

  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    const req = claim(db);
    if (!req) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const type = req.request_type || "chat";
    const started = Date.now();
    const usedReplies = replyCount(db);
    if (cfg.limits?.enforce_auto_reply_cap !== false && usedReplies >= cap) {
      db.prepare(`UPDATE agent_requests SET status='failed', finished_at=?,
        error='global auto-reply cap reached', evidence=? WHERE request_id=?`)
        .run(nowIso(), `cap=${cap} used=${usedReplies}; no model call`, req.request_id);
      enqueueFailureNotice(db, req, cfg, "failed", "这次回答未能完成，请稍后重新提问。",
        { session_id: null, max_tokens: 0, duration_ms: 0, finish_reason: "reply_cap" },
        "global auto-reply cap reached", { reason: "reply_cap" });
      log("warn", "agent request rejected by cap", { request_id: req.request_id, type, used: usedReplies, cap });
      continue;
    }

    let sessionId, resume = false, prompt, maxTokens, timeoutMs, displayCap, reasoningEffort, summaryFields = {};
    let summaryInput = null, coverage = null, imageData = [], webSearchEnabled = false;

    if (type === "memory") {
      const isAdmin = Array.isArray(cfg.admins) && cfg.admins.some((a) => a.sender_id === req.sender_id);
      const command = parseMemoryCommand(req.prompt_text);
      const displayCap = Number(chatCfg.display_chars ?? 2000);
      const ctx = { account_id: req.account_id, group_id: req.group_id, sender_id: req.sender_id,
        isAdmin, currentMessageId: req.source_message_id, text: req.prompt_text, quotePresent: Boolean(quoteFrom(req.source_json)) };
      let text;
      if (!command || command.action === "help") {
        text = "记忆命令：/memory 查看本人及群背景；/memory forget <id> 忘记自己的记忆；管理员可用 /memory group 查看群背景。";
      } else if (command.action === "list") {
        const got = retrieveMemories(db, ctx, {
          limit: Number(chatCfg.memory_retrieval_max_entries ?? 8),
          maxChars: Number(chatCfg.memory_retrieval_max_chars ?? 1800),
        });
        text = renderMemoryList(got.memories);
      } else if (command.action === "group") {
        if (!isAdmin) text = "只有管理员可以查看本群共同背景。";
        else {
          const rows = listGroupMemories(db, ctx, { limit: 20 });
          text = renderMemoryList(rows);
        }
      } else if (command.action === "forget") {
        const applied = applyMemoryActions(db, ctx, [{ operation: "forget", memory_id: command.id, source_message_id: req.source_message_id }]);
        text = applied.ok ? "已忘记该条记忆。" : `没有忘记：${applied.error}`;
      }
      const base = { session_id: null, prompt_message_id: null, usage_json: null, steps: null,
        max_tokens: 0, reasoning_effort: null, finish_reason: "memory_command", duration_ms: 0,
        cancel_state: null, error: null, evidence: `memory command; no model` };
      enqueueSuccess(db, req, cfg, null, base, text, displayCap, {
        validation_status: "memory_command", coverage_json: JSON.stringify({ command: command?.action ?? "help" }),
      });
      continue;
    }

    if (type === "summary") {
      if (!req.range_start || !req.range_end || !req.snapshot_max_message_id) {
        failRequest(db, req, cfg, "summary request missing persisted range/snapshot");
        continue;
      }
      const rows = summaryRows(db, req);
      coverage = coverageFor(db, req);
      // Read the complete selected range. Batching is the only place that
      // applies a budget; no "most recent N" cap may silently drop messages.
      summaryInput = buildSummaryInput(rows, {
        sourceMessageId: req.source_message_id,
        rangeStartMs: Number(req.range_start), rangeEndMs: Number(req.range_end),
        snapshotMaxId: Number(req.snapshot_max_message_id),
        maxMessages: Number(summaryCfg.max_input_messages ?? 1000),
        maxChars: Number(summaryCfg.max_input_chars ?? 200000),
      });
      const plan = planSummaryBatches(summaryInput.messages, {
        maxMessages: Number(summaryCfg.batch_input_max_messages ?? 40),
        maxChars: Number(summaryCfg.batch_input_max_chars ?? 24000),
        maxTokens: Number(summaryCfg.batch_input_max_tokens ?? 8000),
      });
      coverage.total_messages = summaryInput.selectedCount;
      coverage.total_chars = summaryInput.approxChars;
      coverage.batch_total = plan.batches.length;
      coverage.chunked_messages = plan.chunkedCount;
      coverage.nontext = summaryInput.nonTextCount;
      coverage.unresolved_quotes = summaryInput.unresolvedQuotes;
      coverage.batch_budget = { max_messages: Number(summaryCfg.batch_input_max_messages ?? 40), max_chars: Number(summaryCfg.batch_input_max_chars ?? 24000), max_estimated_tokens: Number(summaryCfg.batch_input_max_tokens ?? 8000) };
      db.prepare(`UPDATE agent_requests SET input_message_count=?, input_truncated=0,
        input_truncated_count=0, coverage_json=? WHERE request_id=?`)
        .run(summaryInput.selectedCount, JSON.stringify(coverage), req.request_id);
      if (summaryInput.selectedCount === 0) {
        const label = req.summary_target_date || formatShanghaiDate(Number(req.range_start));
        const fixed = req.summary_target_date
          ? `无当日对话信息（${label}）。`
          : "无当日对话信息。";
        enqueueFixedSummary(db, req, cfg, fixed, Number(summaryCfg.display_chars ?? 1500), {
          coverage_json: JSON.stringify(coverage),
        });
        continue;
      }
      const round = reserveRound(db, cfg, "summary");
      if (!round.ok) { failRequest(db, req, cfg, round.reason, { round }); continue; }
      const budget = reserveBudget(db, "summary", cfg);
      if (!budget.ok) { if (!round.disabled) releaseRound(db, cfg, "summary"); failRequest(db, req, cfg, budget.reason, { budget }); continue; }
      db.prepare("UPDATE agent_requests SET budget_type='summary', budget_reserved_at=?, round_id=?, round_reserved_at=? WHERE request_id=?")
        .run(nowIso(), round.round_id ?? cfg.acceptance_round?.id ?? null, nowIso(), req.request_id);
      const pipeline = await runSummaryPipeline({ db, req, cfg, source: summaryInput, plan, coverage, runSdk: (args) => runSdkWithCapacity(WORKER_SUMMARY, args), log });
      const displayCap = Number(summaryCfg.display_chars ?? 5000);
      const pipelineBase = {
        session_id: `summary-${req.request_id}-pipeline`, prompt_message_id: null,
        usage_json: null, steps: null, max_tokens: Number(summaryCfg.batch_max_tokens ?? 2048),
        reasoning_effort: summaryCfg.batch_reasoning_effort || "low", finish_reason: null,
        duration_ms: Date.now() - started, cancel_state: null, error: null,
        evidence: JSON.stringify({ pipeline: "bounded_batches", coverage }).slice(0, 4000),
      };
      if (!pipeline.ok) {
        // A single oversized batch must not erase a whole day's summary. Send
        // the successfully extracted facts as an explicitly partial summary.
        const partialFacts = Array.isArray(pipeline.partialFacts) ? pipeline.partialFacts : (Array.isArray(pipeline.facts) ? pipeline.facts : []);
        if (partialFacts.length) {
          const partialValue = finalSummaryFromFacts(condenseFactsForSummary(partialFacts, summaryInput));
          const partial = renderSummary(partialValue, summaryInput, {
            startMs: Number(req.range_start), endMs: Number(req.range_end),
            displayChars: Number.MAX_SAFE_INTEGER,
            coverageNote: `部分总结：${pipeline.coverage?.batch_failed ?? 0} 个输入批次失败，以下只覆盖已完成批次。`,
          });
          const partialCov = pipeline.coverage || coverage;
          const partialText = `${partial.text}
注：本次为部分总结；${partialCov.batch_failed ?? 0} 个输入批次未完成，未覆盖的内容不纳入结论。`;
          const partialFields = {
            input_message_count: summaryInput.selectedCount,
            input_truncated: false,
            input_truncated_count: 0,
            coverage_json: JSON.stringify({ ...partialCov, partial: true }),
            summary_json: JSON.stringify({ facts: partialFacts, partial: true }),
            validation_status: "partial",
          };
          enqueueSummarySuccess(db, req, cfg, pipelineBase.session_id, pipelineBase, partialText, displayCap, partialFields);
          log("warn", "partial summary queued", { request_id: req.request_id, failed_batches: partialCov.batch_failed ?? 0, facts: partialFacts.length });
          continue;
        }
        enqueueFailureNotice(db, req, cfg, "failed",
          `这次总结未能完成：${pipeline.coverage?.batch_failed ?? 0} 个批次失败，未生成完整总结。请稍后重新尝试。`,
          pipelineBase, pipeline.error || "summary pipeline failed",
          { reason: "summary_pipeline_failed", coverage_json: JSON.stringify(pipeline.coverage || coverage) });
        log("warn", "summary pipeline failed", { request_id: req.request_id, error: pipeline.error, coverage: pipeline.coverage });
        continue;
      }
      const finalValue = finalSummaryFromFacts(condenseFactsForSummary(pipeline.facts, summaryInput));
      const rendered = renderSummary(finalValue, summaryInput, {
        startMs: Number(req.range_start), endMs: Number(req.range_end),
        displayChars: Number.MAX_SAFE_INTEGER,
      });
      const cov = pipeline.coverage || coverage;
      const omittedNote = summaryInput.omittedCount ? `；超出任务边界未纳入 ${summaryInput.omittedCount} 条` : "";
      const coverageLine = `覆盖：输入 ${summaryInput.selectedCount} 条；计划批次 ${cov.batch_planned ?? plan.batches.length}；尝试 ${cov.batch_attempted ?? 0}；成功 ${cov.batch_succeeded ?? 0}；失败/已拆分 ${cov.batch_failed ?? 0}；未完成 ${cov.incomplete_batches ?? 0}；归并 ${cov.merge_total ?? 0} 次；非文本 ${summaryInput.nonTextCount} 条未解析${omittedNote}。`;
      const text = `${rendered.text}\n${coverageLine}`;
      const summaryFields = {
        input_message_count: summaryInput.selectedCount,
        input_truncated: Boolean(summaryInput.omittedCount),
        input_truncated_count: summaryInput.omittedCount || 0,
        coverage_json: JSON.stringify({ ...cov, omitted_messages: summaryInput.omittedCount || 0 }),
        summary_json: JSON.stringify({ facts: pipeline.facts }),
        validation_status: "valid",
      };
      enqueueSummarySuccess(db, req, cfg, pipelineBase.session_id, pipelineBase, text, displayCap, summaryFields);
      log("info", "summary pipeline completed", {
        request_id: req.request_id, batches: cov.batch_total, succeeded: cov.batch_succeeded,
        merge_calls: cov.merge_total, facts: pipeline.facts.length, chars: Array.from(text).length,
      });
      continue;
    } else {
      let active = sessionFor(db, req.account_id || accountId, req.group_id || groupId);
      const maxTurns = Number(chatCfg.session_max_turns ?? 40);
      if (active && chatTurns(db, active) >= maxTurns) {
        retireSession(db, req.account_id || accountId, req.group_id || groupId, active, "chat_context_turn_limit");
        active = null;
      }
      sessionId = active || `wx-${crypto.randomUUID()}`;
      resume = Boolean(active);
      const textTrunc = truncateChars(req.prompt_text, Number(chatCfg.max_input_chars ?? 4000));
      const recent = recentChatRows(db, req, chatCfg);
      const sourceRow = db.prepare("SELECT msg_type FROM messages WHERE id=?").get(req.source_message_id);
      // Image recognition is disabled for the chat/summary product line.
      // The code remains archived; no media task, prompt, or model image block
      // is created while image_enabled is false.
      const imageFeatureEnabled = chatCfg.image_enabled !== false;
      let imageInfo = imageFeatureEnabled
        ? (resolveChatImages(db, req, {
            mediaRoot: chatCfg.media_root ? path.resolve(ROOT, chatCfg.media_root) : undefined,
            maxImages: Number(chatCfg.image_max_count ?? 2),
            recentLookbackSeconds: Number(chatCfg.recent_image_lookback_seconds ?? 600),
            cacheRoots: (chatCfg.wechat_media_cache_roots || []).map((p) => path.resolve(ROOT, p)),
          }) || { targets: [], images: [], failures: [] })
        : { targets: [], images: [], failures: [] };
      imageData = imageInfo.images || [];
      // Missing media: persist a fetch task and hold this request. The host UI
      // helper resolves the exact source message and materializes a file.
      if (imageFeatureEnabled && chatCfg.auto_image_fetch !== false && (imageInfo.targets?.length || 0) > (imageInfo.images?.length || 0)) {
        const missing = (imageInfo.targets || []).filter((t) => !imageInfo.images.some((x) => x.message_id === t.message_id));
        const tasks = [];
        for (const target of missing) {
          const row = db.prepare("SELECT content_raw FROM messages WHERE id=?").get(Number(target.message_id));
          const md5 = imageMd5FromContent(row?.content_raw);
          const task = enqueueMediaFetchTask(db, {
            accountId: req.account_id, groupId: req.group_id, messageId: target.message_id,
            sourceMd5: md5, promptText: String(req.prompt_text || "").slice(0, 2000),
          });
          if (task) tasks.push(task);
        }
        const deadline = Date.now() + Number(chatCfg.media_fetch_timeout_ms ?? 60000);
        for (const task of tasks) {
          const remain = Math.max(1000, deadline - Date.now());
          const done = waitForMediaTask(db, task.task_id, remain);
          log(done?.status === "ready" ? "info" : "warn", "media fetch task settled", {
            task_id: task.task_id, message_id: task.message_id, status: done?.status, error: done?.error,
          });
        }
        imageInfo = resolveChatImages(db, req, {
          mediaRoot: path.resolve(ROOT, chatCfg.media_root || "data/media"),
          maxImages: Number(chatCfg.image_max_count ?? 2),
          recentLookbackSeconds: Number(chatCfg.recent_image_lookback_seconds ?? 600),
          cacheRoots: (chatCfg.wechat_media_cache_roots || []).map((p) => path.resolve(ROOT, p)),
        }) || imageInfo;
        imageData = imageInfo.images || [];
      }
      for (const failed of imageInfo.failures || []) {
        if (failed.message_id) recordMediaFailure(db, {
          messageId: failed.message_id, accountId: req.account_id, groupId: req.group_id,
          status: "failed", error: failed.error || "image unavailable",
        });
      }
      const hasUnresolvedImage = imageFeatureEnabled && (
        (imageInfo.failures?.length || 0) > 0
        || (imageInfo.targets?.length || 0) > (imageInfo.images?.length || 0)
        || (!(imageInfo.targets?.length) && [3, 47].includes(Number(sourceRow?.msg_type ?? 0) & 0xffff)));
      const searchCue = /(搜索|搜一下|查一下|查查|联网|上网|最新|近期|新闻|核实|查证|来源|网址|链接|search|latest|current|verify|look up)/i.test(String(req.prompt_text || ""));
      // Web tools are available to every chat so the model can verify a
      // person/event/date/term it does not know. The prompt decides whether an
      // actual search is warranted; ordinary greetings and opinions answer
      // directly. Per-request search/fetch budgets are still enforced before
      // the tool body runs.
      const imageSearchDefault = chatCfg.image_search_default !== false;
      const webSearchDefault = chatCfg.web_search_default !== false;
      const hasImageTarget = (imageInfo.targets?.length || 0) > 0;
      webSearchEnabled = Boolean(chatCfg.web_search_enabled)
        && (searchCue || webSearchDefault || (imageSearchDefault && hasImageTarget));
      const imageTargets = imageFeatureEnabled ? [
        ...imageInfo.images.map((x) => ({ message_id: x.message_id, role: x.role, sender_name: x.sender_name, ok: true })),
        ...imageInfo.failures.map((x) => ({ message_id: x.message_id, role: x.role, sender_name: x.sender_name, ok: false, error: x.error })),
      ] : [];
      const isAdmin = Array.isArray(cfg.admins) && cfg.admins.some((a) => a.sender_id === req.sender_id);
      const memoryCtx = { account_id: req.account_id, group_id: req.group_id, sender_id: req.sender_id, isAdmin };
      const memories = retrieveMemories(db, memoryCtx, {
        limit: Number(chatCfg.memory_retrieval_max_entries ?? 8),
        maxChars: Number(chatCfg.memory_retrieval_max_chars ?? 1800),
      });
      summaryFields.input_truncated = textTrunc.truncated || recent.truncated;
      summaryFields.input_truncated_count = (textTrunc.truncated ? 1 : 0) + recent.omittedCount;
      summaryFields.coverage_json = JSON.stringify({
        recent_context_count: recent.messages.length,
        recent_context_omitted: recent.omittedCount,
        recent_context_chars: recent.approxChars,
        lookback_minutes: Number(chatCfg.recent_context_lookback_minutes ?? 180),
        persona_version: chatCfg.persona?.version ?? null,
        session_id: sessionId,
        has_unresolved_image: hasUnresolvedImage,
        sender_role: isAdmin ? "admin" : "member",
        memory_count: memories.count,
        image_targets: imageInfo.targets.length,
        images_attached: imageInfo.images.length,
        image_failures: imageInfo.failures.length,
        media_fetch_tasks: imageInfo.targets.length ? db.prepare("SELECT COUNT(*) n FROM media_fetch_tasks WHERE message_id IN (" + imageInfo.targets.map(() => "?").join(",") + ")").get(...imageInfo.targets.map((x) => x.message_id))?.n ?? 0 : 0,
        web_search_enabled: webSearchEnabled,
      });
      prompt = buildChatPrompt({
        botName: cfg.bot_display_name || "ExampleBot", groupName, groupId,
        senderId: req.sender_id, senderDisplay: req.sender_display,
        senderContactName: req.sender_contact_name, senderGroupAlias: req.sender_group_alias,
        text: textTrunc.text, quote: quoteFrom(req.source_json),
        persona: chatCfg.persona,
        recentContext: recent,
        hasUnresolvedImage,
        senderRole: isAdmin ? "admin" : null,
        memories: memories.memories,
        messageId: req.source_message_id,
        imageTargets,
        webSearchEnabled,
      });
      maxTokens = Number(chatCfg.max_tokens ?? 2048);
      timeoutMs = Number(chatCfg.timeout_ms ?? 90000);
      displayCap = Number(chatCfg.display_chars ?? 500);
      reasoningEffort = chatCfg.reasoning_effort || "low";
      const round = reserveRound(db, cfg, "chat");
      if (!round.ok) { failRequest(db, req, cfg, round.reason, { round }); continue; }
      const budget = reserveBudget(db, "chat", cfg);
      if (!budget.ok) { if (!round.disabled) releaseRound(db, cfg, "chat"); failRequest(db, req, cfg, budget.reason, { budget }); continue; }
      db.prepare("UPDATE agent_requests SET budget_type='chat', budget_reserved_at=?, round_id=?, round_reserved_at=?, input_truncated=?, input_truncated_count=?, input_message_count=?, coverage_json=? WHERE request_id=?")
        .run(nowIso(), round.round_id ?? cfg.acceptance_round?.id ?? null, nowIso(),
          summaryFields.input_truncated ? 1 : 0, summaryFields.input_truncated_count,
          recent.messages.length, summaryFields.coverage_json, req.request_id);
    }

    db.prepare("UPDATE agent_requests SET session_id=?, generation_token_cap=? WHERE request_id=?")
      .run(sessionId, maxTokens, req.request_id);

    let result;
    try {
      result = await runSdkWithCapacity(WORKER_CHAT, {
        prompt, sessionId, resume, maxTokens, timeoutMs, reasoningEffort,
        images: type === "chat" ? imageData : [],
        patchPath: type === "chat" && webSearchEnabled
          ? path.resolve(ROOT, chatCfg.tool_patch || "deploy/harness/chat-web.patch.yml") : undefined,
        maxSteps: type === "chat" && webSearchEnabled ? Number(chatCfg.max_steps ?? 4) : 1,
      });
    } catch (e) {
      result = { status: "uncertain", error: String(e), prompt_accepted: false, cancel_state: "runner_exception" };
    }
    const duration = Date.now() - started;
    const promptAccepted = Boolean(result.prompt_accepted);
    const usage = result.usage ?? null;
    const steps = result.steps ?? null;
    const base = {
      session_id: sessionId, prompt_message_id: result.prompt_message_id ?? null,
      usage_json: usage ? JSON.stringify(usage) : null, usage,
      steps, max_tokens: maxTokens, reasoning_effort: reasoningEffort,
      finish_reason: result.finish_reason ?? null, duration_ms: duration,
      cancel_state: result.cancel_state ?? null,
      error: result.error ? String(result.error).slice(0, 2000) : null,
      evidence: JSON.stringify({
        sdk_status: result.status, prompt_accepted: promptAccepted,
        request_type: type, trigger_reason: req.trigger_reason,
        step_budget: Number(result.steps ?? 1), event_types: result.event_types ?? [],
      }).slice(0, 4000),
    };

    // Auxiliary tool requests are recorded separately from the final answer.
    const toolCalls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
    if (type === "chat" && toolCalls.length) {
      const nowTool = nowIso();
      for (const call of toolCalls) {
        let args = {};
        try { args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : (call.arguments || {}); } catch {}
        const query = Array.isArray(args.queries) ? args.queries.join(" | ") : (args.query ? String(args.query) : null);
        const url = args.url ? String(args.url) : null;
        db.prepare(`INSERT OR IGNORE INTO chat_tool_events
          (request_id,call_id,tool,query,url,args_json,status,created_at) VALUES(?,?,?,?,?,?,?,?)`)
          .run(req.request_id, String(call.id || crypto.randomUUID()), String(call.name || "unknown"),
            query ? query.slice(0, 1000) : null, url ? url.slice(0, 2000) : null,
            JSON.stringify(args).slice(0, 4000), "called", nowTool);
      }
      const cov = JSON.parse(summaryFields.coverage_json || "{}");
      cov.tool_calls = toolCalls.length;
      cov.web_search_calls = toolCalls.filter((x) => x.name === "web_search").length;
      cov.web_fetch_calls = toolCalls.filter((x) => x.name === "web_fetch").length;
      cov.auxiliary_search_requests = Number(result.auxiliary_requests ?? 0);
      summaryFields.coverage_json = JSON.stringify(cov);
      if (cov.web_search_calls > Number(chatCfg.max_search_calls ?? 1)
        || cov.web_fetch_calls > Number(chatCfg.max_fetch_calls ?? 2)) {
        enqueueFailureNotice(db, req, cfg, "failed", "这次回答未能完成，请稍后重新提问。", base,
          "tool call budget exceeded", { reason: "tool_call_budget" });
        log("warn", "chat tool call budget exceeded", { request_id: req.request_id, cov });
        continue;
      }
    }
    if (type === "chat" && promptAccepted) {
      storeSession(db, req.account_id || accountId, req.group_id || groupId, sessionId);
    }
    if (type === "chat" && result.status !== "succeeded" && promptAccepted) {
      retireSession(db, req.account_id || accountId, req.group_id || groupId, sessionId,
        result.status === "uncertain" ? "uncertain_outcome" : "failed_after_prompt");
    } else if (type === "chat" && !promptAccepted && resume && String(result.error || "").includes("session/resume failed")) {
      retireSession(db, req.account_id || accountId, req.group_id || groupId, sessionId, "session_resume_failed");
    }

    if (result.status === "succeeded") {
      let text = String(result.text ?? "").trim();
      let memoryActionCount = 0;
      if (type === "chat") {
        const envelope = parseChatEnvelope(text);
        if (envelope.structured) {
          if (envelope.malformed) {
            enqueueFailureNotice(db, req, cfg, "failed", "这次回答未能完成，请稍后重新提问。", base,
              `chat envelope: ${envelope.error}`, { reason: "chat_envelope_invalid" });
            log("warn", "chat structured envelope invalid; no reply", { request_id: req.request_id, error: envelope.error });
            continue;
          }
          text = envelope.reply;
          if (envelope.actions.length) {
            const memoryCtx = { account_id: req.account_id, group_id: req.group_id, sender_id: req.sender_id,
              isAdmin: Array.isArray(cfg.admins) && cfg.admins.some((a) => a.sender_id === req.sender_id),
              currentMessageId: req.source_message_id, text: req.prompt_text, quotePresent: Boolean(quoteFrom(req.source_json)) };
            const applied = applyMemoryActions(db, memoryCtx, envelope.actions);
            if (!applied.ok) {
              enqueueFailureNotice(db, req, cfg, "failed", "这次回答未能完成，请稍后重新提问。", base,
                `memory action rejected: ${applied.error}`, { reason: "memory_action_rejected" });
              log("warn", "memory action rejected; no reply", { request_id: req.request_id, error: applied.error });
              continue;
            }
            memoryActionCount = applied.changes.length;
            log("info", "memory actions committed", { request_id: req.request_id, changes: applied.changes });
          }
        }
      }
      if (type === "summary") {
        const validation = validateSummaryOutput(text, summaryInput.messages);
        if (!validation.ok) {
          enqueueFailureNotice(db, req, cfg, "failed", "这次总结未能完成，请稍后重新尝试。", base,
            `summary_validation: ${validation.error}`, { reason: "summary_invalid", validation_status: "invalid", summary_json: text.slice(0, 12000) });
          log("warn", "summary validation failed; failure notice queued", { request_id: req.request_id, error: validation.error });
          continue;
        }
        const rendered = renderSummary(validation.value, summaryInput, {
          startMs: Number(req.range_start), endMs: Number(req.range_end),
          displayChars: displayCap, coverageNote: coverage?.note || "",
          programLimitations: [
            `输入 ${summaryInput.selectedCount} 条，原始范围内 ${summaryInput.selectedCount + summaryInput.omittedCount} 条`,
          ],
        });
        summaryFields = {
          input_message_count: summaryInput.selectedCount,
          input_truncated: summaryInput.truncated,
          input_truncated_count: summaryInput.omittedCount,
          coverage_json: JSON.stringify(coverage),
          summary_json: text,
          validation_status: "valid",
        };
        text = rendered.text;
      }
      if (!text) {
        if (type === "chat") retireSession(db, req.account_id || accountId, req.group_id || groupId, sessionId, "empty_model_reply");
        enqueueFailureNotice(db, req, cfg, "failed",
          type === "summary" ? "这次总结未能完成，请稍后重新尝试。" : "这次回答未能完成，请稍后重新提问。",
          base, "empty model reply", { reason: "empty_reply", finish_reason: base.finish_reason });
        log("warn", "agent request failed: empty reply; failure notice queued", { request_id: req.request_id, type });
        continue;
      }
      if (type === "chat" && base.finish_reason === "max-tokens") {
        text += "\n\n（回答未完整结束，请补充说明）";
        summaryFields.validation_status = "truncated";
      }
      if (type === "chat") summaryFields.memory_action_count = memoryActionCount;
      enqueueSuccess(db, req, cfg, sessionId, base, text, displayCap, summaryFields);
    } else {
      const status = result.status === "failed" ? "failed" : "uncertain";
      enqueueFailureNotice(db, req, cfg, status,
        type === "summary" ? "这次总结未能完成，请稍后重新尝试。" : "这次回答未能完成，请稍后重新提问。",
        base, base.error || "model request did not complete",
        { reason: "model_end", finish_reason: base.finish_reason });
      log(status === "failed" ? "warn" : "error", "agent request ended with failure notice", {
        request_id: req.request_id, type, status, error: base.error,
        prompt_accepted: promptAccepted, duration_ms: duration,
      });
    }
  }
  db.close();
  log("info", "agent worker stopped");
}

main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
