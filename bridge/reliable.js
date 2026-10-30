#!/usr/bin/env node
/**
 * Reliability bridge for phase 1.5.
 *
 * - Ingestion is done by the separate Rust `wechat-ingest` process, which
 *   commits DB messages + cursors atomically into reliability.db.
 * - This process only consumes that SQLite queue and runs one outbox worker.
 * - CLI `send` only inserts a queued row; it never POSTs to WeChat.
 * - No model call is made in this file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { classifyIncoming, summaryRangeFor } from "./request-routing.js";
import { acquireUiLock, releaseUiLock } from "./ui-lock.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONFIG_PATH = process.env.BOT_CONFIG_PATH || path.join(ROOT, "data", "bridge", "config.json");
const DEFAULT_DB = path.join(ROOT, "data", "reliability", "reliability.db");
const LOG_PATH = path.join(ROOT, "data", "reliability", "bridge.log");
const contactCache = new Map();
let contactsAt = 0;

const DEFAULTS = {
  api_base: "http://127.0.0.1:8899",
  token_file: "data/mimicwx/api-token",
  reliability_db: "data/reliability/reliability.db",
  group_id: "",
  group_name: "",
  poll_interval_ms: 500,
  send_timeout_ms: 30000,
  account_id: "wxid_example",
  bot_display_name: "ExampleBot",
  auto_reply_cap: 5,
};

function nowIso() { return new Date().toISOString(); }

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

async function loadConfig() {
  const cfg = { ...DEFAULTS, ...(await readJson(CONFIG_PATH, {})) };
  cfg._tokenPath = path.isAbsolute(cfg.token_file) ? cfg.token_file : path.join(ROOT, cfg.token_file);
  cfg._dbPath = path.isAbsolute(cfg.reliability_db) ? cfg.reliability_db : path.join(ROOT, cfg.reliability_db);
  return cfg;
}

async function loadToken(cfg) {
  return (await fs.readFile(cfg._tokenPath, "utf8")).trim();
}

function log(cfg, level, msg, extra = {}) {
  const line = JSON.stringify({ ts: nowIso(), level, msg, ...extra });
  console.log(line);
  fs.appendFile(LOG_PATH, line + "\n", { mode: 0o600 }).catch(() => {});
}

async function api(cfg, token, method, endpoint, body, timeoutMs = 20000) {
  const url = new URL(endpoint, cfg.api_base.endsWith("/") ? cfg.api_base : cfg.api_base + "/");
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} ${endpoint}: ${text.slice(0, 500)}`);
    e.status = res.status; e.body = parsed; throw e;
  }
  return parsed;
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      account_id TEXT, group_id TEXT, group_display TEXT,
      sender_id TEXT, sender_display TEXT,
      sender_contact_name TEXT, sender_group_alias TEXT, sender_alias_source TEXT,
      local_id TEXT, server_id TEXT,
      id_precision TEXT NOT NULL DEFAULT 'exact',
      create_time INTEGER, msg_type INTEGER, is_self INTEGER NOT NULL DEFAULT 0,
      content_text TEXT, content_raw TEXT,
      quote_status TEXT NOT NULL DEFAULT 'not_provided', quote_json TEXT,
      quoted_contact_name TEXT, quoted_group_alias TEXT, quoted_alias_source TEXT,
      raw_json TEXT NOT NULL, ingested_at TEXT NOT NULL, processed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS outbox (
      request_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, group_name TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT, confirmed_at TEXT,
      last_error TEXT, response_json TEXT, evidence TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
    CREATE TABLE IF NOT EXISTS agent_requests (
      request_id TEXT PRIMARY KEY,
      source_message_id INTEGER NOT NULL UNIQUE,
      source_local_id TEXT, source_account_id TEXT, source_group_id TEXT,
      account_id TEXT NOT NULL, group_id TEXT NOT NULL,
      sender_id TEXT, sender_display TEXT,
      sender_contact_name TEXT, sender_group_alias TEXT,
      request_type TEXT NOT NULL DEFAULT 'chat',
      trigger_reason TEXT,
      range_start INTEGER, range_end INTEGER, summary_target_date TEXT,
      snapshot_max_message_id INTEGER, snapshot_at TEXT,
      input_message_count INTEGER, input_truncated INTEGER DEFAULT 0,
      input_truncated_count INTEGER, coverage_json TEXT,
      budget_type TEXT, budget_reserved_at TEXT,
      round_id TEXT, round_reserved_at TEXT,
      summary_json TEXT, validation_status TEXT,
      prompt_text TEXT NOT NULL,
      source_json TEXT,
      status TEXT NOT NULL,
      queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      session_id TEXT, prompt_message_id TEXT,
      reply_text TEXT, display_chars INTEGER, generation_token_cap INTEGER,
      steps INTEGER, usage_json TEXT,
      error TEXT, cancel_state TEXT, duration_ms INTEGER,
      reply_request_id TEXT,
      evidence TEXT
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
  `);
  // Forward-compatible columns on the existing outbox.
  const cols = db.prepare("PRAGMA table_info(outbox)").all().map((r) => r.name);
  if (!cols.includes("agent_request_id")) db.exec("ALTER TABLE outbox ADD COLUMN agent_request_id TEXT");
  if (!cols.includes("source_message_id")) db.exec("ALTER TABLE outbox ADD COLUMN source_message_id INTEGER");
  const sessCols = db.prepare("PRAGMA table_info(agent_sessions)").all().map((r) => r.name);
  if (!sessCols.includes("state")) db.exec("ALTER TABLE agent_sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
  if (!sessCols.includes("retired_at")) db.exec("ALTER TABLE agent_sessions ADD COLUMN retired_at TEXT");
  if (!sessCols.includes("retired_reason")) db.exec("ALTER TABLE agent_sessions ADD COLUMN retired_reason TEXT");
  const reqCols = db.prepare("PRAGMA table_info(agent_requests)").all().map((r) => r.name);
  if (!reqCols.includes("source_local_id")) db.exec("ALTER TABLE agent_requests ADD COLUMN source_local_id TEXT");
  if (!reqCols.includes("source_account_id")) db.exec("ALTER TABLE agent_requests ADD COLUMN source_account_id TEXT");
  if (!reqCols.includes("source_group_id")) db.exec("ALTER TABLE agent_requests ADD COLUMN source_group_id TEXT");
  if (!reqCols.includes("sender_contact_name")) db.exec("ALTER TABLE agent_requests ADD COLUMN sender_contact_name TEXT");
  if (!reqCols.includes("sender_group_alias")) db.exec("ALTER TABLE agent_requests ADD COLUMN sender_group_alias TEXT");
  for (const [col, typ] of [
    ["request_type","TEXT NOT NULL DEFAULT 'chat'"], ["trigger_reason","TEXT"],
    ["range_start","INTEGER"], ["range_end","INTEGER"], ["summary_target_date","TEXT"],
    ["snapshot_max_message_id","INTEGER"], ["snapshot_at","TEXT"],
    ["input_message_count","INTEGER"], ["input_truncated","INTEGER DEFAULT 0"],
    ["input_truncated_count","INTEGER"], ["coverage_json","TEXT"],
    ["budget_type","TEXT"], ["budget_reserved_at","TEXT"],
    ["summary_json","TEXT"], ["validation_status","TEXT"],
  ]) {
    if (!reqCols.includes(col)) db.exec(`ALTER TABLE agent_requests ADD COLUMN ${col} ${typ}`);
  }
  const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((r) => r.name);
  for (const [col, typ] of [["sender_contact_name","TEXT"],["sender_group_alias","TEXT"],["sender_alias_source","TEXT"],["quoted_contact_name","TEXT"],["quoted_group_alias","TEXT"],["quoted_alias_source","TEXT"]]) {
    if (!msgCols.includes(col)) db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${typ}`);
  }
  // Backfill only from the reliability row id; never treat local_id as global.
  db.exec(`UPDATE agent_requests SET
    source_local_id=COALESCE(source_local_id,(SELECT local_id FROM messages WHERE messages.id=agent_requests.source_message_id)),
    source_account_id=COALESCE(source_account_id,(SELECT account_id FROM messages WHERE messages.id=agent_requests.source_message_id)),
    source_group_id=COALESCE(source_group_id,(SELECT group_id FROM messages WHERE messages.id=agent_requests.source_message_id))
    WHERE source_local_id IS NULL OR source_account_id IS NULL OR source_group_id IS NULL`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_source_scope ON agent_requests(source_account_id,source_group_id,source_local_id)");
}

function bumpMeta(db, key, delta) {
  db.prepare(`
    INSERT INTO meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+? AS TEXT)
  `).run(key, String(delta), delta);
}

function recoverSending(db, cfg) {
  const now = nowIso();
  const rows = db.prepare("SELECT request_id FROM outbox WHERE status='sending'").all();
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    UPDATE outbox SET status='uncertain', updated_at=?, last_error=?,
      evidence='process restarted while sending; not retried automatically'
    WHERE request_id=? AND status='sending'
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) stmt.run(now, "restart during sending", r.request_id);
    db.exec("COMMIT");
    bumpMeta(db, "outbox_uncertain", rows.length);
    log(cfg, "warn", "recovered sending rows as uncertain", { count: rows.length });
  } catch (e) {
    db.exec("ROLLBACK"); throw e;
  }
}

function resolveQuotes(db) {
  const rows = db.prepare(`
    SELECT id, quote_status, quote_json FROM messages
    WHERE quote_status IN ('present','unresolved')
      AND quote_json LIKE '%quoted_server_id%'
  `).all();
  const find = db.prepare("SELECT local_id FROM messages WHERE server_id=? LIMIT 1");
  for (const r of rows) {
    let q;
    try { q = JSON.parse(r.quote_json); } catch { continue; }
    const quoted = q?.quoted_server_id;
    if (!quoted) {
      q.resolution = "unresolved_no_quoted_id";
      db.prepare("UPDATE messages SET quote_status='unresolved', quote_json=? WHERE id=?").run(JSON.stringify(q), r.id);
      continue;
    }
    const original = find.get(quoted);
    if (original) {
      q.resolution = "resolved";
      q.quoted_local_id = original.local_id;
      db.prepare("UPDATE messages SET quote_status='present', quote_json=? WHERE id=?").run(JSON.stringify(q), r.id);
    } else {
      q.resolution = "unresolved_original_not_found";
      db.prepare("UPDATE messages SET quote_status='unresolved', quote_json=? WHERE id=?").run(JSON.stringify(q), r.id);
    }
  }
}

async function refreshContacts(cfg, token) {
  try {
    const data = await api(cfg, token, "GET", "/contacts", null, 15000);
    const list = Array.isArray(data?.contacts) ? data.contacts : [];
    contactCache.clear();
    for (const c of list) {
      if (c?.username) contactCache.set(c.username, {
        contact_name: c.nick_name || null,
        display_name: c.display_name || null,
        remark: c.remark || null,
      });
    }
    contactsAt = Date.now();
    log(cfg, "info", "contacts refreshed", { count: contactCache.size });
  } catch (e) {
    log(cfg, "warn", "contacts refresh failed", { error: String(e).slice(0, 300) });
  }
}

function mentionedAccountIds(raw) {
  const src = raw?.msg_source || "";
  const out = [];
  const re = /<atuserlist>([\s\S]*?)<\/atuserlist>/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    for (const id of body.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

function stripMentionText(text, displayName) {
  if (typeof text !== "string") return "";
  let out = text.replace(/^\s*@[^\s\u2005]+[\s\u2005]+/u, "");
  if (displayName && out.startsWith(`@${displayName}`)) {
    out = out.slice(displayName.length + 1).replace(/^[\s\u2005]+/u, "");
  }
  return out.trim();
}

function decodeXmlText(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function promptTextFor(m, displayName) {
  let text = m.content_text || "";
  if (/^\s*<\?xml|^\s*<msg[\s>]/i.test(text)) {
    const title = text.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    if (title) text = decodeXmlText(title);
  }
  return stripMentionText(text, displayName);
}

function agentReplyCount(db) {
  return db.prepare("SELECT count(*) n FROM outbox WHERE agent_request_id IS NOT NULL").get().n;
}

function processMessages(db, cfg) {
  const rows = db.prepare(`
    SELECT id, dedupe_key, account_id, group_id, group_display, sender_id, sender_display,
           local_id, server_id, id_precision, create_time, msg_type, is_self, content_text,
           content_raw, quote_status, quote_json, raw_json
    FROM messages WHERE processed_at IS NULL ORDER BY id ASC LIMIT 100
  `).all();
  if (rows.length === 0) return 0;
  const now = nowIso();
  const mark = db.prepare("UPDATE messages SET processed_at=? WHERE id=? AND processed_at IS NULL");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const m of rows) {
      let raw = {};
      try { raw = JSON.parse(m.raw_json); } catch {}
      const contact = contactCache.get(m.sender_id);
      const senderContactName = contact?.contact_name || null;
      // WCDB contact.db has chatroom_member(room_id, member_id) only; no
      // group-alias column exists in this schema. Never invent one by copying
      // the contact name; keep the historical display separately.
      const senderGroupAlias = null;
      const senderAliasSource = "sender_display is historical; contact name from contact.nick_name; group alias unavailable in WCDB schema";
      let quoteObj = null;
      if (m.quote_json) { try { quoteObj = JSON.parse(m.quote_json); } catch {} }
      let quotedContactName = null;
      if (quoteObj?.quoted_sender_id) {
        quotedContactName = contactCache.get(quoteObj.quoted_sender_id)?.contact_name || null;
      }
      if (quoteObj) {
        quoteObj.quoted_contact_name = quotedContactName;
        quoteObj.quoted_group_alias = null;
        quoteObj.quoted_alias_source = "quoted_display_name is historical; group alias unavailable in WCDB schema";
        db.prepare("UPDATE messages SET quote_json=? WHERE id=?").run(JSON.stringify(quoteObj), m.id);
      }
      db.prepare(`UPDATE messages SET sender_contact_name=?, sender_group_alias=?,
        sender_alias_source=?, quoted_contact_name=?, quoted_group_alias=?,
        quoted_alias_source=? WHERE id=?`).run(
          senderContactName, senderGroupAlias, senderAliasSource,
          quotedContactName, null, quoteObj ? quoteObj.quoted_alias_source : null, m.id);
      const sourceContext = JSON.stringify({ ...raw, quote: quoteObj ?? raw.quote ?? null });
      const mentioned = mentionedAccountIds(raw);
      const isTarget = m.group_id === cfg.group_id;
      const isSelf = Boolean(m.is_self) || m.sender_id === cfg.account_id;
      const routed = classifyIncoming({
        text: promptTextFor(m, cfg.bot_display_name || "容易"),
        msgType: m.msg_type, mentionedIds: mentioned,
        accountId: cfg.account_id, isSelf, isTarget,
      });
      if (routed) {
        const id = crypto.randomUUID();
        const nowQueued = nowIso();
        const cap = cfg.auto_reply_cap ?? 5;
        const used = agentReplyCount(db);
        const prompt = promptTextFor(m, cfg.bot_display_name || "容易");
        let rangeStart = null, rangeEnd = null, snapshotMax = null, snapshotAt = null;
        if (routed.request_type === "summary") {
          const commandMs = Number(m.create_time) > 0 ? Number(m.create_time) * 1000 : Date.now();
          const range = summaryRangeFor(commandMs, Date.now(), routed.summary_date || null);
          rangeStart = range.startMs; rangeEnd = range.endMs;
          snapshotAt = nowQueued;
          snapshotMax = db.prepare("SELECT COALESCE(MAX(id),0) n FROM messages").get().n;
        }
        const evidence = `routing=${routed.request_type}; trigger=${routed.trigger_reason}; mention_ids=${JSON.stringify(mentioned)}`;
        const capEnforced = cfg.limits?.enforce_auto_reply_cap !== false;
        if (capEnforced && used >= cap) {
          const r = db.prepare(`INSERT OR IGNORE INTO agent_requests
            (request_id,source_message_id,source_local_id,source_account_id,source_group_id,account_id,group_id,sender_id,sender_display,sender_contact_name,sender_group_alias,request_type,trigger_reason,range_start,range_end,summary_target_date,snapshot_max_message_id,snapshot_at,prompt_text,source_json,status,queued_at,finished_at,error,evidence)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              id, m.id, m.local_id, m.account_id || "", m.group_id, m.account_id || "", m.group_id, m.sender_id, m.sender_display,
              senderContactName, senderGroupAlias, routed.request_type, routed.trigger_reason, rangeStart, rangeEnd,
              routed.summary_date || null, snapshotMax, snapshotAt, prompt, sourceContext, "failed", nowQueued, nowQueued,
              "global auto-reply cap reached", `cap=${cap}, used=${used}; no model call; ${evidence}`);
          log(cfg, "warn", "agent request rejected by reply cap", { source_message_id: m.id, request_type: routed.request_type, used, cap, inserted: r.changes });
        } else {
          const r = db.prepare(`INSERT OR IGNORE INTO agent_requests
            (request_id,source_message_id,source_local_id,source_account_id,source_group_id,account_id,group_id,sender_id,sender_display,sender_contact_name,sender_group_alias,request_type,trigger_reason,range_start,range_end,summary_target_date,snapshot_max_message_id,snapshot_at,prompt_text,source_json,status,queued_at,evidence)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              id, m.id, m.local_id, m.account_id || "", m.group_id, m.account_id || "", m.group_id, m.sender_id, m.sender_display,
              senderContactName, senderGroupAlias, routed.request_type, routed.trigger_reason, rangeStart, rangeEnd,
              routed.summary_date || null, snapshotMax, snapshotAt, prompt, sourceContext, "queued", nowQueued,
              `mention metadata/routing; ${evidence}`);
          if (r.changes) {
            log(cfg, "info", "agent request queued", {
              request_id: id, source_message_id: m.id, request_type: routed.request_type,
              trigger_reason: routed.trigger_reason, mention_ids: mentioned, prompt,
              range_start: rangeStart, range_end: rangeEnd, snapshot_max_message_id: snapshotMax,
            });
          }
        }
      } else if (!isSelf && isTarget && (m.content_text || "").includes("@")) {
        log(cfg, "debug", "text contains @ but no mention metadata hit", {
          source_message_id: m.id, mentioned, content: m.content_text,
        });
      }
      if (!isSelf) {
        log(cfg, "info", "message observed", {
          dedupe_key: m.dedupe_key, account_id: m.account_id,
          group_id: m.group_id, group_name: m.group_display,
          sender_id: m.sender_id, sender_name: m.sender_display,
          local_id: m.local_id, server_id: m.server_id,
          id_precision: m.id_precision, create_time: m.create_time,
          msg_type: m.msg_type, text: m.content_text,
          quote_status: m.quote_status,
        });
      }
      mark.run(now, m.id);
    }
    bumpMeta(db, "messages_processed", rows.length);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK"); throw e;
  }
  return rows.length;
}

function claimOutbox(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT * FROM outbox WHERE status='queued' ORDER BY created_at ASC LIMIT 1
    `).get();
    if (!row) { db.exec("COMMIT"); return null; }
    const now = nowIso();
    const n = db.prepare(`
      UPDATE outbox SET status='sending', attempts=attempts+1, updated_at=?,
        last_error=NULL
      WHERE request_id=? AND status='queued'
    `).run(now, row.request_id).changes;
    if (n !== 1) { db.exec("ROLLBACK"); return null; }
    db.exec("COMMIT");
    return row;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

function finishOutbox(db, cfg, item, status, patch = {}) {
  const now = nowIso();
  db.prepare(`
    UPDATE outbox SET status=?, updated_at=?, sent_at=COALESCE(?,sent_at),
      confirmed_at=COALESCE(?,confirmed_at), last_error=?, response_json=?, evidence=?
    WHERE request_id=? AND status='sending'
  `).run(
    status, now, patch.sent_at ?? null, patch.confirmed_at ?? null,
    patch.last_error ?? null, patch.response_json ?? null, patch.evidence ?? null,
    item.request_id
  );
}

async function runOutboxOnce(db, cfg, token) {
  const item = claimOutbox(db);
  if (!item) return false;
  // Target is fixed by config; never use an event/model-provided group.
  if (item.group_id !== cfg.group_id || item.group_name !== cfg.group_name) {
    finishOutbox(db, cfg, item, "failed", {
      last_error: "queued target does not match pinned config",
      evidence: "target mismatch; no API call",
    });
    bumpMeta(db, "outbox_failed", 1);
    log(cfg, "error", "outbox target mismatch", { request_id: item.request_id });
    return true;
  }
  let resp;
  let uiToken = null;
  try {
    uiToken = acquireUiLock(db, "outbox-send", Number(cfg.send_timeout_ms ?? 30000));
    resp = await api(cfg, token, "POST", "/send",
      { to: cfg.group_name, text: item.text }, cfg.send_timeout_ms);
  } catch (e) {
    // Timeout/connection error: the request may have reached WeChat.
    // Do not automatically resend; mark uncertain and require manual retry.
    finishOutbox(db, cfg, item, "uncertain", {
      last_error: String(e?.stack || e).slice(0, 1000),
      evidence: e?.status ? `HTTP ${e.status}; outcome uncertain` : "network/timeout; outcome uncertain",
    });
    bumpMeta(db, "outbox_uncertain", 1);
    log(cfg, "warn", "outbox uncertain (not retried)", { request_id: item.request_id, error: String(e).slice(0, 300) });
    return true;
  } finally {
    if (uiToken) releaseUiLock(db, uiToken);
  }
  const response_json = JSON.stringify(resp);
  if (resp?.sent === true) {
    const verified = resp?.verified === true;
    const status = verified ? "confirmed" : "uncertain";
    finishOutbox(db, cfg, item, status, {
      sent_at: nowIso(),
      confirmed_at: verified ? nowIso() : null,
      response_json,
      evidence: verified ? "API sent=true verified=true" : "API sent=true verified=false; not independently confirmed",
      last_error: verified ? null : "API accepted send but verification was false",
    });
    bumpMeta(db, status === "confirmed" ? "outbox_confirmed" : "outbox_uncertain", 1);
    log(cfg, "info", "outbox finished", { request_id: item.request_id, status, verified });
  } else {
    finishOutbox(db, cfg, item, "failed", {
      response_json,
      evidence: `API sent=${JSON.stringify(resp?.sent)}`,
      last_error: `API returned sent=${JSON.stringify(resp?.sent)}`,
    });
    bumpMeta(db, "outbox_failed", 1);
    log(cfg, "warn", "outbox failed", { request_id: item.request_id, response: resp });
  }
  return true;
}

async function cmdRun(cfg) {
  const token = await loadToken(cfg);
  await refreshContacts(cfg, token);
  await fs.mkdir(path.dirname(cfg._dbPath), { recursive: true });
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  const db = new DatabaseSync(cfg._dbPath);
  ensureSchema(db);
  recoverSending(db, cfg);
  resolveQuotes(db);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log(cfg, "info", "reliable bridge starting", {
    db: cfg._dbPath, group_id: cfg.group_id || null, group_name: cfg.group_name || null,
  });
  while (!stopping) {
    try {
      if (Date.now() - contactsAt > 60000) await refreshContacts(cfg, token);
      resolveQuotes(db);
      const n = processMessages(db, cfg);
      if (n > 0) log(cfg, "info", "messages processed", { count: n });
      await runOutboxOnce(db, cfg, token);
    } catch (e) {
      log(cfg, "error", "bridge cycle failed", { error: String(e?.stack || e) });
    }
    await new Promise((r) => setTimeout(r, cfg.poll_interval_ms));
  }
  db.close();
  log(cfg, "info", "reliable bridge stopped");
}

function openDb(cfg) {
  const db = new DatabaseSync(cfg._dbPath);
  ensureSchema(db);
  return db;
}

async function cmdSend(cfg, text) {
  if (!text) throw new Error("usage: reliable.js send <text>");
  if (!cfg.group_id || !cfg.group_name) throw new Error("target is not pinned in data/bridge/config.json");
  await fs.mkdir(path.dirname(cfg._dbPath), { recursive: true });
  const db = openDb(cfg);
  const requestId = crypto.randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO outbox(request_id,group_id,group_name,text,status,attempts,created_at,updated_at,evidence)
    VALUES(?,?,?,?,'queued',0,?,?,?)
  `).run(requestId, cfg.group_id, cfg.group_name, text, now, now, "queued by CLI; single bridge worker executes");
  db.close();
  console.log(JSON.stringify({ request_id: requestId, status: "queued", group_id: cfg.group_id, text }, null, 2));
}

async function cmdStatus(cfg) {
  const db = openDb(cfg);
  const counts = {};
  for (const r of db.prepare("SELECT status,count(*) n FROM outbox GROUP BY status").all()) counts[r.status] = r.n;
  const stats = {};
  for (const r of db.prepare("SELECT key,value FROM meta").all()) stats[r.key] = r.value;
  const pending = db.prepare("SELECT count(*) n FROM messages WHERE processed_at IS NULL").get().n;
  const total = db.prepare("SELECT count(*) n FROM messages").get().n;
  const last = db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 5").all();
  const agentRequests = db.prepare("SELECT status,count(*) n FROM agent_requests GROUP BY status").all();
  const autoRepliesUsed = db.prepare("SELECT count(*) n FROM outbox WHERE agent_request_id IS NOT NULL").get().n;
  const modelBudget = db.prepare("SELECT type,used,limit_value FROM model_budget ORDER BY type").all();
  const acceptanceRound = db.prepare("SELECT * FROM acceptance_round ORDER BY started_at DESC LIMIT 1").all();
  db.close();
  console.log(JSON.stringify({
    config: { db: cfg._dbPath, group_id: cfg.group_id, group_name: cfg.group_name },
    outbox: counts, meta: stats, messages_total: total, messages_pending: pending, last_messages: last,
    agent_requests: agentRequests,
    auto_reply_cap: cfg.auto_reply_cap,
    limits: cfg.limits || null,
    auto_replies_used: autoRepliesUsed,
    model_budget: modelBudget,
    acceptance_round: acceptanceRound,
  }, null, 2));
}

async function cmdMessages(cfg) {
  const db = openDb(cfg);
  const rows = db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 50").all();
  db.close();
  console.log(JSON.stringify(rows, null, 2));
}

async function cmdRetry(cfg, requestId) {
  const db = openDb(cfg);
  const n = db.prepare(`
    UPDATE outbox SET status='queued', attempts=0, last_error=NULL, updated_at=?,
      evidence='manual explicit retry'
    WHERE request_id=? AND status IN ('failed','uncertain')
  `).run(nowIso(), requestId).changes;
  db.close();
  if (n !== 1) throw new Error("request not found or not in failed/uncertain state");
  console.log(JSON.stringify({ request_id: requestId, status: "queued", note: "explicit manual retry" }, null, 2));
}

async function cmdSetTarget(cfg, groupId, groupName) {
  if (!groupId || !groupName) throw new Error("usage: reliable.js set-target <group_id> <group_name>");
  if (!groupId.includes("@chatroom")) throw new Error("group_id must contain @chatroom");
  const disk = await readJson(CONFIG_PATH, {});
  disk.group_id = groupId; disk.group_name = groupName;
  await fs.writeFile(CONFIG_PATH, JSON.stringify({ ...DEFAULTS, ...disk }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ group_id: groupId, group_name: groupName }, null, 2));
}

async function cmdGroups(cfg) {
  const token = await loadToken(cfg);
  const sessions = await api(cfg, token, "GET", "/sessions");
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    const id = s.username ?? s.chat ?? s.id;
    if (typeof id === "string" && id.includes("@chatroom")) {
      console.log(JSON.stringify({ group_id: id, group_name: s.display_name ?? s.chat_display ?? null }));
    }
  }
}

async function main() {
  const cfg = await loadConfig();
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "run": return cmdRun(cfg);
    case "send": return cmdSend(cfg, args.join(" "));
    case "status": return cmdStatus(cfg);
    case "messages": return cmdMessages(cfg);
    case "retry": return cmdRetry(cfg, args[0]);
    case "set-target": return cmdSetTarget(cfg, args[0], args.slice(1).join(" "));
    case "groups": return cmdGroups(cfg);
    default:
      console.error("usage: reliable.js run|status|messages|send <text>|retry <request_id>|set-target <group_id> <group_name>|groups");
      process.exit(2);
  }
}

main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
