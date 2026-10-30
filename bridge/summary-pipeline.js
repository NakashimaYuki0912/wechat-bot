import crypto from "node:crypto";
/**
 * Bounded, persistent summary pipeline.
 *
 * Level 0: split the complete message set into bounded batches, extract facts
 * per batch. Higher levels: merge bounded groups of facts. Every level has a
 * byte/token budget and every successful batch is persisted before the next
 * call. The final group text is rendered by program code, never by a model.
 */

export function summaryFactId(fact) {
  return "F-" + crypto.createHash("sha256")
    .update(`${fact.topic || ""}\u0000${fact.text}\u0000${(fact.source_message_ids || []).slice().sort((a, b) => a - b).join(",")}`)
    .digest("hex").slice(0, 8);
}

export function estimateSummaryTokens(text) {
  // The observed batch prompt was ~6.5k chars and used ~3.4k input tokens.
  // Keep a deliberately conservative estimate for planning.
  return Math.max(1, Math.ceil(Array.from(String(text ?? "")).length / 2));
}

export function planSummaryBatches(messages, options = {}) {
  const maxMessages = Math.max(1, Number(options.maxMessages ?? 40));
  const maxChars = Math.max(2000, Number(options.maxChars ?? 24000));
  const maxTokens = Math.max(500, Number(options.maxTokens ?? 8000));
  const compact = (m) => ({
    msg_id: Number(m.msg_id), time: m.time, sender_id: m.sender_id, name: m.sender_label,
    type: m.is_text ? "text" : "nontext", text: m.is_text ? String(m.text ?? "") : "[非文本消息，程序未解析]",
    quote: m.quote ? { unresolved: Boolean(m.quote.unresolved), content: m.is_text ? String(m.quote.content ?? "").slice(0, 200) : null } : null,
  });
  const batches = [];
  let current = [];
  let currentChars = 2;
  let chunked = 0;
  const flush = () => {
    if (!current.length) return;
    batches.push({ index: batches.length, messages: current, chars: currentChars, estimatedTokens: Math.ceil(currentChars / 3) });
    current = []; currentChars = 2;
  };
  for (const original of messages) {
    const base = compact(original);
    const json = JSON.stringify(base);
    // A single oversized message is split, never silently dropped. All parts
    // keep the original msg_id, so provenance remains exact.
    if (json.length > maxChars) {
      const textChars = Array.from(base.text);
      const room = Math.max(500, maxChars - 800);
      for (let offset = 0, part = 0; offset < textChars.length; offset += room, part += 1) {
        const piece = { ...base, text: textChars.slice(offset, offset + room).join(""), part, parts: Math.ceil(textChars.length / room) };
        const pjson = JSON.stringify(piece);
        if (current.length) flush();
        current.push(piece); currentChars += pjson.length + 1;
        // Leave the piece alone and force a flush if it is still above budget.
        if (pjson.length + 2 >= maxChars || current.length >= maxMessages) flush();
      }
      chunked += 1;
      continue;
    }
    if (current.length && (current.length >= maxMessages || currentChars + json.length + 1 > maxChars
      || Math.ceil((currentChars + json.length + 1) / 3) > maxTokens)) flush();
    current.push(base);
    currentChars += json.length + 1;
  }
  flush();
  return {
    batches,
    chunkedCount: chunked,
    totalMessages: messages.length,
    totalChars: batches.reduce((n, b) => n + b.chars, 0),
    totalEstimatedTokens: batches.reduce((n, b) => n + b.estimatedTokens, 0),
  };
}

export function buildBatchPrompt(batch, { startMs, endMs, batchNumber, batchTotal }) {
  return `[SUMMARY_BATCH] 你是微信群聊天的事实提取器。只处理这一批消息，不要写总览，不要使用外部知识。\n`
    + `时间范围：${new Date(startMs).toISOString()} 至 ${new Date(endMs).toISOString()}（Asia/Shanghai）。批次 ${batchNumber}/${batchTotal}。\n`
    + `只输出严格 JSON：{"facts":[{"topic":"短主题名","text":"谁在什么时间讨论了什么，结论/待办/分歧","member_ids":["sender_id"],"source_message_ids":[id]}],"limitations":["本批限制"]}\n`
    + `每个事实必须引用至少一个本批消息 id；member_ids 只能填该事实来源消息的作者；不得编造来源、版本、功能或“已查证”。\n`
    + `纯寒暄、测试编号、重复内容可合并；非文本消息只写“未解析”，不要猜内容。\n`
    + `批次消息 JSON：\n${JSON.stringify(batch.messages)}\n`;
}

export function buildMergePrompt(facts, { level = 1 } = {}) {
  const publicFacts = facts.map(({ _fact_id, _nodes, ...rest }) => rest);
  return `[SUMMARY_MERGE] 你是群总结的分层归并器。只合并下面已有事实，不新增事实、不新增来源、不写总览。\n`
    + `第 ${level} 层；输出严格 JSON：{"facts":[{"topic":"短主题名","text":"合并后的讨论/结论/待办/分歧","member_ids":["sender_id"],"source_message_ids":[id]}],"limitations":["归并限制"]}\n`
    + `最多输出 8 个合并事实；每条 text 控制在 250–350 字；合并同主题、去除重复，不要逐条复述全部输入，也不要为凑长度丢弃重要事实。\n`
    + `来源 ID、成员身份和引用关系已经由程序校验；不要花输出预算反复核验或重述全部 ID，只保留必要代表来源。不得把群成员说法当成客观事实。\n`
    + `已有事实 JSON：\n${JSON.stringify(publicFacts)}\n`;
}

export function validateFacts(text, allowedMessages) {
  let value;
  try { value = JSON.parse(String(text ?? "").trim()); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "root is not an object" };
  if (!Array.isArray(value.facts) || value.facts.length === 0) return { ok: false, error: "facts must be a non-empty array" };
  if (value.facts.length > 12) return { ok: false, error: "too many facts" };
  const allowedIds = new Set(allowedMessages.map((m) => Number(m.msg_id)));
  const allowedSenders = new Set(allowedMessages.map((m) => m.sender_id).filter(Boolean));
  const byId = new Map(allowedMessages.map((m) => [Number(m.msg_id), m]));
  const facts = [];
  let filteredMembers = 0;
  for (const [i, f] of value.facts.entries()) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, error: `fact ${i} is not an object` };
    if (typeof f.text !== "string" || !f.text.trim() || f.text.length > 1200) return { ok: false, error: `fact ${i} text invalid` };
    if (f.topic !== undefined && (typeof f.topic !== "string" || !f.topic.trim() || f.topic.length > 80)) return { ok: false, error: `fact ${i} topic invalid` };
    if (!Array.isArray(f.source_message_ids) || f.source_message_ids.length === 0) return { ok: false, error: `fact ${i} has no source ids` };
    const ids = [];
    for (const raw of f.source_message_ids) {
      const id = Number(raw);
      if (!Number.isSafeInteger(id) || !allowedIds.has(id)) return { ok: false, error: `fact ${i} unknown source id ${raw}` };
      if (!ids.includes(id)) ids.push(id);
    }
    const authors = new Set(ids.map((id) => byId.get(id)?.sender_id).filter(Boolean));
    const memberIds = [];
    if (f.member_ids !== undefined) {
      if (!Array.isArray(f.member_ids)) return { ok: false, error: `fact ${i} member_ids invalid` };
      for (const id of f.member_ids) {
        if (typeof id !== "string") return { ok: false, error: `fact ${i} member id not a string` };
        if (!allowedSenders.has(id) || !authors.has(id)) { filteredMembers += 1; continue; }
        if (!memberIds.includes(id)) memberIds.push(id);
      }
    }
    facts.push({ topic: f.topic?.trim() || null, text: f.text.trim(), member_ids: memberIds, source_message_ids: ids });
  }
  const limitations = Array.isArray(value.limitations)
    ? value.limitations.filter((x) => typeof x === "string" && x.trim()).slice(0, 12).map((x) => x.trim()) : [];
  if (filteredMembers) limitations.push("部分事实的成员标记与来源作者不一致，已剔除。");
  return { ok: true, facts, limitations };
}

export function dedupeFacts(facts) {
  const out = [];
  const seen = new Map();
  for (const f of facts) {
    const key = `${(f.topic || "").trim().toLowerCase()}|${f.text.trim().toLowerCase()}`;
    const prior = seen.get(key);
    if (!prior) {
      const copy = { topic: f.topic || null, text: f.text, member_ids: [...new Set(f.member_ids || [])], source_message_ids: [...new Set(f.source_message_ids || [])],
        _fact_id: f._fact_id || summaryFactId(f), _nodes: [...new Set(f._nodes || [])] };
      seen.set(key, copy); out.push(copy); continue;
    }
    prior.member_ids = [...new Set([...prior.member_ids, ...(f.member_ids || [])])];
    prior.source_message_ids = [...new Set([...prior.source_message_ids, ...(f.source_message_ids || [])])];
    prior._nodes = [...new Set([...(prior._nodes || []), ...(f._nodes || [])])];
  }
  return out;
}

export function planMergeGroups(facts, { maxFacts = 24, maxChars = 30000 } = {}) {
  const groups = [];
  let current = [];
  let chars = 2;
  for (const f of facts) {
    const size = JSON.stringify(f).length + 1;
    if (current.length && (current.length >= maxFacts || chars + size > maxChars)) {
      groups.push(current); current = []; chars = 2;
    }
    current.push(f); chars += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

function shanghaiHour(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

function periodLabel(ms) {
  const h = shanghaiHour(ms);
  if (h < 6) return "凌晨";
  if (h < 12) return "上午";
  if (h < 18) return "下午";
  return "晚上";
}

function topicCategory(text) {
  const t = String(text || "");
  if (/比赛|对局|战队|选手|大龙|龙团|IG|HLE|G2|TheShy|AD|BP|比分|压|赛|局|第[一二三四五]把|BO3/i.test(t)) return "比赛与对局";
  if (/海斗|游戏|LOL|绝区零|影之刃|上线|开黑|玩|段位/.test(t)) return "游戏与开黑";
  if (/健身|增肌|羽毛球|工位|报告|学校|考试|投票|选举/.test(t)) return "工作学习与健身";
  if (/直播|抖音|KOOK|Kook|语音|解说|管泽元|开播/.test(t)) return "直播与语音";
  return "其他群聊";
}

function cleanTopicText(text) {
  return String(text || "")
    .replace(/\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/g, "")
    .replace(/\b\d{1,2}:\d{2}(?:\s*[-–—~至]\s*\d{1,2}:\d{2})?\b/g, "")
    .replace(/\d{1,2}月\d{1,2}日/g, "")
    .replace(/\d{1,2}点(?:\d{1,2}分)?(?:\s*[-–—~至]\s*\d{1,2}点(?:\d{1,2}分)?)?/g, "")
    .replace(/^[\s,，;；:：-]+|[\s,，;；:：-]+$/g, "");
}

/** Collapse minute-level facts into bounded topic segments for the group. */
export function condenseFactsForSummary(facts, source, { maxGroups = 8 } = {}) {
  const messages = Array.isArray(source?.messages) ? source.messages : [];
  const timeById = new Map(messages.map((m) => [Number(m.msg_id), Date.parse(m.time)]));
  const groups = new Map();
  for (const fact of Array.isArray(facts) ? facts : []) {
    const ids = Array.isArray(fact.source_message_ids) ? fact.source_message_ids.map(Number) : [];
    const times = ids.map((id) => timeById.get(id)).filter(Number.isFinite);
    const ms = times.length ? times[0] : null;
    const period = ms ? periodLabel(ms) : "时段";
    const category = topicCategory(`${fact.topic || ""} ${fact.text || ""}`);
    const key = `${period}\u0000${category}`;
    if (!groups.has(key)) groups.set(key, { period, category, facts: [], member_ids: new Set(), source_message_ids: new Set() });
    const g = groups.get(key); g.facts.push(fact);
    for (const m of fact.member_ids || []) g.member_ids.add(m);
    for (const id of ids) g.source_message_ids.add(id);
  }
  const ranked = [...groups.values()].sort((a, b) => b.facts.length - a.facts.length);
  const selected = ranked.slice(0, Math.max(1, maxGroups));
  const mergedOthers = ranked.slice(Math.max(1, maxGroups));
  if (mergedOthers.length) {
    const other = { period: "全时段", category: "其他群聊", facts: [], member_ids: new Set(), source_message_ids: new Set() };
    for (const g of mergedOthers) { other.facts.push(...g.facts); for (const m of g.member_ids) other.member_ids.add(m); for (const id of g.source_message_ids) other.source_message_ids.add(id); }
    selected.push(other);
  }
  return selected.map((g) => {
    const texts = [];
    for (const f of g.facts) {
      const text = cleanTopicText(f.text);
      if (text && !texts.some((x) => x.includes(text) || text.includes(x))) texts.push(text);
      if (texts.length >= 2) break;
    }
    const subject = g.period === "全时段" ? g.category : `${g.period}·${g.category}`;
    return {
      topic: subject,
      text: texts.join("；") + (g.facts.length > texts.length ? `；另有 ${g.facts.length - texts.length} 条同类讨论` : ""),
      member_ids: [...g.member_ids],
      source_message_ids: [...g.source_message_ids].sort((a, b) => a - b),
    };
  });
}

export function finalSummaryFromFacts(facts) {
  const topics = [...new Set(facts.map((f) => f.topic).filter(Boolean))].slice(0, 8);
  const overview = topics.length
    ? `本时段群内主要围绕${topics.join("、")}等话题展开。`
    : "本时段群内有一些零散交流。";
  return { summary: overview, points: facts, limitations: [] };
}

export function ensureSummaryBatches(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_batches (
      request_id TEXT NOT NULL, level INTEGER NOT NULL, batch_index INTEGER NOT NULL,
      status TEXT NOT NULL, input_kind TEXT, input_messages INTEGER,
      input_chars INTEGER, input_tokens_est INTEGER, message_ids_json TEXT,
      output_json TEXT, error TEXT, finish_reason TEXT,
      max_tokens INTEGER, reasoning_effort TEXT, input_bytes INTEGER,
      output_tokens INTEGER, parent_level INTEGER, parent_index INTEGER, split_depth INTEGER,
      input_nodes_json TEXT, input_fact_refs_json TEXT, input_hash TEXT, prompt_version TEXT, dependency_status TEXT,
      attempts INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      PRIMARY KEY(request_id, level, batch_index)
    );
    CREATE INDEX IF NOT EXISTS idx_summary_batches_request ON summary_batches(request_id, level, batch_index);
  `);
  const cols = db.prepare("PRAGMA table_info(summary_batches)").all().map((r) => r.name);
  for (const [col, typ] of [
    ["max_tokens", "INTEGER"], ["reasoning_effort", "TEXT"], ["input_bytes", "INTEGER"],
    ["output_tokens", "INTEGER"], ["parent_level", "INTEGER"], ["parent_index", "INTEGER"], ["split_depth", "INTEGER"],
    ["input_nodes_json", "TEXT"], ["input_fact_refs_json", "TEXT"], ["input_hash", "TEXT"],
    ["prompt_version", "TEXT"], ["dependency_status", "TEXT"],
  ]) if (!cols.includes(col)) db.exec(`ALTER TABLE summary_batches ADD COLUMN ${col} ${typ}`);
}

function nowIso() { return new Date().toISOString(); }

function rowsAttempted(db, requestId, level) {
  return Number(db.prepare("SELECT count(*) n FROM summary_batches WHERE request_id=? AND level=?").get(requestId, level).n);
}

export async function runSummaryPipeline({ db, req, cfg, source, plan, coverage, runSdk, log = () => {} }) {
  ensureSummaryBatches(db);
  const summaryCfg = cfg.summary || {};
  // A retried summary request must not collide with DSH sessions left by a
  // previous process; the request id alone is not a session-run identity.
  const runNonce = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const batchMaxTokens = Number(summaryCfg.batch_max_tokens ?? 2048);
  const mergeMaxTokens = Number(summaryCfg.merge_max_tokens ?? 2048);
  const batchTimeout = Number(summaryCfg.batch_timeout_ms ?? summaryCfg.timeout_ms ?? 120000);
  const mergeTimeout = Number(summaryCfg.timeout_ms ?? 120000);
  const batchReasoning = summaryCfg.batch_reasoning_effort || "low";
  const mergeReasoning = summaryCfg.merge_reasoning_effort || "high";
  const mergeMaxFacts = Number(summaryCfg.merge_max_facts ?? 24);
  const mergeMaxChars = Number(summaryCfg.merge_max_chars ?? 30000);
  const getRow = db.prepare("SELECT * FROM summary_batches WHERE request_id=? AND level=? AND batch_index=?");
  const putRow = db.prepare(`INSERT INTO summary_batches
    (request_id,level,batch_index,status,input_kind,input_messages,input_chars,input_tokens_est,message_ids_json,output_json,error,finish_reason,max_tokens,reasoning_effort,input_bytes,output_tokens,parent_level,parent_index,split_depth,input_nodes_json,input_fact_refs_json,input_hash,prompt_version,dependency_status,attempts,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
    ON CONFLICT(request_id,level,batch_index) DO UPDATE SET
      status=excluded.status, input_kind=excluded.input_kind, input_messages=excluded.input_messages,
      input_chars=excluded.input_chars, input_tokens_est=excluded.input_tokens_est,
      message_ids_json=excluded.message_ids_json, output_json=excluded.output_json,
      error=excluded.error, finish_reason=excluded.finish_reason,
      max_tokens=excluded.max_tokens, reasoning_effort=excluded.reasoning_effort,
      input_bytes=excluded.input_bytes, output_tokens=excluded.output_tokens,
      parent_level=excluded.parent_level, parent_index=excluded.parent_index,
      split_depth=excluded.split_depth, input_nodes_json=excluded.input_nodes_json,
      input_fact_refs_json=excluded.input_fact_refs_json, input_hash=excluded.input_hash,
      prompt_version=excluded.prompt_version, dependency_status=excluded.dependency_status,
      updated_at=excluded.updated_at`);
  const updateCoverage = () => {
    const rows = db.prepare("SELECT level,status,count(*) n FROM summary_batches WHERE request_id=? GROUP BY level,status").all(req.request_id);
    coverage.batches = rows;
    coverage.batch_planned = plan.batches.length;
    coverage.batch_attempted = rows.filter((r) => r.level === 0).reduce((n, r) => n + Number(r.n), 0);
    coverage.batch_succeeded = rows.filter((r) => r.level === 0 && r.status === "succeeded").reduce((n, r) => n + Number(r.n), 0);
    coverage.batch_failed = rows.filter((r) => r.level === 0 && r.status === "failed").reduce((n, r) => n + Number(r.n), 0);
    coverage.merge_total = rows.filter((r) => r.level > 0).reduce((n, r) => n + Number(r.n), 0);
    coverage.merge_succeeded = rows.filter((r) => r.level > 0 && r.status === "succeeded").reduce((n, r) => n + Number(r.n), 0);
    coverage.merge_failed = rows.filter((r) => r.level > 0 && r.status === "failed").reduce((n, r) => n + Number(r.n), 0);
  };

  const runRow = async ({ level, index, prompt, maxTokens, timeout, reasoning, allowedMessages, inputKind, inputMessages, inputChars, inputTokens, messageIds, parentLevel = null, parentIndex = null, splitDepth = 0, inputNodes = [], inputFactRefs = [], promptVersion = "unknown", dependencyStatus = "exact" }) => {
    const existing = getRow.get(req.request_id, level, index);
    if (existing) {
      if (existing.status === "succeeded") {
        const v = validateFacts(existing.output_json, allowedMessages);
        if (v.ok) return { ok: true, facts: v.facts, cached: true };
        return { ok: false, error: `cached batch invalid: ${v.error}`, cached: true };
      }
      return { ok: false, error: existing.error || `batch status ${existing.status}`, cached: true };
    }
    const now = nowIso();
    putRow.run(req.request_id, level, index, "running", inputKind, inputMessages, inputChars, inputTokens,
      JSON.stringify(messageIds), null, null, null, maxTokens, reasoning, Buffer.byteLength(prompt), null,
      parentLevel, parentIndex, splitDepth,
      JSON.stringify(inputNodes), JSON.stringify(inputFactRefs), crypto.createHash("sha256").update(String(prompt)).digest("hex"),
      promptVersion, dependencyStatus, now);
    let result;
    try {
      result = await runSdk({
        prompt, sessionId: `summary-${req.request_id}-${runNonce}-l${level}-i${index}`,
        resume: false, maxTokens, timeoutMs: timeout, reasoningEffort: reasoning,
      });
    } catch (e) {
      result = { status: "uncertain", error: String(e), prompt_accepted: false };
    }
    const finish = result.finish_reason ?? null;
    if (result.status !== "succeeded" || finish === "max-tokens") {
      const error = finish === "max-tokens" ? "batch ended by max-tokens" : (result.error || `batch status ${result.status}`);
      putRow.run(req.request_id, level, index, "failed", inputKind, inputMessages, inputChars, inputTokens,
        JSON.stringify(messageIds), String(result.text ?? "").slice(0, 12000), error.slice(0, 2000), finish,
        maxTokens, reasoning, Buffer.byteLength(prompt), result.usage?.outputTokens ?? null,
        parentLevel, parentIndex, splitDepth,
        JSON.stringify(inputNodes), JSON.stringify(inputFactRefs), crypto.createHash("sha256").update(String(prompt)).digest("hex"),
        promptVersion, dependencyStatus, nowIso());
      log("warn", "summary batch failed", { request_id: req.request_id, level, index, error, finish });
      return { ok: false, error, finish, cached: false };
    }
    const validation = validateFacts(result.text, allowedMessages);
    if (!validation.ok) {
      putRow.run(req.request_id, level, index, "failed", inputKind, inputMessages, inputChars, inputTokens,
        JSON.stringify(messageIds), String(result.text ?? "").slice(0, 12000), `facts validation: ${validation.error}`.slice(0, 2000), finish,
        maxTokens, reasoning, Buffer.byteLength(prompt), result.usage?.outputTokens ?? null,
        parentLevel, parentIndex, splitDepth,
        JSON.stringify(inputNodes), JSON.stringify(inputFactRefs), crypto.createHash("sha256").update(String(prompt)).digest("hex"),
        promptVersion, dependencyStatus, nowIso());
      log("warn", "summary batch facts invalid", { request_id: req.request_id, level, index, error: validation.error });
      return { ok: false, error: `facts validation: ${validation.error}`, finish, cached: false };
    }
    putRow.run(req.request_id, level, index, "succeeded", inputKind, inputMessages, inputChars, inputTokens,
      JSON.stringify(messageIds), String(result.text ?? ""), null, finish,
      maxTokens, reasoning, Buffer.byteLength(prompt), result.usage?.outputTokens ?? null,
      parentLevel, parentIndex, splitDepth,
      JSON.stringify(inputNodes), JSON.stringify(inputFactRefs), crypto.createHash("sha256").update(String(prompt)).digest("hex"),
      promptVersion, dependencyStatus, nowIso());
    log("info", "summary batch succeeded", { request_id: req.request_id, level, index, facts: validation.facts.length, input_messages: inputMessages });
    return { ok: true, facts: validation.facts, cached: false };
  };

  const allFacts = [];
  const queue = plan.batches.map((b) => ({ ...b, splitDepth: 0, parentLevel: null, parentIndex: null }));
  let nextBatchIndex = plan.batches.length;
  const maxSplitDepth = Number(summaryCfg.batch_max_split_depth ?? 2);
  const successfulMessageIds = new Set();
  const batchConcurrency = Math.max(1, Math.min(4, Number(summaryCfg.batch_concurrency ?? 2)));
  let fatal = null;

  // Batch extraction is independent; only the coordinator below merges and
  // sends. Chat remains serial in agent-worker. The pool never runs two workers
  // for the same logical batch because queue.shift() is atomic in this process.
  const worker = async () => {
    while (!fatal) {
      const batch = queue.shift();
      if (!batch) return;
      const result = await runRow({
        level: 0, index: batch.index, prompt: buildBatchPrompt(batch, {
          startMs: Number(req.range_start), endMs: Number(req.range_end),
          batchNumber: batch.index + 1, batchTotal: Math.max(plan.batches.length, nextBatchIndex),
        }),
        maxTokens: batchMaxTokens, timeout: batchTimeout, reasoning: batchReasoning,
        allowedMessages: batch.messages, inputKind: "messages",
        inputMessages: batch.messages.length, inputChars: batch.chars, inputTokens: batch.estimatedTokens,
        messageIds: batch.messages.map((m) => Number(m.msg_id)),
        parentLevel: batch.parentLevel, parentIndex: batch.parentIndex, splitDepth: batch.splitDepth,
        inputNodes: batch.messages.map((m) => `message:${m.msg_id}`), inputFactRefs: [],
        promptVersion: "summary-batch-v1", dependencyStatus: "exact",
      });
      updateCoverage();
      if (!result.ok) {
        if (result.finish === "max-tokens" && batch.messages.length > 1 && batch.splitDepth < maxSplitDepth) {
          const mid = Math.ceil(batch.messages.length / 2);
          const parts = [batch.messages.slice(0, mid), batch.messages.slice(mid)].filter((x) => x.length);
          for (const messages of parts) {
            const chars = JSON.stringify(messages).length + 2;
            queue.push({ index: nextBatchIndex++, messages, chars, estimatedTokens: Math.ceil(chars / 2),
              splitDepth: batch.splitDepth + 1, parentLevel: 0, parentIndex: batch.index });
          }
          coverage.batch_split = (coverage.batch_split || 0) + 1;
          log("warn", "summary batch split after max-tokens", { request_id: req.request_id, parent_index: batch.index, children: parts.length, split_depth: batch.splitDepth + 1 });
          updateCoverage();
          continue;
        }
        fatal = result;
        return;
      }
      allFacts.push(...result.facts.map((f) => ({ ...f, _fact_id: summaryFactId(f), _nodes: [`L0-i${batch.index}`] })));
      for (const m of batch.messages) successfulMessageIds.add(Number(m.msg_id));
    }
  };

  const workers = Array.from({ length: Math.min(batchConcurrency, Math.max(1, queue.length)) }, () => worker());
  await Promise.all(workers);
  if (fatal) {
    coverage.incomplete_batches = 1;
    coverage.unattempted_batches = Math.max(0, plan.batches.length - rowsAttempted(db, req.request_id, 0));
    coverage.error = fatal.error;
    return { ok: false, error: fatal.error, coverage };
  }
  const sourceMessageIds = source.messages.map((m) => Number(m.msg_id));
  const missing = sourceMessageIds.filter((id) => !successfulMessageIds.has(id));
  coverage.covered_messages = sourceMessageIds.length - missing.length;
  coverage.missing_message_ids = missing.slice(0, 40);
  if (missing.length) return { ok: false, error: `uncovered messages: ${missing.length}`, coverage };

  let facts = dedupeFacts(allFacts);
  const level0Facts = facts.slice();
  let level = 1;
  const maxMergeSplitDepth = Number(summaryCfg.merge_split_depth ?? 2);
  const mergeConcurrency = Math.max(1, Math.min(2, Number(summaryCfg.merge_concurrency ?? 2)));
  while (facts.length > mergeMaxFacts) {
    if (level > 6) return { ok: false, error: "merge level limit", coverage, partialFacts: facts };
    const groups = planMergeGroups(facts, { maxFacts: mergeMaxFacts, maxChars: mergeMaxChars });
    const next = [];
    let mergeIndex = 0;
    let mergeFailure = null;
    const mergeGroup = async (group, splitDepth = 0, parentIndex = null) => {
      if (mergeFailure) return;
      const index = mergeIndex++;
      const result = await runRow({
        level, index, prompt: buildMergePrompt(group, { level }),
        maxTokens: mergeMaxTokens, timeout: mergeTimeout, reasoning: mergeReasoning,
        allowedMessages: source.messages, inputKind: "facts",
        inputMessages: group.length, inputChars: JSON.stringify(group).length,
        inputTokens: estimateSummaryTokens(JSON.stringify(group)),
        messageIds: [...new Set(group.flatMap((f) => f.source_message_ids))],
        inputNodes: [...new Set(group.flatMap((f) => f._nodes || []))],
        inputFactRefs: group.map((f) => f._fact_id).filter(Boolean),
        promptVersion: "summary-merge-v1", dependencyStatus: "exact",
      });
      updateCoverage();
      if (!result.ok) {
        // A merge group can still exceed the output budget. Split the same
        // facts into disjoint children; the parent remains failed for audit.
        if (result.finish === "max-tokens" && group.length > 1 && splitDepth < maxMergeSplitDepth) {
          const mid = Math.ceil(group.length / 2);
          const parts = [group.slice(0, mid), group.slice(mid)].filter((x) => x.length);
          coverage.merge_split = (coverage.merge_split || 0) + 1;
          log("warn", "summary merge split after max-tokens", { request_id: req.request_id, level, parent_index: index, children: parts.length, split_depth: splitDepth + 1 });
          for (const part of parts) await mergeGroup(part, splitDepth + 1, index);
          return;
        }
        mergeFailure = result;
        return;
      }
      next.push(...result.facts.map((f) => ({ ...f,
        _fact_id: summaryFactId(f), _nodes: [...new Set(group.flatMap((x) => x._nodes || []))] })));
    };
    let mergeGroupAt = 0;
    const mergeWorkers = Array.from({ length: Math.min(mergeConcurrency, Math.max(1, groups.length)) }, async () => {
      while (!mergeFailure) {
        const group = groups[mergeGroupAt++];
        if (!group) return;
        await mergeGroup(group);
      }
    });
    await Promise.all(mergeWorkers);
    if (mergeFailure) {
      coverage.incomplete_batches = plan.batches.length;
      coverage.error = mergeFailure.error;
      return { ok: false, error: mergeFailure.error, coverage, partialFacts: facts };
    }
    facts = dedupeFacts(next);
    level += 1;
    if (facts.length === 0) return { ok: false, error: "merge produced no facts", coverage, partialFacts: level0Facts };
  }
  if (!facts.length) return { ok: false, error: "no facts extracted", coverage, partialFacts: level0Facts };
  updateCoverage();
  coverage.facts = facts.length;
  coverage.levels = level - 1;
  return { ok: true, facts, coverage };
}
