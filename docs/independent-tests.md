# Independent tests

> Historical server test record. These results were not rerun for this public
> export. The original environment is Linux. Scheduler and bridge-routing tests
> need a private database schema; archived image tests and work artifacts are
> not included. See the README for portable checks and deployment gaps.

These tests use independent DBs, fixtures, or a test-only fake SDK. They never
call the WeChat send API or a real model.

## 1. Pure/storage suite

```bash
runtime/node/bin/node harness/independent-tests.mjs
```

Writes `work/independent-tests/synthetic.db`. Latest run: **61/61 passed**.

Covers:

- two worker-thread concurrent enqueues;
- duplicate event/source, unique source;
- same `local_id` in another account/group;
- restart `running` → uncertain;
- contaminated Session retired, history retained, no outbox;
- reply cap (5) and sixth rejection;
- exact `/总结`, exact `/summary` with @, date forms, invalid/extra-text dates;
- sentence/code-block/appmsg command non-trigger;
- self/other-group exclusion;
- Shanghai-day range;
- summary excludes source/self/after-snapshot/before-range;
- empty input/truncation and no-model fixed `无当日对话信息`;
- non-text and unresolved quote limitations;
- same-display label disambiguation;
- valid/invalid structured summary, unknown source/member, member not a source
  author, code-fenced JSON;
- rendering source IDs and limitations;
- model-budget reserve/exhaust;
- second connection sees committed queue rows.

Artifacts: `work/independent-tests/results.json`, `run.log`.

## 2. Scheduler integration with local fake SDK

```bash
runtime/node/bin/node harness/scheduler-test.mjs
```

- clones the **schema** into `work/scheduler-test/reliability.db`;
- runs the production `bridge/agent-worker.js`;
- uses `DSH_FAKE_SDK=1`; no network/credential/model request;
- fixture chat + valid summary + invalid-summary + empty-summary requests;
- config has `auto_reply_cap=1` and all three `limits.enforce_*` switches false;
- checks six outbox rows are created despite cap 1: chat, partially truncated
  chat, empty-chat failure notice, valid summary, invalid-summary failure
  notice, and empty-summary no-data fixed reply;
- invalid summary fails validation without partial JSON; empty chat emits the
  failure notice; partially truncated chat is sent with an incomplete-answer
  note; empty summary emits a fixed no-data reply without a model call; one
  chat Session exists; both historical counter tables remain at used=0.

Latest result: `work/scheduler-test/results.json`, passed.

This is still synthetic, not real-group or real-model acceptance.

## 3. Production bridge routing/storage

```bash
runtime/node/bin/node harness/bridge-routing-test.mjs
```

- clones the schema into `work/bridge-routing-test/reliability.db`;
- inserts `/总结 2026-10-5`, a real mention fixture, and an ordinary
  un-mentioned message;
- runs the production `bridge/reliable.js` with an unreachable API,
  `auto_reply_cap=0`, and all three limit switches false;
- verifies cap is bypassed, one summary request (`trigger_reason=command`,
  `summary_target_date=2026-10-05`) and its full-day range, one chat request
  (`trigger_reason=mention`), no request for the ordinary message, both queued,
  processed messages=3, outbox=0;
- no model, no WeChat API.

Latest result: `work/bridge-routing-test/results.json`, passed.

## 4. What is not synthetic-verified

- Real same-nickname / rename / group alias.
- Real simultaneous two-member requests.
- Real provider timeout/cancel/billing.
- A real `/总结` reply in the group.

## Bounded summary pipeline

`harness/summary-pipeline-test.mjs` uses an in-memory DB and a fake SDK only:

- 95 messages are split into 10 bounded batches; every message is accounted for;
- facts are persisted in `summary_batches`;
- a second run reuses all successful batches and calls the fake SDK zero additional times;
- multiple merge levels are exercised with `merge_max_facts=2`;
- no real model, network, or production DB is used.

## Chat persona/context

Tests cover bounded recent context, stable sender IDs, persona injection, and
the data-not-instructions boundary. The live SDK is not called by these tests.

## Persistent memory

`harness/memory-test.mjs` covers 23 cases: save, replay dedupe, preference
supersession/version history, negation/quote/hypothetical/credential rejection,
same-name isolation, admin-only group background, expiry, owner forget, restart
recovery, envelope parsing, and `/memory` parsing. `harness/scheduler-test.mjs`
also exercises `/memory` and a chat reply carrying `memory_actions` without
leaking the structured action into the outbox.

## Summary batch split evidence

The summary pipeline test also forces a parent batch to end at `max-tokens`.
It verifies the parent remains failed, two disjoint child batches succeed, all
95 source messages are covered exactly once, and the parent is not counted as a
successful batch. No real model is used.

## Image attachment offline test

`harness/image-pipeline-test.mjs` uses a 1x1 PNG fixture and an in-memory DB:

- exact current-image lookup;
- exact quoted-image lookup (not the last image);
- missing decoded media is explicit;
- media path outside the root is rejected;
- SDK content blocks contain a text block plus a validated image block;
- MIME/magic/hash checks pass for the fixture.

## Chat web search

- `harness/web-search-test.mjs` checks the chat-only patch, prompt search limits,
  fake `web_search` + two `web_fetch` calls, step count, and cited URLs.
- `harness/scheduler-test.mjs` verifies the worker records these auxiliary calls
  in `chat_tool_events` while summary stays no-tools.

## Image/search final offline checks

- `image-pipeline-test.mjs`: 9 checks, including current/quoted exact IDs,
  same-sender unique fallback, ambiguity refusal, path boundary, and image block.
- `web-search-test.mjs`: 6 checks with a fake one-search/two-fetch service.
- `scheduler-test.mjs`: worker records 1 search + 2 fetch calls in
  `chat_tool_events`; summary stays no-tools.
