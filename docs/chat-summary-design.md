# Chat and explicit group-summary design

> Historical design note. Some parameters and memory behavior have since
> changed. Use the README, current example configuration and split-worker
> architecture for the current source snapshot. This is not deployment
> acceptance evidence.

Date: 2026-10-27
Root: `/workspace/wechat-bot`

## 1. Routing

Routing is deterministic and performed by the bridge; no model classifier.

| Input | Request type | Trigger reason |
|---|---|---|
| Real @ + ordinary text | chat | mention |
| Exact `/总结` or `/summary`, optionally one date `YYYY-M-D` | summary | command |
| Real @ + exact command/date | summary | mention_command |
| Un-mentioned ordinary text | none (DB only) | — |
| Command text inside a sentence/code block/quote appmsg | none, unless separately a real @ chat | — |
| Self or other group | none | — |

The command match is against the current plain-text message body after removing
the actual mention. `msgType` must be text (base type 1), so a quoted appmsg
whose title happens to be `/summary` cannot trigger a summary. Ordinary
messages containing `/summary` are not commands.

Accepted forms:

- `/总结` or `/summary` — **yesterday**, Asia/Shanghai 00:00–23:59:59, not
  today and not only the bot conversation.
- `/总结 2026-10-5` or `/summary 2026-10-05` — that whole Shanghai calendar
  day; future dates simply have no data.
- Date must be a real calendar date; extra text/invalid dates are not summary
  commands.

A real @ still requires `msg_source` / `<atuserlist>` containing the bot
account. Manual `@昵称` without that metadata is not a trigger.

Each source message has one unique `agent_requests` row, so replay/duplicate
cannot create both chat and summary.

## 2. Request persistence

`agent_requests` now stores:

- `request_type` (`chat`/`summary`) and `trigger_reason`
- `source_message_id`, `source_local_id`, `source_account_id`,
  `source_group_id`, `account_id`, `group_id`, `sender_id`
- summary-only `range_start`, `range_end`, `snapshot_max_message_id`,
  `snapshot_at`, `input_message_count`, `input_truncated`,
  `input_truncated_count`, `coverage_json`
- `budget_type`, `budget_reserved_at`
- `summary_json`, `validation_status`

Statuses remain `queued/running/succeeded/failed/uncertain`.

## 3. Chat

- Uses the single active Session for `account_id + group_id`.
- Only chat-triggering @ messages enter that Session; ordinary group messages do
  not.
- The prompt separates current speaker, other members, quoted author/content,
  and unresolved quote state.
- Stable `sender_id` is the identity key. `sender_display` is a historical
  snapshot; contact name and group alias are separate fields. The current WCDB
  schema has no group-alias column, so group alias is null and marked
  unavailable; it is never replaced by the contact name.
- A chat session max-turn limit (40) retires the old Session and starts a new
  one; this bounds context growth without enabling automatic compaction.
- Chat display limit is 2000 visible characters. If the model returns more, the
  bridge appends `（显示已截断，完整回答未发送）`; it never silently cuts.
- Empty/truncated/timeout chat failures send one short failure notice through
  the outbox; no reasoning is exposed and no automatic retry occurs.
- No long-term member memory; no automatic saving of model output as facts.

## 4. Summary

At command time the bridge persists:

- selected date (if any), range start/end, and the current max `messages.id`
  (`snapshot_max_message_id`);
- the command's stable source association.

No-message date: the worker sends a program-generated
`无当日对话信息。` (or `无当日对话信息（YYYY-MM-DD）。`) without calling the
model. It consumes no model budget and no acceptance-round model call. In
unlimited mode it is not blocked by the old reply cap either.

The worker reads only raw `messages` for the same account/group, within the
range, at or before the snapshot, excluding self/bot messages and the command
message. Later messages cannot enter.

Input is bounded (default 200 messages / 12,000 chars), with oldest-first
omission; all limits are recorded. No automatic chunking or second summary
call. Empty input fails without a model call. Non-text messages are explicitly
“not parsed”; unresolved quotes remain unresolved.

The summary uses a bounded batch pipeline (never the chat Session). Level 0 extracts facts from bounded batches; higher levels merge bounded fact groups. Each successful batch is stored in `summary_batches` and reused, not recalled.
A max-tokens batch is split into disjoint child batches (split_depth <= 2); the
parent remains failed for audit and coverage is computed from successful leaves. Final text is rendered by program code. `summary` is a short overview; `points` are **topics/discussion
threads**, not individual messages:

```json
{"summary":"...", "points":[
  {"topic":"主题名", "text":"谁在什么时间讨论了什么", "member_ids":["wxid_..."], "source_message_ids":[123]}
], "limitations":["..."]}
```

The program validates:

- valid JSON object and non-empty points;
- every point has source message IDs that exist in the bounded input;
- every supplied member ID is the author of one of that point's source
  messages;
- no unknown source/member IDs.

Rendering uses stable sender IDs and source messages, disambiguates duplicate
display labels, and appends program-derived coverage/truncation/non-text/quote
limitations. Invalid output is stored as failed (`validation_status=invalid`)
and is never enqueued or retried. Local schema validation cannot prove semantic
truth; this is not a claim of correctness.

## 5. Budgets

- Normal mode uses explicit `limits` switches:
  `enforce_auto_reply_cap=false`, `enforce_acceptance_round=false`,
  `enforce_model_budget=false`.
- Historical cap/budget/round tables, counters, and rejected requests remain
  intact for audit; they are not reset and are not replayed.
- The old `auto_reply_cap=8` value remains in config so enforcement can be
  re-enabled without losing the setting.
- Automatic compaction and framework retry remain disabled, so there is no
  hidden framework-level summary/retry call. Provider-internal retry is not
  fully observable and remains a documented accounting gap.

## 6. Sessions and recovery

- Chat Session map remains; no clearing merely because of this migration.
- Summary does not write `agent_sessions`.
- `running` at restart becomes `uncertain`, no auto rerun.
- Chat uncertainty/failed-after-prompt/empty/outbox failure retires the chat
  Session; history is retained. Next chat starts new context; old raw messages
  remain available to a later explicit summary.
- Summary uncertainty is not sent and does not touch chat context.
- Outbox success is transactional with request success; confirmed queued rows
  are recovered by the existing outbox worker without re-calling the model.

## 7. Config

`data/bridge/config.json` adds:

```json
"chat": {"max_tokens":8192,"display_chars":2000,"timeout_ms":90000,
         "reasoning_effort":"high","session_max_turns":40,"max_input_chars":4000},
"summary": {"max_tokens":2048,"display_chars":1500,"timeout_ms":120000,
            "reasoning_effort":"high",
            "max_input_messages":200,"max_input_chars":120000},
"model_budget": {"chat":10,"summary":5}
```

Current normal mode preserves `auto_reply_cap=8` as a re-enable value but sets
`limits.enforce_auto_reply_cap=false`; the acceptance-round and model-budget
enforce switches are also false. Historical counters are retained. These are
code/config changes only; no real model request or group send was made by the
agent.

## 8. Migration

- Additive columns on `agent_requests`; existing rows default to `chat`.
- `model_budget` table retained/ seeded at the historical migration; current
  counters are chat 6/summary 0 and are audit-only while limits are disabled.
- Messages/session history/outbox data untouched.
- Backup/rollback: `backups/summary-20261027-120652/` (pre-migration state).
- Independent coverage: 37 pure/storage checks, fake-SDK scheduler test, and
  production bridge routing/storage test (see `docs/independent-tests.md`).
- No credentials copied.

## Chat persona and recent context

`chat.persona` is chat-only and is injected into the current prompt every turn;
the SDK has no separate system-prompt field, so an existing Session receives it
as part of the next text turn. `chat.recent_context_*` bounds recent same-group
messages (default 8 messages / 1600 chars / 180 minutes). Stable sender IDs are
kept, current speaker/quote/recent context are labelled separately, and group
messages are explicitly data rather than instructions.
