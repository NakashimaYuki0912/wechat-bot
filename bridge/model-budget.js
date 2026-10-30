/** Persistent model-call budget. Reservations are conservative: consumed even
 * if the provider outcome is uncertain. No model or network access here. */
function nowIso() { return new Date().toISOString(); }

export function ensureBudget(db, cfg) {
  db.exec(`CREATE TABLE IF NOT EXISTS model_budget (
    type TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0,
    limit_value INTEGER NOT NULL, updated_at TEXT NOT NULL
  )`);
  const limits = cfg.model_budget || {};
  const now = nowIso();
  for (const type of ["chat", "summary"]) {
    const raw = limits[type];
    const limit = raw === null ? -1 : Number(raw ?? (type === "chat" ? 10 : 5));
    const existing = db.prepare("SELECT * FROM model_budget WHERE type=?").get(type);
    if (existing) {
      db.prepare("UPDATE model_budget SET limit_value=?, updated_at=? WHERE type=?").run(limit, now, type);
    } else {
      const used = type === "chat"
        ? db.prepare("SELECT count(*) n FROM agent_requests WHERE COALESCE(request_type,'chat')='chat' AND status IN ('succeeded','uncertain','failed','running')").get().n
        : 0;
      db.prepare("INSERT INTO model_budget(type,used,limit_value,updated_at) VALUES(?,?,?,?)")
        .run(type, used, limit, now);
    }
  }
}

export function reserveBudget(db, type, cfg) {
  if (cfg.limits?.enforce_model_budget === false) return { ok: true, disabled: true };
  const row = db.prepare("SELECT * FROM model_budget WHERE type=?").get(type);
  if (!row) return { ok: false, reason: "budget row missing" };
  db.exec("BEGIN IMMEDIATE");
  try {
    const cur = db.prepare("SELECT used,limit_value FROM model_budget WHERE type=?").get(type);
    if (cur.limit_value >= 0 && cur.used >= cur.limit_value) {
      db.exec("COMMIT");
      return { ok: false, reason: `model budget exhausted type=${type} used=${cur.used} limit=${cur.limit_value}` };
    }
    db.prepare("UPDATE model_budget SET used=used+1, updated_at=? WHERE type=?").run(nowIso(), type);
    db.exec("COMMIT");
    return { ok: true, used: cur.used + 1, limit: cur.limit_value };
  } catch (e) {
    db.exec("ROLLBACK");
    return { ok: false, reason: String(e) };
  }
}
