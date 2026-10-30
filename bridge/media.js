/**
 * Controlled inbound image attachments.
 *
 * Only rows registered for the exact account/group/message may be read. The
 * file must stay under the configured media root and be a real image by magic
 * bytes. This module never walks arbitrary server paths.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MEDIA_ROOT = path.join(ROOT, "data", "media");

export function ensureMediaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      path TEXT NOT NULL,
      mime TEXT,
      bytes INTEGER,
      width INTEGER,
      height INTEGER,
      sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_message ON media(message_id);
    CREATE INDEX IF NOT EXISTS idx_media_scope ON media(account_id,group_id,message_id,status);
    CREATE TABLE IF NOT EXISTS media_fetch_tasks (
      task_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      source_md5 TEXT,
      prompt_text TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      error TEXT,
      ui_action TEXT,
      result_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_fetch_message
      ON media_fetch_tasks(account_id,group_id,message_id);
    CREATE TABLE IF NOT EXISTS media_fetch_lock (
      id INTEGER PRIMARY KEY CHECK(id=1),
      owner TEXT,
      expires_at INTEGER
    );
  `);
  const cols = new Set(db.prepare("PRAGMA table_info(media)").all().map((c) => c.name));
  for (const [name, sql] of [
    ["source_md5", "ALTER TABLE media ADD COLUMN source_md5 TEXT"],
    ["converted", "ALTER TABLE media ADD COLUMN converted INTEGER NOT NULL DEFAULT 0"],
    ["fetch_method", "ALTER TABLE media ADD COLUMN fetch_method TEXT"],
    ["ui_action", "ALTER TABLE media ADD COLUMN ui_action TEXT"],
  ]) if (!cols.has(name)) db.exec(sql);
}

function md5File(filePath) {
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

/** Extract the exact image md5 from an image/emoji XML message. */
export function imageMd5FromContent(raw) {
  const m = String(raw || "").match(/\bmd5=["']([0-9a-fA-F]{32})["']/);
  return m ? m[1].toLowerCase() : null;
}

/** Find a cached WeChat file by exact message md5; never by recency. */
export function findCachedMediaByMd5(md5, cacheRoots = [], { maxFiles = 20000 } = {}) {
  const wanted = String(md5 || "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(wanted)) return null;
  let seen = 0;
  for (const root of cacheRoots) {
    if (!root || !fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { stack.push(full); continue; }
        if (!ent.isFile() || ++seen > maxFiles) continue;
        try { if (md5File(full) === wanted) return full; } catch {}
      }
    }
  }
  return null;
}

function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (buf.length >= 6 && (buf.subarray(0,6).toString("ascii") === "GIF87a" || buf.subarray(0,6).toString("ascii") === "GIF89a")) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0,4).toString("ascii") === "RIFF" && buf.subarray(8,12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function registerMedia(db, { messageId, accountId, groupId, filePath, mediaRoot = DEFAULT_MEDIA_ROOT, sourceMd5 = null, converted = 0, fetchMethod = "local", uiAction = null }) {
  const root = path.resolve(mediaRoot);
  const abs = path.resolve(filePath);
  if (!(abs === root || abs.startsWith(root + path.sep))) return { ok: false, error: "media path is outside the configured root" };
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return { ok: false, error: `media read failed: ${e.message}` }; }
  const mime = sniffMime(buf);
  if (!mime) return { ok: false, error: "not a JPEG/PNG/GIF/WebP image" };
  const now = new Date().toISOString();
  const storedPath = path.relative(root, abs) || path.basename(abs);
  db.prepare(`INSERT INTO media(id,message_id,account_id,group_id,path,mime,bytes,sha256,status,created_at,updated_at,source_md5,converted,fetch_method,ui_action)
    VALUES(?,?,?,?,?,?,?,?,'ready',?,?,?,?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET path=excluded.path,mime=excluded.mime,bytes=excluded.bytes,
      sha256=excluded.sha256,status='ready',error=NULL,updated_at=excluded.updated_at,
      source_md5=excluded.source_md5,converted=excluded.converted,fetch_method=excluded.fetch_method,ui_action=excluded.ui_action`)
    .run(crypto.randomUUID(), Number(messageId), accountId, groupId, storedPath, mime, buf.length,
      crypto.createHash("sha256").update(buf).digest("hex"), now, now,
      sourceMd5 ? String(sourceMd5).toLowerCase() : null, converted ? 1 : 0, fetchMethod || null,
      uiAction ? JSON.stringify(uiAction).slice(0, 4000) : null);
  return { ok: true, mime, bytes: buf.length };
}

export function recordMediaFailure(db, { messageId, accountId, groupId, status = "failed", error = "media unavailable" }) {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT status FROM media WHERE message_id=?").get(Number(messageId));
  if (existing?.status === "ready") return false;
  db.prepare(`INSERT INTO media(id,message_id,account_id,group_id,path,mime,bytes,sha256,status,error,created_at,updated_at)
    VALUES(?,?,?,?,?,?,NULL,NULL,?,?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=excluded.updated_at
    WHERE media.status != 'ready'`).run(crypto.randomUUID(), Number(messageId), accountId, groupId, "", null,
      status, String(error).slice(0, 1000), now, now);
  return true;
}

export function enqueueMediaFetchTask(db, { accountId, groupId, messageId, sourceMd5 = null, promptText = null }) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO media_fetch_tasks(task_id,account_id,group_id,message_id,source_md5,prompt_text,status,attempts,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'queued',0,?,?)
    ON CONFLICT(account_id,group_id,message_id) DO UPDATE SET
      source_md5=COALESCE(excluded.source_md5,media_fetch_tasks.source_md5),
      prompt_text=COALESCE(excluded.prompt_text,media_fetch_tasks.prompt_text),
      status='queued', attempts=0, claimed_at=NULL, error=NULL,
      updated_at=excluded.updated_at
    WHERE media_fetch_tasks.status IN ('failed','timeout')`)
    .run(id, accountId, groupId, Number(messageId), sourceMd5 ? String(sourceMd5).toLowerCase() : null,
      promptText ? String(promptText).slice(0, 2000) : null, now, now);
  return db.prepare("SELECT * FROM media_fetch_tasks WHERE account_id=? AND group_id=? AND message_id=?")
    .get(accountId, groupId, Number(messageId));
}

export function waitForMediaTask(db, taskId, timeoutMs = 60000, intervalMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const row = db.prepare("SELECT * FROM media_fetch_tasks WHERE task_id=?").get(taskId);
    if (row && ["ready", "failed", "timeout"].includes(row.status)) return row;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  const row = db.prepare("SELECT * FROM media_fetch_tasks WHERE task_id=?").get(taskId);
  if (row && row.status === "queued") db.prepare("UPDATE media_fetch_tasks SET status='timeout',error=? WHERE task_id=? AND status='queued'").run("media fetch wait timed out", taskId);
  return db.prepare("SELECT * FROM media_fetch_tasks WHERE task_id=?").get(taskId);
}

export function resolveMediaForMessage(db, { accountId, groupId, messageId, mediaRoot = DEFAULT_MEDIA_ROOT, cacheRoots = [] }) {
  let row = db.prepare(`SELECT * FROM media WHERE account_id=? AND group_id=? AND message_id=?`)
    .get(accountId, groupId, Number(messageId));
  if ((!row || row.status !== "ready") && cacheRoots.length > 0) {
    const msg = db.prepare("SELECT content_raw FROM messages WHERE id=?").get(Number(messageId));
    const md5 = imageMd5FromContent(msg?.content_raw);
    const cached = md5 ? findCachedMediaByMd5(md5, cacheRoots) : null;
    if (cached) {
      try {
        const ext = sniffMime(fs.readFileSync(cached));
        const suffix = ext === "image/jpeg" ? ".jpg" : ext === "image/png" ? ".png" : ext === "image/gif" ? ".gif" : ".webp";
        const dest = path.join(path.resolve(mediaRoot), `${Number(messageId)}${suffix}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(cached, dest);
        const registered = registerMedia(db, { messageId: Number(messageId), accountId, groupId, filePath: dest, mediaRoot });
        if (registered.ok) row = db.prepare(`SELECT * FROM media WHERE message_id=?`).get(Number(messageId));
      } catch { /* explicit failure below */ }
    }
  }
  if (!row) return { ok: false, error: "no decoded media for this exact message" };
  if (row.status !== "ready") return { ok: false, error: `media status is ${row.status}` };
  const root = path.resolve(mediaRoot);
  const abs = path.isAbsolute(row.path) ? path.resolve(row.path) : path.resolve(root, row.path);
  if (!(abs === root || abs.startsWith(root + path.sep))) return { ok: false, error: "stored media path is outside the configured root" };
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return { ok: false, error: `media read failed: ${e.message}` }; }
  const mime = sniffMime(buf);
  if (!mime) return { ok: false, error: "stored media is not a supported image" };
  if (row.mime && row.mime !== mime) return { ok: false, error: "stored media MIME mismatch" };
  if (row.sha256 && crypto.createHash("sha256").update(buf).digest("hex") !== row.sha256) return { ok: false, error: "stored media hash mismatch" };
  return { ok: true, message_id: Number(row.message_id), mime, bytes: buf.length, data: buf.toString("base64") };
}

export function resolveChatImages(db, req, { mediaRoot = DEFAULT_MEDIA_ROOT, maxImages = 2, recentLookbackSeconds = 600, cacheRoots = [] } = {}) {
  const targets = [];
  const source = db.prepare("SELECT id,msg_type,content_text,sender_id,sender_display FROM messages WHERE id=?").get(req.source_message_id);
  if (!source) return { targets, images: [], failures: [{ message_id: req.source_message_id, role: "current", error: "source message missing" }] };
  const sourceIsImage = [3, 47].includes(Number(source.msg_type) & 0xffff);
  if (sourceIsImage) targets.push({ message_id: Number(source.id), role: "current", sender_id: source.sender_id, sender_name: source.sender_display });
  let quote = null;
  try { quote = JSON.parse(req.source_json || "{}").quote || null; } catch {}
  if (quote) {
    let qrow = null;
    if (quote.quoted_local_id) qrow = db.prepare("SELECT id,msg_type,sender_id,sender_display FROM messages WHERE account_id=? AND group_id=? AND local_id=?").get(req.account_id, req.group_id, String(quote.quoted_local_id));
    if (!qrow && quote.quoted_server_id) qrow = db.prepare("SELECT id,msg_type,sender_id,sender_display FROM messages WHERE account_id=? AND group_id=? AND server_id=?").get(req.account_id, req.group_id, String(quote.quoted_server_id));
    if (qrow && [3, 47].includes(Number(qrow.msg_type) & 0xffff)) targets.push({ message_id: Number(qrow.id), role: "quoted", sender_id: qrow.sender_id, sender_name: qrow.sender_display });
  }
  const explicit = targets.length > 0;
  // No explicit image/quote: only a unique recent image from the same sender
  // and group is eligible. Never take another member's last image.
  if (!explicit) {
    const current = db.prepare("SELECT create_time FROM messages WHERE id=?").get(req.source_message_id);
    const cutoff = current ? Number(current.create_time) - Number(recentLookbackSeconds) : 0;
    const candidates = db.prepare(`SELECT id,msg_type,sender_id,sender_display,create_time FROM messages
      WHERE account_id=? AND group_id=? AND id<? AND create_time>=? AND sender_id=?
      AND (msg_type & 65535) IN (3,47) ORDER BY create_time DESC LIMIT 5`)
      .all(req.account_id, req.group_id, req.source_message_id, cutoff, req.sender_id);
    if (candidates.length === 1) {
      const c = candidates[0];
      targets.push({ message_id: Number(c.id), role: "recent", sender_id: c.sender_id, sender_name: c.sender_display });
    } else if (candidates.length > 1) {
      return { targets: [], images: [], failures: [{ role: "recent", error: `multiple recent images (${candidates.length}); ask the user to quote one`, candidates: candidates.map((c) => Number(c.id)) }] };
    }
  }
  const seen = new Set(); const unique = [];
  for (const t of targets) { if (!seen.has(t.message_id) && unique.length < maxImages) { seen.add(t.message_id); unique.push(t); } }
  const images = [], failures = [];
  for (const t of unique) {
    const got = resolveMediaForMessage(db, { accountId: req.account_id, groupId: req.group_id, messageId: t.message_id, mediaRoot, cacheRoots });
    if (got.ok) images.push({ ...t, mime: got.mime, bytes: got.bytes, data: got.data });
    else failures.push({ ...t, error: got.error });
  }
  return { targets: unique, images, failures };
}

export function buildPromptContentBlocks(prompt, images = []) {
  return [{ type: "text", text: prompt }, ...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType || i.mime }))];
}
