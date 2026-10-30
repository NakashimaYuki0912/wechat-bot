#!/usr/bin/env node
/** Bounded batch + layered merge + persistence test. Fake SDK only; no model/network. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureSummaryBatches, planSummaryBatches, runSummaryPipeline } from "../bridge/summary-pipeline.js";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "work", "summary-pipeline-test");
fs.mkdirSync(DIR, { recursive: true });
const db = new DatabaseSync(":memory:");
ensureSummaryBatches(db);
const messages = Array.from({ length: 95 }, (_, i) => ({
  msg_id: 1000 + i, local_id: String(i + 1), time: new Date(1792944000000 + i * 60000).toISOString(),
  sender_id: i % 2 ? "s1" : "s2", sender_label: i % 2 ? "甲" : "乙", is_text: true,
  text: `第 ${i} 条消息，讨论主题 ${i % 7}`, msg_type: 1, quote: null,
}));
const plan = planSummaryBatches(messages, { maxMessages: 10, maxChars: 4000, maxTokens: 1500 });
const req = { request_id: "summary-pipeline-test", range_start: 1792944000000, range_end: 1793030399000 };
const cfg = { summary: {
  batch_max_tokens: 512, batch_timeout_ms: 5000, batch_reasoning_effort: "low",
  merge_max_tokens: 512, merge_max_facts: 2, merge_max_chars: 5000, merge_reasoning_effort: "low",
} };
let calls = 0;
const fakeSdk = async ({ prompt }) => {
  calls += 1;
  const ids = [...String(prompt).matchAll(/"msg_id"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  const id = ids[0] ?? 1000;
  return { status: "succeeded", finish_reason: "completed", text: JSON.stringify({ facts: [{ topic: "合成主题", text: `合成事实 ${id}`, member_ids: [], source_message_ids: [id] }], limitations: [] }) };
};
const coverage = {};
const first = await runSummaryPipeline({ db, req, cfg, source: { messages }, plan, coverage, runSdk: fakeSdk });
const firstCalls = calls;
const secondCoverage = {};
const second = await runSummaryPipeline({ db, req, cfg, source: { messages }, plan, coverage: secondCoverage, runSdk: fakeSdk });
const batchRows = db.prepare("SELECT level,batch_index,status FROM summary_batches ORDER BY level,batch_index").all();
const checks = {
  batch_count: plan.batches.length === 10,
  all_messages_in_batches: plan.batches.reduce((n, b) => n + b.messages.length, 0) === 95,
  first_ok: first.ok === true,
  merged_to_bound: first.facts?.length <= 2,
  layered: (first.coverage?.merge_total ?? 0) > 0,
  persisted: batchRows.some((r) => r.level === 0 && r.status === "succeeded") && batchRows.some((r) => r.level > 0 && r.status === "succeeded"),
  successful_not_recalled: second.ok === true && calls === firstCalls,
};
// A failed max-tokens parent must split, keep the parent row, and cover every
// message exactly once through disjoint successful children.
const db2 = new DatabaseSync(":memory:");
ensureSummaryBatches(db2);
const plan2 = planSummaryBatches(messages, { maxMessages: 10, maxChars: 4000, maxTokens: 1500 });
let failedOnce = false;
let splitCalls = 0;
const splitSdk = async ({ prompt }) => {
  splitCalls += 1;
  if (!failedOnce && String(prompt).includes('"msg_id":1000')) {
    failedOnce = true;
    return { status: "succeeded", finish_reason: "max-tokens", text: "" };
  }
  const ids = [...String(prompt).matchAll(/"msg_id"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  const id = ids[0] ?? 1000;
  return { status: "succeeded", finish_reason: "completed", text: JSON.stringify({ facts: [{ topic: "合成主题", text: `合成事实 ${id}`, member_ids: [], source_message_ids: [id] }], limitations: [] }) };
};
const splitCoverage = {};
const split = await runSummaryPipeline({ db: db2, req: { request_id: "summary-split-test", range_start: 1792944000000, range_end: 1793030399000 }, cfg, source: { messages }, plan: plan2, coverage: splitCoverage, runSdk: splitSdk });
const splitRows = db2.prepare("SELECT level,batch_index,status,parent_level,parent_index,split_depth FROM summary_batches ORDER BY level,batch_index").all();
const splitChecks = {
  split_ok: split.ok === true,
  parent_failed_trace: splitRows.some((r) => r.level === 0 && r.batch_index === 0 && r.status === "failed"),
  children_trace: splitRows.some((r) => r.level === 0 && r.status === "succeeded" && r.parent_index === 0 && r.split_depth === 1),
  all_messages_covered: split.coverage?.covered_messages === 95 && (split.coverage?.missing_message_ids || []).length === 0,
  no_silent_success_on_failure: splitRows.find((r) => r.batch_index === 0)?.status === "failed",
};
const result = { passed: Object.values(checks).every(Boolean) && Object.values(splitChecks).every(Boolean), checks, splitChecks, calls: firstCalls, second_calls: calls, split_calls: splitCalls, batches: batchRows, splitBatches: splitRows, first_coverage: first.coverage, split_coverage: split.coverage, stderr: "" };
fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
db.close();
process.exit(result.passed ? 0 : 1);
