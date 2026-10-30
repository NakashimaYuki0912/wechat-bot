# Chat and summary focus

As of 2026-10-30, image recognition is disabled for the live bot.

## Active behavior

- `chat.image_enabled=false`
- `chat.auto_image_fetch=false`
- `chat.image_search_default=false`
- `chat.image_max_count=0`
- No `media_fetch_tasks` are created by chat.
- No image prompt or unresolved-image prompt is injected into the chat prompt.
- Image messages are treated as ordinary non-text chat data, not attachments.
- Text chat, web search, memory, Session, reliable DB, worker and outbox remain.
- Summary request type and summary pipeline remain unchanged.

## Preserved for later

The native image investigation, fixture tests, decoder notes and scripts are kept
under `work/native-wechat-isolated/` and `docs/archive/`; they are not on the
live path.

## Verification

- `harness/summary-pipeline-test.mjs`: pass
- `harness/bridge-routing-test.mjs`: pass
- `harness/memory-test.mjs`: pass
- prompt check: no `[图片附件]`, `[图片状态]`, `[图片内容任务]`
- live queue after restart: queued/running/sending = 0
- no model call made during verification
