#!/usr/bin/env node
/**
 * Phase-1 WeChat group bridge for MimicWX-Linux.
 *
 * Design constraints for this phase:
 *   - Read-only message ingestion from MimicWX's /messages/new.
 *   - Never infer a sender, message id or quote that the channel did not give.
 *   - Reply target is pinned in config: group_id + exact group_name.
 *   - Persistent dedupe + outbox, so restarting this process does not replay
 *     old messages or lose queued sends.
 *
 * This is deliberately not a chatbot yet. It records raw events and provides
 * a manual send command; the Harness adapter is phase 2.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "data", "bridge");
const CONFIG_PATH = path.join(DATA, "config.json");
const STATE_PATH = path.join(DATA, "state.json");
const EVENTS_PATH = path.join(DATA, "events.jsonl");
const TARGET_EVENTS_PATH = path.join(DATA, "target-events.jsonl");
const LOG_PATH = path.join(DATA, "bridge.log");

const DEFAULTS = {
  api_base: "http://127.0.0.1:18899",
  token_file: "data/mimicwx/api-token",
  group_id: "",
  group_name: "",
  poll_interval_ms: 1000,
  outbox_max_attempts: 5,
  state_keep: 20000,
};

function nowIso() {
  return new Date().toISOString();
}

async function ensureDirs() {
  await fs.mkdir(DATA, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function loadConfig() {
  const cfg = { ...DEFAULTS, ...(await readJson(CONFIG_PATH, {})) };
  cfg._root = ROOT;
  cfg._tokenPath = path.isAbsolute(cfg.token_file)
    ? cfg.token_file
    : path.join(ROOT, cfg.token_file);
  return cfg;
}

async function loadToken(cfg) {
  const t = (await fs.readFile(cfg._tokenPath, "utf8")).trim();
  if (!t) throw new Error(`empty token file: ${cfg._tokenPath}`);
  return t;
}

function log(cfg, level, msg, extra = {}) {
  const line = JSON.stringify({ ts: nowIso(), level, msg, ...extra });
  console.log(line);
  // Best-effort; never let logging break message handling.
  fs.appendFile(LOG_PATH, line + "\n", { mode: 0o600 }).catch(() => {});
}

async function api(cfg, token, method, endpoint, body) {
  const url = new URL(endpoint, cfg.api_base.endsWith("/") ? cfg.api_base : cfg.api_base + "/");
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${endpoint}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

function isGroupChat(chat) {
  return typeof chat === "string" && chat.includes("@chatroom");
}

function looksLikeWxid(value) {
  if (typeof value !== "string" || !value) return false;
  // Ordinary wxid, enterprise id, or an explicit group id. This is only a
  // sanity check; we never synthesize an id when the channel omits one.
  return /^wxid_[A-Za-z0-9_-]+$/.test(value) ||
    /^[A-Za-z0-9_-]{6,}@chatroom$/.test(value) ||
    /^[A-Za-z0-9_-]{4,}$/.test(value) && !/^\d+$/.test(value);
}

function extractQuoteStatus(content) {
  if (typeof content !== "string" || !content.includes("<refermsg")) {
    return {
      status: "not_provided",
      raw: null,
      note: "event content contains no <refermsg> block",
    };
  }
  // We do not parse or infer the quoted sender/text in phase 1. Preserve the
  // raw XML fragment only; phase 2 can add a verified parser.
  return {
    status: "present_unparsed",
    raw: content,
    note: "channel provided <refermsg>, parser not implemented in phase 1",
  };
}

function normalizeEvent(raw) {
  const chat = raw?.chat ?? null;
  const talker = raw?.talker ?? null;
  const talkerDisplay = raw?.talker_display ?? raw?.talker_display_name ?? null;
  const serverIdNumber = Number.isFinite(raw?.server_id) ? raw.server_id : null;
  const serverIdExact = typeof raw?.server_id_exact === "string" && raw.server_id_exact !== "0"
    ? raw.server_id_exact
    : (Number.isSafeInteger(serverIdNumber) && serverIdNumber !== 0
        ? String(serverIdNumber)
        : null);
  const serverIdUnsafe = serverIdNumber !== null && !Number.isSafeInteger(serverIdNumber)
    ? serverIdNumber
    : null;
  const localId = Number.isFinite(raw?.local_id) ? raw.local_id : null;
  const senderLooksValid = looksLikeWxid(talker);
  const quote = extractQuoteStatus(raw?.content);

  return {
    schema: 1,
    received_at: nowIso(),
    source: "mimicwx:/ws db_message",
    raw_event: raw,
    chat: {
      id: chat,
      display_name: raw?.chat_display_name ?? raw?.chat_display ?? null,
      is_group: isGroupChat(chat),
    },
    sender: {
      id: senderLooksValid ? talker : null,
      channel_talker: talker,
      display_name: talkerDisplay,
      resolution: senderLooksValid ? "channel_talker" : "missing_or_unresolved",
      note: senderLooksValid
        ? "sender id comes from channel field talker"
        : "channel talker was empty or not a plausible wxid; NOT inferred",
    },
    ids: {
      channel_local_id: localId,
      channel_server_id: serverIdExact,
      // Never serialize a >2^53 i64 as a JS number and call it exact.
      channel_server_id_unsafe_number: serverIdUnsafe,
      channel_message_id: serverIdExact,
    },
    time: {
      channel_create_time: Number.isFinite(raw?.create_time) ? raw.create_time : null,
      channel_create_time_iso: Number.isFinite(raw?.create_time)
        ? new Date(raw.create_time * 1000).toISOString()
        : null,
    },
    content: {
      raw: raw?.content ?? null,
      parsed: raw?.parsed ?? null,
      msg_type: raw?.msg_type ?? null,
      is_self: Boolean(raw?.is_self),
    },
    quote,
    dedupe_key: null,
  };
}

function dedupeKey(ev) {
  const ids = ev.ids;
  if (ids.channel_server_id !== null) {
    return `server:${ev.chat.id}:${ids.channel_server_id}`;
  }
  if (ids.channel_local_id !== null) {
    return `local:${ev.chat.id}:${ids.channel_local_id}`;
  }
  // Last-resort stable hash of the raw event. This is only for dedupe, not an
  // asserted channel message id.
  return `raw:${ev.chat.id}:${crypto.createHash("sha256")
    .update(JSON.stringify(ev.raw_event))
    .digest("hex")}`;
}

function pruneSeen(seen, keep) {
  const entries = Object.entries(seen);
  if (entries.length <= keep) return seen;
  entries.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
  return Object.fromEntries(entries.slice(0, keep));
}

async function appendEvent(file, ev) {
  await fs.appendFile(file, JSON.stringify(ev) + "\n", { mode: 0o600 });
}

function makeOutboxItem(cfg, text) {
  if (!cfg.group_id || !cfg.group_name) {
    throw new Error("target is not pinned: set group_id and group_name in data/bridge/config.json");
  }
  return {
    request_id: crypto.randomUUID(),
    group_id: cfg.group_id,
    group_name: cfg.group_name,
    text,
    created_at: nowIso(),
    status: "pending",
    attempts: 0,
    next_attempt_at: 0,
    last_error: null,
    response: null,
  };
}

async function loadState() {
  const s = await readJson(STATE_PATH, {});
  return {
    version: 1,
    seen: s.seen && typeof s.seen === "object" ? s.seen : {},
    outbox: Array.isArray(s.outbox) ? s.outbox : [],
    stats: s.stats && typeof s.stats === "object"
      ? s.stats
      : { events: 0, target_events: 0, skipped_duplicates: 0, send_ok: 0, send_failed: 0 },
  };
}

async function saveState(cfg, state) {
  state.seen = pruneSeen(state.seen, cfg.state_keep);
  await writeJsonAtomic(STATE_PATH, state);
}

async function flushOutbox(cfg, token, state) {
  let changed = false;
  for (const item of state.outbox) {
    if (item.status !== "pending") continue;
    if (item.attempts >= cfg.outbox_max_attempts) {
      item.status = "failed";
      item.last_error = item.last_error || "max attempts reached";
      changed = true;
      continue;
    }
    if (item.next_attempt_at && Date.now() < item.next_attempt_at) continue;

    // Fixed target. Never use an event's display name here.
    if (item.group_id !== cfg.group_id || item.group_name !== cfg.group_name) {
      item.status = "failed";
      item.last_error = "queued target does not match pinned config";
      changed = true;
      continue;
    }

    try {
      const resp = await api(cfg, token, "POST", "/send", {
        to: item.group_name,
        text: item.text,
      });
      item.attempts += 1;
      item.response = resp;
      // HTTP 200 is not success by itself; require sent=true.
      if (resp?.sent === true) {
        item.status = "sent";
        item.sent_at = nowIso();
        state.stats.send_ok += 1;
        log(cfg, "info", "send completed", {
          request_id: item.request_id,
          group_id: item.group_id,
          sent: resp.sent,
          verified: resp.verified,
          detail: resp.message,
        });
      } else {
        item.status = "failed";
        item.last_error = `API returned sent=${JSON.stringify(resp?.sent)}`;
        state.stats.send_failed += 1;
      }
    } catch (err) {
      item.attempts += 1;
      item.last_error = String(err?.stack || err);
      item.next_attempt_at = Date.now() + Math.min(60_000, 2000 * item.attempts);
      state.stats.send_failed += 1;
      log(cfg, "warn", "send attempt failed", {
        request_id: item.request_id,
        attempt: item.attempts,
        error: item.last_error.slice(0, 500),
      });
    }
    changed = true;
  }
  if (changed) await saveState(cfg, state);
}

function cleanGroupContent(raw) {
  const original = raw?.content;
  if (!isGroupChat(raw?.chat) || typeof original !== "string") {
    return { text: original ?? null, raw: original ?? null, stripped: false };
  }
  const pos = original.indexOf(":\n");
  if (pos <= 0) {
    return { text: original, raw: original, stripped: false };
  }
  const prefix = original.slice(0, pos);
  const talker = raw?.talker || "";
  const plausible = /^wxid_[A-Za-z0-9_-]+$/.test(prefix);
  if (plausible && (!talker || prefix === talker)) {
    return {
      text: original.slice(pos + 2),
      raw: original,
      stripped: true,
      prefix,
    };
  }
  return { text: original, raw: original, stripped: false };
}

async function handleRawEvent(cfg, state, raw) {
  const ev = normalizeEvent(raw);
  const cleaned = cleanGroupContent(raw);
  ev.content.text = cleaned.text;
  ev.content.prefix_stripped = Boolean(cleaned.stripped);
  if (cleaned.stripped) {
    ev.content.original_raw = cleaned.raw;
    if (ev.content.parsed?.type === "Text" && ev.content.parsed?.data) {
      ev.content.parsed.data.text = cleaned.text;
    }
    if (!ev.content.msg_type || (ev.content.msg_type & 0xFFFF) === 1) {
      ev.content.parsed = { type: "Text", data: { text: cleaned.text } };
    }
  }
  ev.dedupe_key = dedupeKey(ev);

  if (state.seen[ev.dedupe_key]) {
    state.stats.skipped_duplicates += 1;
    return false;
  }
  state.seen[ev.dedupe_key] = nowIso();
  state.stats.events += 1;
  await appendEvent(EVENTS_PATH, ev);

  const target = cfg.group_id ? ev.chat.id === cfg.group_id : false;
  if (target) {
    state.stats.target_events += 1;
    await appendEvent(TARGET_EVENTS_PATH, ev);
    if (!ev.sender.id) {
      log(cfg, "warn", "target message has unresolved sender", {
        dedupe_key: ev.dedupe_key,
        channel_talker: ev.sender.channel_talker,
        raw: ev.raw_event,
      });
    }
    if (ev.content.is_self) {
      log(cfg, "info", "target self message observed", {
        dedupe_key: ev.dedupe_key,
        server_id: ev.ids.channel_server_id,
        local_id: ev.ids.channel_local_id,
      });
    } else {
      log(cfg, "info", "target message received", {
        dedupe_key: ev.dedupe_key,
        group_id: ev.chat.id,
        group_name: ev.chat.display_name,
        sender_id: ev.sender.id,
        sender_name: ev.sender.display_name,
        local_id: ev.ids.channel_local_id,
        server_id: ev.ids.channel_server_id,
        create_time: ev.time.channel_create_time,
        text: ev.content.text,
        quote: ev.quote.status,
        prefix_stripped: ev.content.prefix_stripped,
      });
    }
  } else if (ev.chat.is_group) {
    log(cfg, "debug", "non-target group message recorded", {
      chat_id: ev.chat.id,
      chat_name: ev.chat.display_name,
      dedupe_key: ev.dedupe_key,
    });
  }
  await saveState(cfg, state);
  return true;
}

function wsUrl(cfg, token) {
  const base = cfg.api_base.replace(/^http/, "ws").replace(/\/+$/, "");
  return `${base}/ws?token=${encodeURIComponent(token)}`;
}

async function cmdRun(cfg) {
  const token = await loadToken(cfg);
  const state = await loadState();
  let stopping = false;
  let ws = null;
  let reconnectTimer = null;
  let chain = Promise.resolve();

  log(cfg, "info", "bridge starting", {
    api_base: cfg.api_base,
    ws_url: `${cfg.api_base.replace(/^http/, "ws").replace(/\/+$/, "")}/ws`,
    group_id: cfg.group_id || null,
    group_name: cfg.group_name || null,
  });

  const stop = () => {
    stopping = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch {}
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const connect = () => {
    if (stopping) return;
    log(cfg, "info", "websocket connecting");
    ws = new WebSocket(wsUrl(cfg, token));
    ws.onopen = () => log(cfg, "info", "websocket connected");
    ws.onmessage = (message) => {
      let event;
      const text = typeof message.data === "string" ? message.data : String(message.data);
      try {
        event = JSON.parse(text);
        // server_id is an i64; JSON.parse alone rounds >2^53. Preserve the
        // exact decimal text from the wire before it becomes a double.
        const m = text.match(/"server_id"\s*:\s*(\d+)/);
        if (m) event.server_id_exact = m[1];
      } catch (err) {
        log(cfg, "warn", "websocket non-JSON message", { error: String(err) });
        return;
      }
      if (event?.type !== "db_message") return;
      chain = chain
        .then(() => handleRawEvent(cfg, state, event))
        .catch((err) => log(cfg, "error", "event handling failed", { error: String(err?.stack || err) }));
    };
    ws.onerror = () => log(cfg, "warn", "websocket error");
    ws.onclose = () => {
      log(cfg, "warn", "websocket closed");
      if (!stopping) reconnectTimer = setTimeout(connect, 2000);
    };
  };
  connect();

  while (!stopping) {
    try {
      await flushOutbox(cfg, token, state);
    } catch (err) {
      log(cfg, "error", "outbox cycle failed", { error: String(err?.stack || err) });
    }
    await new Promise((r) => setTimeout(r, cfg.poll_interval_ms));
  }
  await chain.catch(() => {});
  if (reconnectTimer) clearTimeout(reconnectTimer);
  await saveState(cfg, state);
  log(cfg, "info", "bridge stopped");
}

async function cmdStatus(cfg) {
  const token = await loadToken(cfg);
  const state = await loadState();
  const status = await api(cfg, token, "GET", "/status");
  console.log(JSON.stringify({
    config: {
      api_base: cfg.api_base,
      group_id: cfg.group_id || null,
      group_name: cfg.group_name || null,
    },
    api_status: status,
    state: {
      stats: state.stats,
      pending_outbox: state.outbox.filter((x) => x.status === "pending").length,
      failed_outbox: state.outbox.filter((x) => x.status === "failed").length,
      seen: Object.keys(state.seen).length,
    },
  }, null, 2));
}

async function cmdGroups(cfg) {
  const token = await loadToken(cfg);
  const sessions = await api(cfg, token, "GET", "/sessions");
  const list = Array.isArray(sessions) ? sessions : sessions?.sessions ?? [];
  for (const s of list) {
    const id = s.username ?? s.chat ?? s.id;
    if (isGroupChat(id)) {
      console.log(JSON.stringify({
        group_id: id,
        group_name: s.display_name ?? s.chat_display ?? s.name ?? null,
        unread_count: s.unread_count ?? null,
        last_timestamp: s.last_timestamp ?? null,
      }));
    }
  }
}

async function cmdSend(cfg, text) {
  if (!text) throw new Error("usage: node bridge/index.js send <text>");
  const token = await loadToken(cfg);
  const state = await loadState();
  const item = makeOutboxItem(cfg, text);
  state.outbox.push(item);
  await saveState(cfg, state);
  await flushOutbox(cfg, token, state);
  const after = (await loadState()).outbox.find((x) => x.request_id === item.request_id);
  console.log(JSON.stringify(after, null, 2));
}

async function cmdSetTarget(cfg, groupId, groupName) {
  if (!groupId || !groupName) throw new Error("usage: node bridge/index.js set-target <group_id> <group_name>");
  if (!isGroupChat(groupId)) throw new Error("group_id must contain @chatroom");
  const disk = await readJson(CONFIG_PATH, {});
  disk.group_id = groupId;
  disk.group_name = groupName;
  await writeJsonAtomic(CONFIG_PATH, { ...DEFAULTS, ...disk });
  console.log(JSON.stringify({ group_id: groupId, group_name: groupName }, null, 2));
}

async function main() {
  await ensureDirs();
  const cfg = await loadConfig();
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "run": return cmdRun(cfg);
    case "status": return cmdStatus(cfg);
    case "groups": return cmdGroups(cfg);
    case "send": return cmdSend(cfg, args.join(" "));
    case "set-target": return cmdSetTarget(cfg, args[0], args.slice(1).join(" "));
    default:
      console.error("usage: bridge/index.js run|status|groups|send <text>|set-target <group_id> <group_name>");
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
