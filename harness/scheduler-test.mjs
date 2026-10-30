#!/usr/bin/env node
/**
 * Test-only scheduler integration: production agent-worker + local fake SDK.
 * No WeChat API, no real model, no production DB. Temp DB is cloned schema.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIR = path.join(ROOT, "work", "scheduler-test");
fs.mkdirSync(DIR, { recursive: true });
const DB = path.join(DIR, "reliability.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) { try { fs.rmSync(f); } catch {} }
// Clone the production schema, then clear all rows.
const src = new DatabaseSync(path.join(ROOT, "data", "reliability", "reliability.db"));
src.exec(`VACUUM INTO '${DB.replaceAll("'", "''")}'`);
src.close();
const dst = new DatabaseSync(DB);
for (const table of ["messages", "agent_requests", "agent_sessions", "agent_session_history", "outbox", "meta", "model_budget", "summary_batches", "memory_entries", "memory_versions", "chat_tool_events"]) {
  try { dst.exec(`DELETE FROM ${table}`); } catch {}
}
const now = Date.now();
const start = Date.parse("2026-10-27T00:00:00+08:00");
const end = Date.parse("2026-10-27T13:00:00+08:00");
const group = "test@chatroom";
const account = "acct";
const cfg = {
  api_base: "http://127.0.0.1:1", token_file: "unused", reliability_db: DB,
  group_id: group, group_name: "Test Group", poll_interval_ms: 100,
  auto_reply_cap: 1, account_id: account, bot_display_name: "Bot",
  limits: { enforce_auto_reply_cap: false, enforce_acceptance_round: false, enforce_model_budget: false },
  chat: { max_tokens: 128, display_chars: 500, timeout_ms: 5000, session_max_turns: 10, max_input_chars: 4000,
    web_search_enabled: true, tool_patch: path.join(ROOT, "deploy/harness/chat-web.patch.yml"),
    max_steps: 4, max_search_calls: 1, max_fetch_calls: 2 },
  summary: { max_tokens: 256, display_chars: 1500, timeout_ms: 5000, max_input_messages: 20, max_input_chars: 12000 },
  model_budget: { chat: 5, summary: 2 },
  acceptance_round: { id: "scheduler-round", total_limit: 1, chat_limit: 1, summary_limit: 1 },
};
fs.writeFileSync(path.join(DIR, "config.json"), JSON.stringify(cfg, null, 2));

const insertMessage = dst.prepare(`INSERT INTO messages
  (id,dedupe_key,account_id,group_id,group_display,sender_id,sender_display,sender_contact_name,sender_group_alias,
   local_id,server_id,id_precision,create_time,msg_type,is_self,content_text,content_raw,quote_status,quote_json,raw_json,ingested_at,processed_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const raw = (text) => JSON.stringify({ content_text: text, msg_source: "", source: "fixture" });
insertMessage.run(1, "s:1", account, group, "Test Group", "s1", "甲", "甲", null, "1", "1001", "exact", Math.floor(start/1000)+10, 1, 0, "/总结", "/总结", "not_provided", null, raw("/总结"), new Date().toISOString(), null);
insertMessage.run(2, "s:2", account, group, "Test Group", "s1", "甲", "甲", null, "2", "1002", "exact", Math.floor(start/1000)+20, 1, 0, "今天讨论了部署", "今天讨论了部署", "not_provided", null, raw("今天讨论了部署"), new Date().toISOString(), null);
insertMessage.run(3, "s:3", account, group, "Test Group", "s2", "乙", "乙", null, "3", "1003", "exact", Math.floor(start/1000)+30, 3, 0, "<img/>", "<img/>", "not_provided", null, raw("<img/>"), new Date().toISOString(), null);
insertMessage.run(4, "s:4", account, group, "Test Group", "s1", "甲", "甲", null, "4", "1004", "exact", Math.floor(start/1000)+40, 1, 0, "你好", "你好", "not_provided", null, raw("你好"), new Date().toISOString(), null);
insertMessage.run(6, "s:6", account, group, "Test Group", "s1", "甲", "甲", null, "6", "1006", "exact", Math.floor(start/1000)+50, 1, 0, "INVALID_SUMMARY", "INVALID_SUMMARY", "not_provided", null, raw("INVALID_SUMMARY"), new Date().toISOString(), null);
insertMessage.run(7, "s:7", account, group, "Test Group", "s1", "甲", "甲", null, "7", "1007", "exact", Math.floor(start/1000)+60, 1, 0, "/summary", "/summary", "not_provided", null, raw("/summary"), new Date().toISOString(), null);
insertMessage.run(8, "s:8", account, "empty@chatroom", "Empty", "s1", "甲", "甲", null, "8", "1008", "exact", Math.floor(start/1000)+70, 1, 0, "/总结", "/总结", "not_provided", null, raw("/总结"), new Date().toISOString(), null);
insertMessage.run(11, "s:11", account, group, "Test Group", "s1", "甲", "甲", null, "11", "1011", "exact", Math.floor(start/1000)+80, 1, 0, "/memory", "/memory", "not_provided", null, raw("/memory"), new Date().toISOString(), null);
insertMessage.run(12, "s:12", account, group, "Test Group", "s1", "甲", "甲", null, "12", "1012", "exact", Math.floor(start/1000)+90, 1, 0, "以后记住叫我阿蓝 MEMORY_CHAT", "以后记住叫我阿蓝 MEMORY_CHAT", "not_provided", null, raw("以后记住叫我阿蓝 MEMORY_CHAT"), new Date().toISOString(), null);
insertMessage.run(13, "s:13", account, group, "Test Group", "s1", "甲", "甲", null, "13", "1013", "exact", Math.floor(start/1000)+100, 1, 0, "WEB_SEARCH_TEST 查一下最新消息", "WEB_SEARCH_TEST 查一下最新消息", "not_provided", null, raw("WEB_SEARCH_TEST 查一下最新消息"), new Date().toISOString(), null);

const insertReq = dst.prepare(`INSERT INTO agent_requests
 (request_id,source_message_id,source_local_id,source_account_id,source_group_id,account_id,group_id,sender_id,sender_display,
  sender_contact_name,sender_group_alias,request_type,trigger_reason,range_start,range_end,snapshot_max_message_id,snapshot_at,
  prompt_text,source_json,status,queued_at,evidence)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
insertReq.run("r-summary", 1, "1", account, group, account, group, "s1", "甲", "甲", null,
  "summary", "command", start, end, 4, new Date().toISOString(), "/总结", JSON.stringify({ content_text: "/总结" }),
  "queued", new Date(now - 1000).toISOString(), "fixture summary");
insertReq.run("r-chat", 4, "4", account, group, account, group, "s1", "甲", "甲", null,
  "chat", "mention", null, null, null, null, "你好", JSON.stringify({ content_text: "你好" }),
  "queued", new Date(now).toISOString(), "fixture chat");
insertReq.run("r-chat-empty", 9, "9", account, group, account, group, "s1", "甲", "甲", null,
  "chat", "mention", null, null, null, null, "EMPTY_CHAT", JSON.stringify({ content_text: "EMPTY_CHAT" }),
  "queued", new Date(now + 500).toISOString(), "fixture empty chat");
insertReq.run("r-chat-truncated", 10, "10", account, group, account, group, "s1", "甲", "甲", null,
  "chat", "mention", null, null, null, null, "TRUNCATED_CHAT", JSON.stringify({ content_text: "TRUNCATED_CHAT" }),
  "queued", new Date(now + 300).toISOString(), "fixture truncated chat");
insertReq.run("r-summary-invalid", 7, "7", account, group, account, group, "s1", "甲", "甲", null,
  "summary", "command", start, end, 7, new Date().toISOString(), "/summary", JSON.stringify({ content_text: "/summary" }),
  "queued", new Date(now + 1000).toISOString(), "fixture invalid summary");
insertReq.run("r-chat-memory", 12, "12", account, group, account, group, "s1", "甲", "甲", null,
  "chat", "mention", null, null, null, null, "以后记住叫我阿蓝 MEMORY_CHAT", JSON.stringify({ content_text: "以后记住叫我阿蓝 MEMORY_CHAT" }),
  "queued", new Date(now + 200).toISOString(), "fixture memory action chat");
insertReq.run("r-memory", 11, "11", account, group, account, group, "s1", "甲", "甲", null,
  "memory", "command", null, null, null, null, "/memory", JSON.stringify({ content_text: "/memory" }),
  "queued", new Date(now + 250).toISOString(), "fixture memory command");
insertReq.run("r-chat-web", 13, "13", account, group, account, group, "s1", "甲", "甲", null,
  "chat", "mention", null, null, null, null, "WEB_SEARCH_TEST 查一下最新消息", JSON.stringify({ content_text: "WEB_SEARCH_TEST 查一下最新消息" }),
  "queued", new Date(now + 150).toISOString(), "fixture fake web search");
insertReq.run("r-summary-empty", 8, "8", account, "empty@chatroom", account, "empty@chatroom", "s1", "甲", "甲", null,
  "summary", "command", start, end, 8, new Date().toISOString(), "/总结", JSON.stringify({ content_text: "/总结" }),
  "queued", new Date(now + 2000).toISOString(), "fixture empty summary");
dst.prepare("UPDATE agent_requests SET summary_target_date='2026-10-05' WHERE request_id='r-summary-empty'").run();

const child = spawn(process.execPath, [path.join(ROOT, "bridge", "agent-worker.js")], {
  cwd: ROOT,
  env: { ...process.env, DSH_FAKE_SDK: "1", RELIABILITY_DB: DB, BOT_CONFIG_PATH: path.join(DIR, "config.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "", err = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { err += d; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let status = null;
for (let i = 0; i < 50; i++) {
  await wait(100);
  const done = dst.prepare("SELECT count(*) n FROM agent_requests WHERE status IN ('succeeded','failed')").get().n;
  status = dst.prepare("SELECT count(*) n FROM agent_requests WHERE status='succeeded'").get().n;
  if (done >= 9) break;
}
child.kill("SIGTERM");
await wait(300);
const requests = dst.prepare("SELECT request_id,request_type,status,summary_json,validation_status,reply_request_id FROM agent_requests ORDER BY request_type").all();
const outbox = dst.prepare("SELECT text,status,agent_request_id,source_message_id FROM outbox ORDER BY created_at").all();
const sessions = dst.prepare("SELECT account_id,group_id,session_id,state FROM agent_sessions").all();
const budget = dst.prepare("SELECT type,used,limit_value FROM model_budget ORDER BY type").all();
const invalid = requests.find((r) => r.request_id === "r-summary-invalid");
const summaryBatches = dst.prepare("SELECT request_id,level,batch_index,status,input_messages FROM summary_batches ORDER BY request_id,level,batch_index").all();
const memoryEntries = dst.prepare("SELECT type,subject_id,content,status FROM memory_entries").all();
const memoryCommand = requests.find((r) => r.request_id === "r-memory");
const memoryChat = requests.find((r) => r.request_id === "r-chat-memory");
const memoryChatReply = outbox.find((r) => r.agent_request_id === "r-chat-memory");
const webChat = requests.find((r) => r.request_id === "r-chat-web");
const webReply = outbox.find((r) => r.agent_request_id === "r-chat-web");
const toolEvents = dst.prepare("SELECT tool,query,url,status FROM chat_tool_events WHERE request_id='r-chat-web' ORDER BY rowid").all();
const empty = requests.find((r) => r.request_id === "r-summary-empty");
const emptyReply = outbox.find((r) => r.agent_request_id === "r-summary-empty");
const emptyChat = requests.find((r) => r.request_id === "r-chat-empty");
const emptyChatReply = outbox.find((r) => r.agent_request_id === "r-chat-empty");
const truncatedChat = requests.find((r) => r.request_id === "r-chat-truncated");
const truncatedReply = outbox.find((r) => r.agent_request_id === "r-chat-truncated");
const round = dst.prepare("SELECT * FROM acceptance_round WHERE id='scheduler-round'").get();
const invalidReply = outbox.find((r) => r.agent_request_id === "r-summary-invalid");
const result = { passed: status === 7 && outbox.length === 9 && summaryBatches.some((b) => b.request_id === "r-summary" && b.level === 0 && b.status === "succeeded" && b.input_messages === 3) && summaryBatches.some((b) => b.request_id === "r-summary-invalid" && b.level === 0 && b.status === "failed")
  && memoryCommand?.status === "succeeded" && memoryCommand?.validation_status === "memory_command"
  && memoryChat?.status === "succeeded" && memoryChatReply && !memoryChatReply.text.includes("memory_actions")
  && memoryEntries.some((m) => m.type === "member_preference" && m.status === "active" && m.content.includes("阿蓝"))
  && webChat?.status === "succeeded" && webReply?.text.includes("https://example.com/a")
  && toolEvents.length === 3 && toolEvents.filter((x) => x.tool === "web_search").length === 1
  && toolEvents.filter((x) => x.tool === "web_fetch").length === 2 && invalid?.status === "failed" && invalid?.validation_status === "failure_notice" && invalidReply?.text.includes("这次总结未能完成") && empty?.status === "succeeded" && empty?.validation_status === "no_messages" && emptyReply?.text.includes("无当日对话信息（2026-10-05）") && emptyChat?.status === "failed" && emptyChat?.validation_status === "failure_notice" && emptyChatReply?.text.includes("这次回答未能完成") && truncatedChat?.status === "succeeded" && truncatedChat?.validation_status === "truncated" && truncatedReply?.text.includes("回答未完整结束") && sessions.length === 1 && budget.every((b) => b.used === 0) && round?.total_used === 0, requests, outbox, sessions, budget, round, summaryBatches, memoryEntries, toolEvents, stderr: err.slice(-1000) };
fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
dst.close();
process.exit(result.passed ? 0 : 1);
