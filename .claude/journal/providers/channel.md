# Providers: Channel

Slack integration fixes: image handling, file uploads, message formatting.

## [2026-02-26 05:52] — Strip markdown image references from Slack messages

**Task:** Generated images upload to Slack successfully but the message text still contains raw `![alt](generated-xxx.png)` markdown that Slack doesn't render
**What I did:** Added markdown image reference stripping in `server-channels.ts` before sending outbound messages. When `outboundAttachments` are present, regex matches `![...](filename)` where filename is in the attachment set, replaces with empty string, and cleans up leftover blank lines. Only strips references whose filenames match uploaded attachments — other image refs are left intact.
**Files touched:** src/host/server-channels.ts
**Outcome:** Success — all tests pass (5 server-channels, 38 slack), TypeScript clean
**Notes:** The fix is channel-agnostic — it strips markdown image refs for any channel provider, not just Slack. The regex `!\[[^\]]*\]\(([^)]+)\)` captures the `src` from markdown image syntax and compares the basename against uploaded attachment filenames.

## [2026-02-26 02:33] — Simplify image pipeline: inline image_data instead of disk round-trip

**Task:** Eliminate unnecessary disk round-trip for inbound Slack image attachments.
**What I did:** Changed `buildContentWithAttachments()` in server-channels.ts to create `image_data` blocks (inline base64) instead of `image` blocks (fileId disk refs). This skips the write-to-disk → reference-by-fileId → resolve-from-disk pipeline. The Anthropic provider already handles `image_data` natively. Updated runner.ts and ipc-transport.ts to handle `image_data` alongside `image` blocks. Removed unused imports from server-channels.ts.
**Files touched:** src/host/server-channels.ts, src/agent/ipc-transport.ts, src/agent/runner.ts, tests/agent/ipc-transport.test.ts
**Outcome:** Success — all 1602 tests pass, build clean
**Notes:** The `image` block type + `createImageResolver` are still needed for outbound direction (agent-generated images read from workspace disk).

## [2026-02-26 02:14] — Fix Slack image attachments not reaching the LLM

**Task:** Users attaching images to Slack messages got "I don't see any image" — images were downloaded and stored but never sent to Claude.
**What I did:** Traced the full image flow: Slack → server-channels → agent stdin → pi-agent-core → convertPiMessages → IPC → host LLM handler. Found that `runPiCore()` in runner.ts stripped image blocks via `extractText()` (line 260), and `convertPiMessages()` in stream-utils.ts only kept text blocks from user messages. Since pi-agent-core only supports text, image blocks were lost before reaching the IPC transport. Fixed by extracting image blocks in `runPiCore()`, passing them to `createIPCStreamFn()`, and injecting them into the last plain-text user message after `convertPiMessages()` runs. The host-side LLM handler's existing image resolver then picks them up.
**Files touched:** src/agent/ipc-transport.ts, src/agent/runner.ts, tests/agent/ipc-transport.test.ts
**Outcome:** Success — all 1601 tests pass, build clean, 4 new tests for image injection
**Notes:** The proxy stream path (createProxyStreamFn) doesn't support images yet — it goes directly to the Anthropic SDK without file resolution. A separate enhancement could add that.

## [2026-02-25 23:21] — Fix Slack file upload "detached ArrayBuffer" error

**Task:** Slack file upload failed with "fetch failed" / "Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer"
**What I did:** Root cause: `new Uint8Array(buffer)` passed to `fetch()` body still references Node.js's shared Buffer pool ArrayBuffer. Undici (Node.js fetch) detaches the ArrayBuffer during send, but the pool may have already reclaimed it. Fixed by creating a standalone ArrayBuffer via `new ArrayBuffer()` + `.set()` before passing to fetch. Also improved error logging to capture `err.cause`, `code`, and `contentLength`.
**Files touched:** src/providers/channel/slack.ts, tests/providers/channel/slack.test.ts
**Outcome:** Success — all 1633 tests pass
**Notes:** Always create standalone ArrayBuffers when passing binary data to Node.js fetch. Never rely on Buffer's shared pool memory for async operations that may detach the underlying ArrayBuffer.

## [2026-02-25 21:53] — Fix Slack image download missing auth header

**Task:** Users sending images via Slack got "I don't see any image" — images silently failed to download
**What I did:** Traced the image flow from Slack → buildContentWithAttachments → fetch. Found that `fetch(att.url)` at server-channels.ts:55 was fetching Slack's `url_private` URLs without the required `Authorization: Bearer <bot_token>` header. Slack returned non-OK (401), images were silently skipped, and plain text was sent to the agent. Fixed by adding `downloadAttachment` method to `ChannelProvider` interface (with Slack implementation that includes auth headers), and passing it as a download function to `buildContentWithAttachments`. Also exported `buildContentWithAttachments` for direct testing.
**Files touched:** src/providers/channel/types.ts, src/providers/channel/slack.ts, src/host/server-channels.ts, tests/providers/channel/slack.test.ts, tests/host/server-channels.test.ts (new)
**Outcome:** Success — 1614 tests pass (43 existing + 3 new slack + 5 new server-channels), build clean
**Notes:** The `downloadAttachment` method is optional on ChannelProvider so other providers aren't forced to implement it. The fallback to plain `fetch` remains for providers that don't need auth (or have public URLs).
