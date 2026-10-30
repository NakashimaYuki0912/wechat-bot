/**
 * Chat-only pre-execution tool budget.
 *
 * It wraps tools/execute before the tool body runs. Web search/fetch calls over
 * the configured budget return a structured error to the model instead of
 * touching the network. One worker process handles one chat request, so the
 * counters are per request.
 */
export const name = "chat-tool-budget";
export const inject = ["tools"];

function errorResult(message, code) {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: "ToolBudgetError", code } },
  };
}

export function apply(ctx, config = {}) {
  const maxSearch = Number(config.maxSearch ?? 1);
  const maxQueries = Number(config.maxQueries ?? 3);
  const maxFetch = Number(config.maxFetch ?? 2);
  let searches = 0, queries = 0, fetches = 0;
  ctx.on("tools/execute", async (exec, next) => {
    if (exec.name === "web_search") {
      const list = Array.isArray(exec.arguments?.queries) ? exec.arguments.queries
        : exec.arguments?.query ? [exec.arguments.query] : [];
      if (searches + 1 > maxSearch) return errorResult(`web_search budget exhausted (${maxSearch} calls per chat)`, "WEB_SEARCH_BUDGET");
      if (queries + list.length > maxQueries) return errorResult(`web_search query budget exhausted (${maxQueries} queries per chat)`, "WEB_QUERY_BUDGET");
      // Reserve before the tool body; parallel calls in this same step see it.
      searches += 1; queries += list.length;
    } else if (exec.name === "web_fetch") {
      if (fetches + 1 > maxFetch) return errorResult(`web_fetch budget exhausted (${maxFetch} pages per chat)`, "WEB_FETCH_BUDGET");
      fetches += 1;
    } else {
      return next();
    }
    return next();
  });
}
