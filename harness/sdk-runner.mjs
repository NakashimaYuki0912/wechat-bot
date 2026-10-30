/**
 * One SDK request against the real DSH JSON-RPC server.
 * The process is isolated per request; step/token/time budgets and the
 * remote-outcome uncertainty rule are enforced here, not by the CLI.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { buildPromptContentBlocks } from "../bridge/media.js";

const RUNTIME = process.env.DSH_RUNTIME || "/app/runtime";
const DSH_HOME = process.env.DSH_HOME || "/app/.dsh";
const PATCH = process.env.DSH_NO_TOOLS_PATCH || "/app/deploy/harness/no-tools.patch.yml";
const WORKSPACE = process.env.DSH_WORKSPACE || "/app/work/harness-workspace";
const NODE = process.execPath;
const BIN = path.join(RUNTIME, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

export async function runSdk({
  prompt,
  sessionId,
  resume = false,
  maxTokens = 512,
  timeoutMs = 90000,
  reasoningEffort = "high",
  images = [],
  patchPath = PATCH,
  maxSteps = 1,
}) {
  const started = Date.now();
  // Test-only fake; never enabled in deployment. It lets scheduler tests run
  // without credentials, network, or a model request.
  if (process.env.DSH_FAKE_SDK === "1") {
    const truncated = String(prompt).includes("TRUNCATED_CHAT");
    const empty = String(prompt).includes("EMPTY_CHAT");
    const summaryBatch = String(prompt).trimStart().startsWith("[SUMMARY_BATCH]") || String(prompt).trimStart().startsWith("[SUMMARY_MERGE]");
    const memoryChat = String(prompt).includes("MEMORY_CHAT");
    const webSearchChat = String(prompt).includes("WEB_SEARCH_TEST");
    const ids = [...String(prompt).matchAll(/"msg_id"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
    const firstId = ids[0] ?? 1;
    const promptMessageId = Number(String(prompt).match(/\[本轮消息\] id=(\d+)/)?.[1] ?? 12);
    const text = process.env.DSH_FAKE_TEXT
      || (summaryBatch && String(prompt).includes("INVALID_SUMMARY")
        ? "not-json"
        : summaryBatch
          ? JSON.stringify({ facts: [{ topic: "合成主题", text: "合成事实", member_ids: [], source_message_ids: [firstId] }], limitations: ["合成批次"] })
          : memoryChat
            ? JSON.stringify({ reply: "好的，记住了", memory_actions: [{ operation: "upsert", type: "member_preference", content: "称呼我阿蓝", source_message_id: promptMessageId }] })
            : String(prompt).includes("总结器")
            ? JSON.stringify({ summary: "合成总结", points: [{ text: "合成结论", member_ids: [], source_message_ids: [2] }], limitations: ["合成测试"] })
            : truncated ? "部分回答" : empty ? "" : "合成聊天回复");
    const fakeTools = webSearchChat ? [
      { id: "fake-search", name: "web_search", arguments: { queries: ["DSH web search test"] } },
      { id: "fake-fetch-1", name: "web_fetch", arguments: { url: "https://example.com/a" } },
      { id: "fake-fetch-2", name: "web_fetch", arguments: { url: "https://example.com/b" } },
    ] : [];
    return {
      status: "succeeded", session_id: sessionId, prompt_message_id: `fake-${Date.now()}`,
      prompt_accepted: true, text: webSearchChat ? "假搜索回答：来源 https://example.com/a 和 https://example.com/b" : text,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finish_reason: (empty || truncated) ? "max-tokens" : "completed",
      image_count: Array.isArray(images) ? images.length : 0,
      tool_calls: fakeTools, steps: webSearchChat ? 4 : 1,
      turn_end: { turn: 1, reason: { kind: (empty || truncated) ? "max-tokens" : "completed" } },
      duration_ms: Date.now() - started, event_types: ["step/start", "assistant/message", "turn/end"],
    };
  }
  const child = spawn(NODE, [BIN, "--profile", "sdk", "--patch", patchPath], {
    cwd: WORKSPACE,
    env: { ...process.env, DSH_HOME, TZ: "Asia/Shanghai" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const events = [];
  const statuses = [];
  let nextId = 1;
  let stderr = "";
  let settled = false;
  let promptAccepted = false;
  let promptMessageId = null;

  const rl = readline.createInterface({ input: child.stdout });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id && !msg.method) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "session.event") events.push(msg.params?.event);
    if (msg.method === "session.status") statuses.push(msg.params);
  });

  let timer;
  const result = await new Promise((resolve) => {
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rl.close(); } catch {}
      try { child.stdin.end(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
      resolve(value);
    };
    const request = (method, params) => {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    };
    timer = setTimeout(() => {
      // A request may already be in flight; the remote result is unknowable.
      finish({ status: "uncertain", error: "timeout", cancel_state: "process_killed_remote_unknown", prompt_accepted: promptAccepted });
    }, timeoutMs);

    child.on("error", (e) => finish({ status: "failed", error: `spawn: ${e}`, prompt_accepted: false }));
    child.on("exit", (code, signal) => {
      if (!settled) finish({ status: promptAccepted ? "uncertain" : "failed", error: `sdk exited code=${code} signal=${signal}`, prompt_accepted: promptAccepted });
    });

    (async () => {
      try {
        await request("initialize", {
          cwd: WORKSPACE,
          provider: "deepseek-account",
          model: "deepseek-flash",
          reasoningEffort,
          maxTokens,
        });
        if (resume) {
          try {
            await request("session/resume", { sessionId });
          } catch (e) {
            finish({ status: "failed", error: `session/resume failed: ${e}`, prompt_accepted: false });
            return;
          }
        }
        const sent = await request("session/prompt", {
          sessionId,
          contentBlocks: buildPromptContentBlocks(prompt, images),
        });
        promptAccepted = true;
        promptMessageId = sent?.messageId ?? null;
        await request("session/wait", { sessionId });
        if (settled) return;

        const assistant = events
          .filter((e) => e?.type === "assistant/message" && e?.data?.message?.role === "assistant")
          .map((e) => e.data);
        const text = assistant
          .flatMap((d) => d.message.content || [])
          .filter((b) => b?.type === "text")
          .map((b) => b.text)
          .join("");
        const usage = assistant.length ? (assistant.at(-1).usage ?? null) : null;
        const steps = events.filter((e) => e?.type === "step/start").length;
        const toolCalls = assistant.flatMap((d) => (d.message.content || [])
          .filter((b) => b?.type === "tool-call")
          .map((b) => ({ id: b.id, name: b.name, arguments: b.arguments })));
        const auxiliaryRequests = events.filter((e) => e?.type === "web/deepseek-search-llm-request").length;
        const turnEnd = events.filter((e) => e?.type === "turn/end").at(-1)?.data ?? null;
        // Enforce the configured step budget after the fact. Chat may spend
        // steps on web_search/web_fetch; summary/no-tools stays at one.
        if (steps > maxSteps) {
          finish({
            status: "uncertain", error: `step budget exceeded: ${steps}`,
            cancel_state: "process_killed_remote_unknown", prompt_accepted: promptAccepted,
            session_id: sessionId, prompt_message_id: promptMessageId, steps,
            tool_calls: toolCalls, auxiliary_requests: auxiliaryRequests, usage, text, finish_reason: "step-budget-exceeded",
            duration_ms: Date.now() - started, event_types: events.map((e) => e.type),
          });
          return;
        }
        try { await request("shutdown", undefined); } catch {}
        finish({
          status: "succeeded", session_id: sessionId,
          prompt_message_id: promptMessageId, prompt_accepted: true,
          text, usage, steps, tool_calls: toolCalls, auxiliary_requests: auxiliaryRequests, turn_end: turnEnd,
          finish_reason: turnEnd?.reason?.kind ?? turnEnd?.reason ?? null,
          duration_ms: Date.now() - started,
          statuses, event_types: events.map((e) => e.type),
        });
      } catch (e) {
        finish({
          status: promptAccepted ? "uncertain" : "failed",
          error: String(e), prompt_accepted: promptAccepted,
          session_id: sessionId, prompt_message_id: promptMessageId,
          duration_ms: Date.now() - started,
          event_types: events.map((e) => e.type),
        });
      }
    })();
  });
  if (stderr.trim()) result.stderr = stderr.slice(-4000);
  return result;
}
