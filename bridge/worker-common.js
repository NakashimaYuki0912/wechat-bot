/** Shared atomic claim/lease helpers for independent chat and summary workers. */
export const WORKER_CHAT = "chat";
export const WORKER_SUMMARY = "summary";
export const WORKER_ALL = "all";

export function ensureWorkerColumns(db) {
  const cols = db.prepare("PRAGMA table_info(agent_requests)").all().map((r) => r.name);
  for (const [name, type] of [
    ["claim_owner", "TEXT"], ["claim_token", "TEXT"], ["lease_expires_at", "INTEGER"],
  ]) if (!cols.includes(name)) db.exec(`ALTER TABLE agent_requests ADD COLUMN ${name} ${type}`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_agent_claim ON agent_requests(status, request_type, queued_at)");
}

export function allowedTypes(kind) {
  if (kind === WORKER_SUMMARY) return ["summary"];
  if (kind === WORKER_CHAT) return ["chat", "memory"];
  return ["chat", "memory", "summary"];
}

/** Mark only expired owned leases uncertain. Never touch another live worker. */
export function recoverExpiredClaims(db, kind = WORKER_ALL) {
  const types = allowedTypes(kind);
  const ph = types.map(() => "?").join(",");
  const now = Date.now();
  const rows = db.prepare(`SELECT request_id FROM agent_requests
    WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
      AND COALESCE(request_type,'chat') IN (${ph})`).all(now, ...types);
  if (!rows.length) return 0;
  const stmt = db.prepare(`UPDATE agent_requests SET status='uncertain', finished_at=?,
    error='worker lease expired; result not retried automatically',
    cancel_state='lease_expired' WHERE request_id=? AND status='running'
      AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`);
  db.exec("BEGIN IMMEDIATE");
  try { for (const r of rows) stmt.run(new Date().toISOString(), r.request_id, now); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
  return rows.length;
}

export function claimRequest(db, { kind = WORKER_ALL, owner, leaseMs = 3600000 } = {}) {
  const types = allowedTypes(kind);
  const ph = types.map(() => "?").join(",");
  const now = Date.now();
  const token = `${owner}:${now}:${Math.random().toString(36).slice(2)}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`SELECT * FROM agent_requests
      WHERE status='queued' AND COALESCE(request_type,'chat') IN (${ph})
      ORDER BY queued_at ASC LIMIT 1`).get(...types);
    if (!row) { db.exec("COMMIT"); return null; }
    const n = db.prepare(`UPDATE agent_requests SET status='running', started_at=?,
      claim_owner=?, claim_token=?, lease_expires_at=?
      WHERE request_id=? AND status='queued'`).run(
      new Date().toISOString(), owner, token, now + leaseMs, row.request_id).changes;
    if (n !== 1) { db.exec("COMMIT"); return null; }
    db.exec("COMMIT");
    return { ...row, claim_owner: owner, claim_token: token, lease_expires_at: now + leaseMs };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

export function renewClaim(db, requestId, token, leaseMs = 3600000) {
  return db.prepare(`UPDATE agent_requests SET lease_expires_at=?
    WHERE request_id=? AND status='running' AND claim_token=?`)
    .run(Date.now() + leaseMs, requestId, token).changes === 1;
}
