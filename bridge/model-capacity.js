/** Cross-process bounded model slots. One slot is reserved for chat. */
export function ensureModelCapacity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS model_slots (
    token TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at INTEGER NOT NULL
  );`);
}
function slots(db) { db.prepare("DELETE FROM model_slots WHERE expires_at < ?").run(Date.now()); return db.prepare("SELECT token,kind FROM model_slots").all(); }
export async function acquireModelSlot(db, kind, maxConcurrency = 4) {
  ensureModelCapacity(db);
  const owner = `${kind}:${process.pid}:${Math.random().toString(36).slice(2)}`;
  const total = Math.max(1, Number(maxConcurrency || 4));
  const limit = kind === "chat" ? total : Math.max(1, total - 1);
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = slots(db);
      if (current.length < limit) {
        db.prepare("INSERT INTO model_slots(token,kind,expires_at) VALUES(?,?,?)")
          .run(owner, kind, Date.now() + 300000);
        db.exec("COMMIT");
        return owner;
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    await new Promise((r) => setTimeout(r, 100));
  }
}
export function releaseModelSlot(db, token) {
  try { db.prepare("DELETE FROM model_slots WHERE token=?").run(token); } catch {}
}
