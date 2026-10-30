# Project summary

## Purpose

Run a normal WeChat group bot that:
1. ingests group text messages into a durable local database;
2. replies naturally when explicitly addressed;
3. supports explicit `/summary` requests over a fixed time range;
4. keeps chat and summary execution isolated;
5. never lets a model choose a different send target.

## Main data flow

```text
WeChat -> ingest -> reliability.db
                    |
                    +--> chat/memory requests -> chat worker -> outbox
                    |
                    +--> summary request -> summary coordinator
                                             -> parallel batch facts
                                             -> bounded merge
                                             -> validation/render
                                             -> summary outbox parts
                                                        |
                                                  one serial sender
```

## What was fixed

- Image capture failures no longer block text chat; image recognition is off.
- Failure paths now create one visible failure notice instead of silently
  marking a request failed.
- Summary batches can split after `max-tokens`.
- Summary merge groups can split after `max-tokens`.
- Summary output is split into ordered outbox parts.
- Summary retries use a run nonce, avoiding SDK Session-name collisions.
- Chat and summary claim/lease logic is isolated by worker kind and owner.
- Model slots are shared and bounded; summary leaves a reserved slot for chat.
- Summary input boundaries are explicit and omissions are reported.

## Known limits

- The split-worker entrypoints are not yet rolled out to the production
  Compose service.
- The current installed SDK runner uses independent SDK sessions, not the
  native DSH subagent API.
- Upstream account concurrency/rate limits are shared by chat and summary.
- Summary quality still depends on model output; partial summaries are labeled.
- Historical outbox `uncertain`/`failed` rows are retained and never blindly
  resent.

## Not included

Production data, credentials, WeChat profiles, backups, logs, vendored source
trees, and generated artifacts are intentionally excluded.
