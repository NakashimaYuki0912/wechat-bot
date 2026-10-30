#!/usr/bin/env node
/** Test-only bridge routing/storage against a cloned schema. No model/WeChat. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIR = path.join(ROOT, "work", "bridge-routing-test");
fs.mkdirSync(DIR, { recursive: true });
const DB = path.join(DIR, "reliability.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) { try { fs.rmSync(f); } catch {} }
const src = new DatabaseSync(path.join(ROOT, "data", "reliability", "reliability.db"));
src.exec(`VACUUM INTO '${DB.replaceAll("'", "''")}'`);
src.close();
const db = new DatabaseSync(DB);
for (const t of ["messages", "agent_requests", "agent_sessions", "agent_session_history", "outbox", "meta", "model_budget"]) { try { db.exec(`DELETE FROM ${t}`); } catch {} }
const now = new Date().toISOString();
const group = "test@chatroom", account = "acct";
const cfg = {
  api_base: "http://127.0.0.1:1", token_file: path.join(DIR, "token"),
  reliability_db: DB, group_id: group, group_name: "Test Group",
  poll_interval_ms: 100, send_timeout_ms: 1000,
  account_id: account, bot_display_name: "Bot", auto_reply_cap: 0,
  limits: { enforce_auto_reply_cap: false, enforce_acceptance_round: false, enforce_model_budget: false },
  chat: { max_input_chars: 4000 }, summary: {},
};
fs.writeFileSync(path.join(DIR, "token"), "test-token\n");
fs.writeFileSync(path.join(DIR, "config.json"), JSON.stringify(cfg, null, 2));
const add = db.prepare(`INSERT INTO messages
 (id,dedupe_key,account_id,group_id,group_display,sender_id,sender_display,sender_contact_name,sender_group_alias,
  local_id,server_id,id_precision,create_time,msg_type,is_self,content_text,content_raw,quote_status,quote_json,raw_json,ingested_at,processed_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const raw = (text, source = "") => JSON.stringify({ content_text: text, msg_source: source, source: "fixture" });
add.run(1, "s:1", account, group, "Test Group", "s1", "甲", "甲", null, "1", "101", "exact", 1793000000, 1, 0, "/总结 2026-10-5", "/总结 2026-10-5", "not_provided", null, raw("/总结 2026-10-5"), now, null);
add.run(2, "s:2", account, group, "Test Group", "s2", "乙", "乙", null, "2", "102", "exact", 1793000010, 1, 0, "@Bot 你好", "@Bot 你好", "not_provided", null, raw("@Bot 你好", "<msgsource><atuserlist>acct</atuserlist></msgsource>"), now, null);
add.run(3, "s:3", account, group, "Test Group", "s2", "乙", "乙", null, "3", "103", "exact", 1793000020, 1, 0, "普通消息", "普通消息", "not_provided", null, raw("普通消息"), now, null);
const child = spawn(process.execPath, [path.join(ROOT, "bridge", "reliable.js"), "run"], {
  cwd: ROOT,
  env: { ...process.env, BOT_CONFIG_PATH: path.join(DIR, "config.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "", err = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { err += d; });
await new Promise((r) => setTimeout(r, 1800));
child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 300));
const reqs = db.prepare("SELECT request_type,trigger_reason,status,summary_target_date,range_start,range_end,snapshot_max_message_id FROM agent_requests ORDER BY source_message_id").all();
const outbox = db.prepare("SELECT count(*) n FROM outbox").get().n;
const processed = db.prepare("SELECT count(*) n FROM messages WHERE processed_at IS NOT NULL").get().n;
const result = {
  passed: reqs.length === 2 && reqs.some((r) => r.request_type === "summary" && r.trigger_reason === "command")
    && reqs.some((r) => r.request_type === "chat" && r.trigger_reason === "mention")
    && reqs.every((r) => r.status === "queued") && outbox === 0 && processed === 3,
  requests: reqs, outbox, processed, stdout: out.slice(-3000), stderr: err.slice(-1000),
};
fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
db.close();
process.exit(result.passed ? 0 : 1);
