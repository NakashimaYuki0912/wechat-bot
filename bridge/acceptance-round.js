/** Persistent acceptance-round call limit. One reservation per attempted model
 * call, including failures/uncertainty. No model/network access here. */
function nowIso() { return new Date().toISOString(); }

export function ensureRound(db, cfg) {
  db.exec(`CREATE TABLE IF NOT EXISTS acceptance_round (
    id TEXT PRIMARY KEY, total_limit INTEGER NOT NULL, chat_limit INTEGER NOT NULL,
    summary_limit INTEGER NOT NULL, total_used INTEGER NOT NULL DEFAULT 0,
    chat_used INTEGER NOT NULL DEFAULT 0, summary_used INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
  )`);
  const spec = cfg.acceptance_round;
  if (!spec || !spec.id) return null;
  const existing = db.prepare("SELECT * FROM acceptance_round WHERE id=?").get(spec.id);
  if (existing) {
    db.prepare("UPDATE acceptance_round SET total_limit=?, chat_limit=?, summary_limit=? WHERE id=?")
      .run(Number(spec.total_limit), Number(spec.chat_limit), Number(spec.summary_limit), spec.id);
  } else {
    db.prepare(`INSERT INTO acceptance_round(id,total_limit,chat_limit,summary_limit,total_used,chat_used,summary_used,started_at,status)
      VALUES(?,?,?,?,0,0,0,?,'open')`)
      .run(spec.id, Number(spec.total_limit), Number(spec.chat_limit), Number(spec.summary_limit), nowIso());
  }
  return spec.id;
}

export function reserveRound(db, cfg, type) {
  if (cfg.limits?.enforce_acceptance_round === false) return { ok: true, disabled: true };
  const id = cfg.acceptance_round?.id;
  if (!id) return { ok: true, skipped: true };
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM acceptance_round WHERE id=?").get(id);
    if (!row) { db.exec("COMMIT"); return { ok: false, reason: "acceptance round missing" }; }
    if (row.status !== "open" || row.total_used >= row.total_limit
      || (type === "chat" && row.chat_used >= row.chat_limit)
      || (type === "summary" && row.summary_used >= row.summary_limit)) {
      db.exec("COMMIT");
      return { ok: false, reason: `acceptance round exhausted id=${id} type=${type} total=${row.total_used}/${row.total_limit} chat=${row.chat_used}/${row.chat_limit} summary=${row.summary_used}/${row.summary_limit}` };
    }
    const total = row.total_used + 1;
    const chat = row.chat_used + (type === "chat" ? 1 : 0);
    const summary = row.summary_used + (type === "summary" ? 1 : 0);
    const status = total >= row.total_limit ? "exhausted" : "open";
    db.prepare(`UPDATE acceptance_round SET total_used=?, chat_used=?, summary_used=?, status=? WHERE id=?`)
      .run(total, chat, summary, status, id);
    db.exec("COMMIT");
    return { ok: true, round_id: id, total_used: total, chat_used: chat, summary_used: summary, status };
  } catch (e) {
    db.exec("ROLLBACK");
    return { ok: false, reason: String(e) };
  }
}

export function releaseRound(db, cfg, type) {
  if (cfg.limits?.enforce_acceptance_round === false) return;
  const id = cfg.acceptance_round?.id;
  if (!id) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM acceptance_round WHERE id=?").get(id);
    if (!row) { db.exec("COMMIT"); return; }
    db.prepare(`UPDATE acceptance_round SET total_used=MAX(0,total_used-1),
      chat_used=MAX(0,chat_used-?), summary_used=MAX(0,summary_used-?),
      status='open' WHERE id=?`)
      .run(type === "chat" ? 1 : 0, type === "summary" ? 1 : 0, id);
    db.exec("COMMIT");
  } catch { db.exec("ROLLBACK"); }
}

export function roundStatus(db, id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM acceptance_round WHERE id=?").get(id) || null;
}
