import crypto from "node:crypto";
export function ensureUiLock(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ui_operation_lock (
    id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires_at INTEGER
  );`);
}
export function acquireUiLock(db, owner, timeoutMs = 30000) {
  ensureUiLock(db);
  const end = Date.now() + timeoutMs;
  const token = `${owner}:${process.pid}:${crypto.randomUUID()}`;
  while (Date.now() < end) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT owner,expires_at FROM ui_operation_lock WHERE id=1").get();
      if (!row || !row.expires_at || row.expires_at < Date.now()) {
        db.prepare("INSERT INTO ui_operation_lock(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at")
          .run(token, Date.now() + timeoutMs);
        db.exec("COMMIT");
        return token;
      }
      db.exec("COMMIT");
    } catch { try { db.exec("ROLLBACK"); } catch {} }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  throw new Error("UI operation lock timeout");
}
export function releaseUiLock(db, token) {
  try { db.prepare("DELETE FROM ui_operation_lock WHERE id=1 AND owner=?").run(token); } catch {}
}
