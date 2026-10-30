#!/usr/bin/env node
/**
 * One-shot, idempotent migration of the old JSONL/state bridge data into
 * reliability.db. Old 64-bit server_ids that were parsed as JS numbers are
 * deliberately NOT upgraded: they are marked historical_imprecise and their
 * server_id is stored as NULL. Exact IDs from the new ingest are untouched.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OLD_EVENTS = path.join(ROOT, "data", "bridge", "events.jsonl");
const OLD_STATE = path.join(ROOT, "data", "bridge", "state.json");
const DB_PATH = process.env.RELIABILITY_DB || path.join(ROOT, "data", "reliability", "reliability.db");

const SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE,
  account_id TEXT, group_id TEXT, group_display TEXT, sender_id TEXT, sender_display TEXT,
  local_id TEXT, server_id TEXT, id_precision TEXT NOT NULL DEFAULT 'exact',
  create_time INTEGER, msg_type INTEGER, is_self INTEGER NOT NULL DEFAULT 0,
  content_text TEXT, content_raw TEXT, quote_status TEXT NOT NULL DEFAULT 'not_provided',
  quote_json TEXT, raw_json TEXT NOT NULL, ingested_at TEXT NOT NULL, processed_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  request_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, group_name TEXT NOT NULL,
  text TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT, confirmed_at TEXT,
  last_error TEXT, response_json TEXT, evidence TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function now() { return new Date().toISOString(); }
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }

const db = new DatabaseSync(DB_PATH);
db.exec(SCHEMA);
const insert = db.prepare(`
  INSERT OR IGNORE INTO messages
  (dedupe_key,account_id,group_id,group_display,sender_id,sender_display,local_id,server_id,
   id_precision,create_time,msg_type,is_self,content_text,content_raw,quote_status,quote_json,raw_json,ingested_at,processed_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const lines = (await fs.readFile(OLD_EVENTS, "utf8").catch(() => "")).split("\n").filter(Boolean);
let inserted = 0, historical = 0;
db.exec("BEGIN IMMEDIATE");
try {
  for (const line of lines) {
    const ev = JSON.parse(line);
    const raw = ev.raw_event || {};
    const ids = ev.ids || {};
    const evServer = raw.server_id;
    const oldString = ids.channel_server_id ? String(ids.channel_server_id) : null;
    // New events (ws v2) carry server_id_exact. Old events with a numeric
    // server_id > 2^53 are historical and intentionally not claimed exact.
    const exact = typeof raw.server_id_exact === "string" ? raw.server_id_exact : null;
    const unsafe = !exact && typeof evServer === "number" && Number.isFinite(evServer) && !Number.isSafeInteger(evServer);
    const server = unsafe ? null : (exact || oldString || null);
    const precision = unsafe ? "historical_imprecise" : (exact || oldString ? "exact_i64_to_decimal_string" : "no_server_id");
    const rawCopy = { ...ev, historical_note: unsafe ? "legacy C/D event: 64-bit server_id was parsed as JS number; not asserted exact" : undefined };
    const n = insert.run(
      ev.dedupe_key, ev.raw_event?.account_id ?? null, ev.chat?.id ?? null,
      ev.chat?.display_name ?? null, ev.sender?.id ?? null, ev.sender?.display_name ?? null,
      ids.channel_local_id == null ? null : String(ids.channel_local_id),
      server, precision, ev.time?.channel_create_time ?? null,
      ev.content?.msg_type ?? null, ev.content?.is_self ? 1 : 0,
      ev.content?.text ?? ev.content?.parsed?.data?.text ?? null,
      ev.content?.raw ?? ev.content?.original_raw ?? null,
      ev.quote?.status ?? "not_provided", JSON.stringify(ev.quote ?? {}),
      JSON.stringify(rawCopy), now(), now()
    ).changes;
    inserted += n;
    if (unsafe) historical += 1;
  }
  db.prepare("INSERT INTO meta(key,value) VALUES('legacy_migrated_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(now());
  db.prepare("INSERT INTO meta(key,value) VALUES('legacy_historical_imprecise',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(historical));
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error(e);
  process.exit(1);
}
const state = await readJson(OLD_STATE, {});
let outboxInserted = 0;
for (const item of state.outbox || []) {
  const n = db.prepare(`
    INSERT OR IGNORE INTO outbox(request_id,group_id,group_name,text,status,attempts,created_at,updated_at,sent_at,confirmed_at,last_error,response_json,evidence)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(item.request_id, item.group_id, item.group_name, item.text, item.status || "uncertain",
    item.attempts || 0, item.created_at || now(), item.updated_at || now(), item.sent_at || null,
    item.confirmed_at || null, item.last_error || null, JSON.stringify(item.response || null),
    "migrated from legacy state.json; no automatic retry").changes;
  outboxInserted += n;
}
console.log(JSON.stringify({ db: DB_PATH, messages_scanned: lines.length, inserted, historical_imprecise: historical, outbox_inserted: outboxInserted }, null, 2));
db.close();
