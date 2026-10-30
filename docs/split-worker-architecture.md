# Split chat/summary workers

## Implemented code (not yet deployed to production)

- `bridge/worker-common.js`
  - atomic `claimRequest` by worker kind
  - `claim_owner`, `claim_token`, `lease_expires_at`
  - `recoverExpiredClaims`: only expired leases become `uncertain`; no
    bulk conversion of another live worker's `running` rows
- `bridge/chat-worker.js`
  - `WORKER_KIND=chat`; claims only `chat` and `memory`
- `bridge/summary-worker.js`
  - `WORKER_KIND=summary`; claims only `summary`
- `bridge/model-capacity.js`
  - cross-process SQLite slot table
  - `model_max_concurrency=4`
  - summary limited to total-1 slots, leaving one reserved for chat
- `bridge/summary-pipeline.js`
  - batch extraction concurrency `batch_concurrency=2`
  - merge-group concurrency `merge_concurrency=2`
  - max-tokens split at both batch and merge levels
  - run nonce isolates retried SDK sessions
- `bridge/agent-worker.js`
  - summary input now uses configured `max_input_messages`/`max_input_chars`
  - current task boundary: 1000 messages / 200000 chars
  - omissions are explicit in coverage, not silently dropped
  - multi-part summary output, one coordinator publishes to outbox

## DSH subagent check

The installed `harness/sdk-runner.mjs` exposes SDK `session/prompt` calls, not a
native subagent API. This implementation therefore uses **independent SDK
sessions** for batch/merge work; it does not claim native subagent usage. No DSH
upgrade was made.

## Isolation

- Chat and summary are separate OS processes, queue claims, leases and SDK
  sessions.
- Same DB and outbox are shared.
- Chat remains serial per account/group via its single worker and existing
  `agent_sessions`.
- Summary never reads or writes chat Session state.
- Summary children have no chat history, tools, shell, search or send target.
- Bridge remains the only process that calls the WeChat send API; summary and
  chat only write fixed-target outbox rows.

## Independent tests

- `harness/worker-isolation-test.mjs`
  - chat and summary claim different rows while both run
  - a new chat is claimable while summary is running
  - expired lease recovery only affects the expired worker
- `harness/capacity-test.mjs`
  - 3 summary slots + 1 reserved chat slot at max 4
- `harness/summary-pipeline-test.mjs`
  - existing fake-SDK batch/merge/validation tests pass
- `harness/independent-tests.mjs`
  - existing DB/summary invariants pass
- `harness/bridge-routing-test.mjs`
  - routing/queue invariants pass

## Acceptance plan before deployment

1. Run chat and summary wrappers against a temporary DB with fake SDK.
2. Start a long summary; send a chat request; assert chat completes while summary
   is still running.
3. Instrument fake SDK to assert extraction and merge never exceed 4 total
   model calls and at least one slot remains available for chat.
4. Restart only the summary worker while chat is active; assert chat continues
   and summary lease is not blindly replayed.
5. Feed two senders, quoted messages and out-of-order source IDs; verify source
   IDs, quote attribution and snapshot/range.
6. Verify a second identical summary reuses completed nodes or links to the
   existing request; no duplicate full run.
7. Send a summary with several parts and a chat reply; bridge serializes sends
   while preserving summary part order.
8. Confirm `chat.image_enabled=false` and no media fetch task is created.
9. Compare real concurrency 2 vs 4 for chat wait, summary duration, model calls,
   tokens, rate limits and failures. Do not claim 4 summary + 1 chat until
   observed.

## Deployment note

Current production still runs the old single `agent` container. The two wrapper
entrypoints are code-complete but not deployed. Deployment must replace only the
agent worker processes; do not restart WeChat/MimicWX or rescan.
