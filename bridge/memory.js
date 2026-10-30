/**
 * Persistent, scoped background memory.
 *
 * Models only propose structured memory_actions. This module validates scope,
 * permissions, explicitness, provenance and credentials, then commits entries
 * and versions in one transaction. Chat replies are never sent until the
 * commit succeeds.
 */
import crypto from "node:crypto";

export const MEMORY_TYPES = [
  "member_preference",
  "group_background",
  "group_joke",
  "fictional_setting",
  "temporary_context",
];
const GROUP_TYPES = new Set(["group_background", "group_joke", "fictional_setting"]);
const MEMBER_TYPES = new Set(["member_preference", "temporary_context"]);

export function ensureMemorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      type TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source_message_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      dedupe_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_versions (
      version_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_message_id INTEGER,
      changed_at TEXT NOT NULL,
      changed_by_sender_id TEXT,
      change_kind TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_active_dedupe
      ON memory_entries(account_id,group_id,type,subject_kind,subject_id,dedupe_key)
      WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_memory_scope
      ON memory_entries(account_id,group_id,subject_kind,subject_id,status);
  `);
}

function nowIso() { return new Date().toISOString(); }
function hash(...parts) { return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex"); }
function norm(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }
function isCredential(content) {
  return /(sk-[A-Za-z0-9_-]{8,}|api[_-]?key|password|密码|secret|token|BEGIN [A-Z ]*PRIVATE KEY)/i.test(content);
}
function hasExplicitCue(text) {
  return /(记住|记一下|记下|以后|今后|从今以后|更新.{0,6}偏好|我的偏好|叫我|称呼我|请记得|remember|from now on|忘记|删掉|删除|forget|别再记|群规|群约定|约定|梗)/i.test(text);
}
function hasUnsafeContext(text) {
  return /(不要记住|别记住|不用记|不是要你记|听说|据说|他说|她说|转述|如果|假如|要是|假设|开玩笑|玩梗)/i.test(text);
}

export function parseChatEnvelope(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("{")) return { structured: false, reply: raw, actions: [] };
  let value;
  try { value = JSON.parse(raw); } catch {
    return { structured: true, malformed: true, reply: "", actions: [], error: "invalid JSON envelope" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.reply !== "string") {
    return { structured: true, malformed: true, reply: "", actions: [], error: "missing reply" };
  }
  if (value.memory_actions !== undefined && !Array.isArray(value.memory_actions)) {
    return { structured: true, malformed: true, reply: "", actions: [], error: "memory_actions is not an array" };
  }
  return { structured: true, malformed: false, reply: value.reply.trim(), actions: value.memory_actions || [] };
}

export function validateMemoryActions(actions, ctx) {
  if (!Array.isArray(actions) || actions.length === 0) return { ok: true, actions: [] };
  if (actions.length > 4) return { ok: false, error: "too many memory actions" };
  const text = String(ctx.text ?? "");
  if (!hasExplicitCue(text)) return { ok: false, error: "no explicit memory cue" };
  if (hasUnsafeContext(text)) return { ok: false, error: "quoted/negated/hypothetical/joke context is not a personal fact" };
  if (ctx.quotePresent) return { ok: false, error: "quoted content cannot become a personal fact" };
  const result = [];
  for (const [i, a] of actions.entries()) {
    if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: `action ${i} invalid` };
    const op = a.operation;
    if (op !== "upsert" && op !== "forget") return { ok: false, error: `action ${i} operation invalid` };
    if (Number(a.source_message_id) !== Number(ctx.currentMessageId)) return { ok: false, error: `action ${i} source is not current message` };
    if (op === "forget") {
      if (typeof a.memory_id !== "string" || !a.memory_id.trim()) return { ok: false, error: `action ${i} memory_id missing` };
      result.push({ operation: "forget", memory_id: a.memory_id.trim(), source_message_id: Number(a.source_message_id) });
      continue;
    }
    const type = a.type;
    if (!MEMORY_TYPES.includes(type)) return { ok: false, error: `action ${i} type invalid` };
    const content = norm(a.content);
    if (!content || Array.from(content).length > 300) return { ok: false, error: `action ${i} content invalid` };
    if (isCredential(content)) return { ok: false, error: `action ${i} contains credential-like content` };
    if (GROUP_TYPES.has(type)) {
      if (!ctx.isAdmin) return { ok: false, error: `action ${i} requires admin` };
    } else if (!MEMBER_TYPES.has(type)) {
      return { ok: false, error: `action ${i} type invalid` };
    }
    if (type === "member_preference" && /(他|她|他们|对方|别人)/.test(content)) {
      return { ok: false, error: `action ${i} third-party member fact is ambiguous` };
    }
    let expiresAt = null;
    if (type === "temporary_context") {
      expiresAt = a.expires_at ? new Date(a.expires_at).toISOString() : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) return { ok: false, error: `action ${i} expiry invalid` };
    }
    result.push({ operation: "upsert", type, content, source_message_id: Number(a.source_message_id), expires_at: expiresAt });
  }
  return { ok: true, actions: result };
}

export function applyMemoryActions(db, ctx, actions) {
  const validation = validateMemoryActions(actions, ctx);
  if (!validation.ok) return validation;
  if (!validation.actions.length) return { ok: true, changes: [] };
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const changes = [];
    for (const a of validation.actions) {
      if (a.operation === "forget") {
        const row = db.prepare(`SELECT * FROM memory_entries WHERE id=? AND account_id=? AND group_id=?
          AND status='active'`).get(a.memory_id, ctx.account_id, ctx.group_id);
        if (!row) { db.exec("ROLLBACK"); return { ok: false, error: "memory not found in this scope" }; }
        const own = row.subject_kind === "member" && row.subject_id === ctx.sender_id;
        const groupAdmin = row.subject_kind === "group" && ctx.isAdmin;
        if (!own && !groupAdmin) { db.exec("ROLLBACK"); return { ok: false, error: "not allowed to forget this memory" }; }
        const version = Number(row.version) + 1;
        db.prepare(`UPDATE memory_entries SET status='forgotten', updated_at=?, version=? WHERE id=?`).run(now, version, row.id);
        db.prepare(`INSERT INTO memory_versions(version_id,memory_id,version,content,source_message_id,changed_at,changed_by_sender_id,change_kind)
          VALUES(?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), row.id, version, row.content, a.source_message_id, now, ctx.sender_id, "forget");
        changes.push({ operation: "forget", id: row.id });
        continue;
      }
      const subjectKind = GROUP_TYPES.has(a.type) ? "group" : "member";
      const subjectId = subjectKind === "group" ? ctx.group_id : ctx.sender_id;
      const key = hash(a.type, subjectKind, subjectId, norm(a.content).toLowerCase());
      const duplicate = db.prepare(`SELECT id FROM memory_entries WHERE account_id=? AND group_id=? AND type=?
        AND subject_kind=? AND subject_id=? AND dedupe_key=? AND status='active'`)
        .get(ctx.account_id, ctx.group_id, a.type, subjectKind, subjectId, key);
      if (duplicate) { changes.push({ operation: "deduped", id: duplicate.id }); continue; }
      if (a.type === "member_preference") {
        const olds = db.prepare(`SELECT * FROM memory_entries WHERE account_id=? AND group_id=? AND type=?
          AND subject_kind='member' AND subject_id=? AND status='active'`).all(ctx.account_id, ctx.group_id, a.type, subjectId);
        for (const old of olds) {
          const v = Number(old.version) + 1;
          db.prepare(`UPDATE memory_entries SET status='superseded', updated_at=?, version=? WHERE id=?`).run(now, v, old.id);
          db.prepare(`INSERT INTO memory_versions(version_id,memory_id,version,content,source_message_id,changed_at,changed_by_sender_id,change_kind)
            VALUES(?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), old.id, v, old.content, a.source_message_id, now, ctx.sender_id, "superseded");
        }
      }
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO memory_entries(id,account_id,group_id,type,subject_kind,subject_id,content,source_message_id,created_at,updated_at,status,expires_at,version,dedupe_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,1,?)`).run(id, ctx.account_id, ctx.group_id, a.type, subjectKind, subjectId, a.content, a.source_message_id, now, now, a.expires_at, key);
      db.prepare(`INSERT INTO memory_versions(version_id,memory_id,version,content,source_message_id,changed_at,changed_by_sender_id,change_kind)
        VALUES(?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), id, 1, a.content, a.source_message_id, now, ctx.sender_id, "create");
      changes.push({ operation: "upsert", id, type: a.type });
    }
    db.exec("COMMIT");
    return { ok: true, changes };
  } catch (e) {
    db.exec("ROLLBACK");
    return { ok: false, error: String(e?.message || e) };
  }
}

export function retrieveMemories(db, ctx, { limit = 8, maxChars = 1800 } = {}) {
  const now = nowIso();
  const rows = db.prepare(`SELECT * FROM memory_entries WHERE account_id=? AND group_id=? AND status='active'
    AND (expires_at IS NULL OR expires_at > ?)
    AND ((subject_kind='member' AND subject_id=?) OR subject_kind='group')
    ORDER BY CASE type WHEN 'group_background' THEN 0 WHEN 'group_joke' THEN 1 WHEN 'fictional_setting' THEN 2
      WHEN 'member_preference' THEN 3 ELSE 4 END, updated_at DESC LIMIT ?`)
    .all(ctx.account_id, ctx.group_id, now, ctx.sender_id, Math.max(limit * 3, limit));
  const out = [];
  let chars = 2;
  for (const r of rows) {
    if (out.length >= limit) break;
    const item = { id: r.id, type: r.type, subject: r.subject_kind === "group" ? "group" : r.subject_id, content: r.content, source_message_id: r.source_message_id, updated_at: r.updated_at, expires_at: r.expires_at };
    const size = JSON.stringify(item).length;
    if (chars + size > maxChars) break;
    out.push(item); chars += size;
  }
  return { memories: out, count: out.length, chars };
}

export function renderMemoryList(memories) {
  if (!memories.length) return "目前没有找到可用的背景记忆。";
  const names = { member_preference: "个人偏好", group_background: "群背景", group_joke: "群梗", fictional_setting: "虚构设定", temporary_context: "临时事项" };
  return "背景记忆：\n" + memories.map((m, i) => `${i + 1}. [${names[m.type] || m.type}] ${m.content}${m.expires_at ? `（到期：${m.expires_at}）` : ""}${m.id ? `（编号：${m.id}）` : ""}`).join("\n");
}

export function parseMemoryCommand(text) {
  const t = String(text ?? "").trim();
  if (!/^(\/memory|\/记忆)(?:\s|$)/i.test(t)) return null;
  const rest = t.replace(/^(\/memory|\/记忆)\s*/i, "").trim();
  if (!rest) return { action: "list" };
  const forget = rest.match(/^(?:forget|忘记|删掉)\s+([0-9a-f-]{36})$/i);
  if (forget) return { action: "forget", id: forget[1] };
  if (/^(group|群|群背景)$/i.test(rest)) return { action: "group" };
  return { action: "help" };
}

export function listGroupMemories(db, ctx, { limit = 20 } = {}) {
  const now = nowIso();
  return db.prepare(`SELECT * FROM memory_entries WHERE account_id=? AND group_id=?
    AND subject_kind='group' AND status='active' AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY updated_at DESC LIMIT ?`).all(ctx.account_id, ctx.group_id, now, limit);
}
