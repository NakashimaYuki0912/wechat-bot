#!/usr/bin/env node
/** Persistent memory tests. In-memory/file SQLite only; no model or network. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ensureMemorySchema, applyMemoryActions, retrieveMemories, parseChatEnvelope,
  parseMemoryCommand, MEMORY_TYPES,
} from "../bridge/memory.js";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "work", "memory-test");
fs.mkdirSync(DIR, { recursive: true });
const file = path.join(DIR, "memory.db");
try { fs.rmSync(file); } catch {}
let db = new DatabaseSync(file);
ensureMemorySchema(db);
const results = [];
const ok = (name, pass, detail = "") => results.push({ name, pass: Boolean(pass), detail });
const base = { account_id: "acct", group_id: "group", sender_id: "wxid_member", currentMessageId: 100, text: "以后请叫我阿杂", quotePresent: false, isAdmin: false };
const upsert = (content, extra = {}) => ({ operation: "upsert", type: "member_preference", content, source_message_id: 100, ...extra });
const ctx = (over = {}) => ({ ...base, ...over });

let r = applyMemoryActions(db, ctx(), [upsert("称呼我阿杂，回答简洁一点")]);
ok("member preference saved", r.ok && r.changes.length === 1);
ok("member preference retrieved", retrieveMemories(db, ctx()).memories.some((m) => m.content.includes("阿杂")));
r = applyMemoryActions(db, ctx(), [upsert("称呼我阿杂，回答简洁一点")]);
ok("replay is deduped", r.ok && r.changes[0].operation === "deduped");
r = applyMemoryActions(db, ctx({ text: "以后更新我的偏好：叫我杂哥" }), [upsert("称呼我杂哥")]);
ok("new preference supersedes old", r.ok && db.prepare("select count(*) n from memory_entries where status='active' and type='member_preference'").get().n === 1);
ok("version history exists", db.prepare("select count(*) n from memory_versions").get().n >= 3);
ok("old preference no longer retrieved", !retrieveMemories(db, ctx()).memories.some((m) => m.content.includes("阿杂")));

r = applyMemoryActions(db, ctx({ text: "记住，他喜欢蓝色" }), [upsert("他喜欢蓝色")]);
ok("third-party member fact rejected", !r.ok);
r = applyMemoryActions(db, ctx({ text: "如果以后叫我阿蓝", quotePresent: false }), [upsert("叫我阿蓝")]);
ok("hypothetical rejected", !r.ok);
r = applyMemoryActions(db, ctx({ text: "记住，我引用的话" , quotePresent: true }), [upsert("我引用的话")]);
ok("quoted content rejected", !r.ok);
r = applyMemoryActions(db, ctx({ text: "记住密码 abc123" }), [upsert("密码 abc123")]);
ok("credential-like content rejected", !r.ok);

const ctx2 = ctx({ sender_id: "wxid_same_name", text: "以后叫我阿杂" });
r = applyMemoryActions(db, ctx2, [upsert("称呼我阿杂")]);
ok("same display name isolated by sender id", r.ok && retrieveMemories(db, ctx2).memories.some((m) => m.content.includes("阿杂")) && retrieveMemories(db, ctx()).memories.length >= 1);

const adminCtx = ctx({ sender_id: "wxid_admin", isAdmin: true, text: "记住本群约定：晚上十一点后不刷屏" });
r = applyMemoryActions(db, adminCtx, [{ operation: "upsert", type: "group_background", content: "晚上十一点后不刷屏", source_message_id: 100 }]);
ok("admin can save group background", r.ok);
r = applyMemoryActions(db, ctx({ text: "记住本群约定：不刷屏" }), [{ operation: "upsert", type: "group_background", content: "不刷屏", source_message_id: 100 }]);
ok("non-admin cannot save group background", !r.ok);
ok("group background is retrievable by member", retrieveMemories(db, ctx()).memories.some((m) => m.type === "group_background"));

const tempCtx = ctx({ text: "记住今晚九点开黑", currentMessageId: 101 });
r = applyMemoryActions(db, tempCtx, [{ operation: "upsert", type: "temporary_context", content: "今晚九点开黑", source_message_id: 101, expires_at: new Date(Date.now() + 60000).toISOString() }]);
ok("temporary context saved with expiry", r.ok && retrieveMemories(db, tempCtx).memories.some((m) => m.type === "temporary_context"));
db.prepare("update memory_entries set expires_at='2000-01-01T00:00:00.000Z' where type='temporary_context' and status='active'").run();
ok("expired memory not retrieved", !retrieveMemories(db, tempCtx).memories.some((m) => m.type === "temporary_context"));

const active = retrieveMemories(db, ctx()).memories.find((m) => m.type === "member_preference");
const forgetCtx = ctx({ text: "忘记这条记忆" });
r = applyMemoryActions(db, forgetCtx, [{ operation: "forget", memory_id: active.id, source_message_id: 100 }]);
ok("owner can forget memory", r.ok && !retrieveMemories(db, forgetCtx).memories.some((m) => m.id === active.id));
r = applyMemoryActions(db, ctx({ text: "不要记住这个" }), [upsert("不要记住这个")]);
ok("negative instruction rejected", !r.ok);

const env = parseChatEnvelope(JSON.stringify({ reply: "好，我记住了", memory_actions: [upsert("称呼我阿杂")] }));
ok("structured envelope parsed, reply separated", env.structured && env.reply === "好，我记住了" && env.actions.length === 1);
ok("plain text remains plain", parseChatEnvelope("今天吃什么").structured === false);
ok("malformed structured output marked", parseChatEnvelope("{bad").malformed === true);
ok("memory command parsed", parseMemoryCommand("/memory").action === "list" && parseMemoryCommand("/memory forget 11111111-1111-1111-1111-111111111111").action === "forget");

db.close();
db = new DatabaseSync(file);
ensureMemorySchema(db);
ok("memory survives restart", retrieveMemories(db, ctx()).memories.length >= 1);
db.close();
const result = { passed: results.every((r) => r.pass), results };
fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
