/** Dependency-aware recovery for summary merge nodes. */
import crypto from "node:crypto";
import { dedupeFacts, planMergeGroups, summaryFactId } from "./summary-pipeline.js";

export function publicFact(f) {
  const { _fact_id, _nodes, ...rest } = f;
  return rest;
}
export function factsHash(facts) {
  return crypto.createHash("sha256").update(JSON.stringify(facts.map(publicFact))).digest("hex");
}
export function reconstructMergeInput(db, { requestId, index, mergeMaxFacts = 8, mergeMaxChars = 30000 } = {}) {
  const node = db.prepare("SELECT * FROM summary_batches WHERE request_id=? AND level=1 AND batch_index=?").get(requestId, index);
  if (!node) return { ok: false, error: "merge node missing" };
  const level0 = db.prepare("SELECT level,batch_index,output_json FROM summary_batches WHERE request_id=? AND level=0 AND status='succeeded' ORDER BY batch_index").all(requestId);
  const raw = [];
  for (const r of level0) {
    try {
      const fs = JSON.parse(r.output_json).facts || [];
      raw.push(...fs.map((f) => ({ ...f, _fact_id: summaryFactId(f), _nodes: [`L0-i${r.batch_index}`] })));
    } catch {}
  }
  const facts = dedupeFacts(raw);
  const groups = planMergeGroups(facts, { maxFacts: mergeMaxFacts, maxChars: mergeMaxChars });
  const group = groups[index];
  if (!group) return { ok: false, error: `merge group ${index} not reconstructable` };
  if (node.input_fact_refs_json && node.dependency_status) {
    const refs = JSON.parse(node.input_fact_refs_json);
    const byId = new Map(facts.map((f) => [f._fact_id, f]));
    const exact = refs.map((id) => byId.get(id));
    if (exact.every(Boolean)) {
      const h = factsHash(exact);
      if (node.input_hash && h !== node.input_hash) return { ok: false, error: "stored input hash mismatch" };
      return { ok: true, status: node.dependency_status, facts: exact, fact_refs: refs,
        input_nodes: JSON.parse(node.input_nodes_json || "[]"), input_hash: h, prompt_version: node.prompt_version || "summary-merge-v1", node };
    }
    return { ok: false, error: "stored input references are incomplete" };
  }
  // Historical node: reconstruct from the original level-0 plan and record this
  // as reconstructed, never as exact stored input.
  const inputNodes = [...new Set(group.flatMap((f) => f._nodes || []))];
  const refs = group.map((f) => f._fact_id);
  const hash = factsHash(group);
  return { ok: true, status: "reconstructed", facts: group, fact_refs: refs,
    input_nodes: inputNodes, input_hash: hash, prompt_version: "summary-merge-v1", node };
}

export function persistMergeInput(db, { requestId, index, input }) {
  db.prepare(`UPDATE summary_batches SET input_nodes_json=?, input_fact_refs_json=?, input_hash=?,
    prompt_version=?, dependency_status=? WHERE request_id=? AND level=1 AND batch_index=?`)
    .run(JSON.stringify(input.input_nodes), JSON.stringify(input.fact_refs), input.input_hash,
      input.prompt_version, input.status, requestId, index);
}
