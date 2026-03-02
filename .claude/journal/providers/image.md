# Providers: Image

Image generation providers, image pipeline, multimodal support, file storage.

## [2026-02-26 11:30] — Fix image resolver using wrong agentId and add defensive fallbacks

**Task:** HTTP client not receiving image information after enterprise workspace migration
**What I did:** Found and fixed three issues:
1. Image resolver `agentId` mismatch: `createImageResolver` used `ctx.agentId` ('system' from defaultCtx) but images are persisted under configured `agentName` ('main'). Fixed by threading `agentName` from `createIPCHandler` → `createLLMHandlers` → `createImageResolver`.
2. Removed overly strict guard `&& resultAgent && resultUser` in server.ts rewrite condition; added fallback defaults (`config.agent_name ?? 'main'`, `userId ?? process.env.USER ?? 'default'`).
3. Same fix in server-channels.ts fallback disk read — removed strict guard, added `agentName` (from deps) and `msg.sender` defaults.
Also fixed stale URL comments in server.ts routes.
**Files touched:** src/host/ipc-handlers/llm.ts, src/host/ipc-server.ts, src/host/server.ts, src/host/server-channels.ts
**Outcome:** Success — 1653 tests pass, TypeScript build clean
**Notes:** The key bug was the agentId mismatch: defaultCtx.agentId='system' but images live under agentName='main'. The _sessionId injection mechanism only overrides sessionId, not agentId, so the resolver was always looking in the wrong directory for inbound images.

## [2026-02-26 10:35] — Migrate file storage from session workspace to enterprise user workspace

**Task:** Move image persistence and file upload/download from session workspace (`workspaceDir(sessionId)`) to enterprise user workspace (`userWorkspaceDir(agentName, userId)`) so files are durable, discoverable across conversations, and tied to users rather than ephemeral session IDs.
**What I did:**
1. Updated `rewriteImageUrls` in server-http.ts: changed signature from `(text, blocks, sessionId)` to `(text, blocks, agentName, userId)`, URL template from `?session_id=` to `?agent=&user=`
2. Updated server-completions.ts: added `agentName`/`userId` to `CompletionResult`, changed `extractImageDataBlocks` and generated image persistence to write to `enterpriseUserWs` instead of `workspace`
3. Updated server.ts: destructure `agentName`/`userId` from processCompletion result, pass to `rewriteImageUrls`
4. Updated server-files.ts: replaced `session_id` query param with `agent`+`user`, validate with `SAFE_NAME_RE`, use `userWorkspaceDir()` instead of `workspaceDir()`
5. Updated server-channels.ts: fallback disk read uses `userWorkspaceDir(resultAgent, resultUser)` from processCompletion result
6. Updated ipc-handlers/llm.ts: image resolver checks `userWorkspaceDir(ctx.agentId, ctx.userId)` first, falls back to `workspaceDir(ctx.sessionId)` for sandbox CWD files
7. Updated 3 test files: assertions for new URL format, mock `userWorkspaceDir` instead of `workspaceDir`
**Files touched:** src/host/server-http.ts, src/host/server-completions.ts, src/host/server.ts, src/host/server-files.ts, src/host/server-channels.ts, src/host/ipc-handlers/llm.ts, tests/host/server-completions-images.test.ts, tests/host/server-multimodal.test.ts, tests/host/server-files.test.ts
**Outcome:** Success — 289 host tests pass, TypeScript build clean
**Notes:** The `data/workspaces/` directory remains as agent sandbox CWD. The image resolver fallback ensures files written by agents to sandbox CWD during a session are still resolvable.

## [2026-02-26 09:30] — Investigate missing generated images + add diagnostic logging

**Task:** User reported generated images not appearing in workspace despite correct URL. The `/v1/files/` URL looked correct: `http://localhost:3000/v1/files/generated-a341d7ac.png?session_id=main%3Ahttp%3Avinay%40canopyworks.com%3A__LOCALID_syXRd79`
**What I did:** Exhaustively traced the entire image pipeline from `image_generate` IPC through `pendingImages` storage, drain, persistence, to download handler. Verified that `safePath()` allows `@` and `.` characters, `workspaceDir()` correctly splits colon-separated IDs into nested directories, and the persist + download paths resolve to the same location. Root cause: user was looking in the enterprise user workspace (`~/.ax/agents/main/users/vinay@canopyworks.com/workspace/`) instead of the session workspace (`~/.ax/data/workspaces/main/http/vinay@canopyworks.com/__LOCALID_syXRd79/`). Added diagnostic logging: `image_drain` (count), `image_persisted` (fileId, path, bytes), `image_persist_failed` (workspace, error), `file_not_found` (fileId, sessionId, wsDir, filePath). Added 2 new tests: persist+download path alignment for colon-separated session IDs with email userId, and URL encoding of `@` and `:` in session IDs. Rewrote stale `server-multimodal.test.ts` to test current `rewriteImageUrls` behavior instead of old ContentPart[] approach.
**Files touched:** src/host/server-completions.ts (logging), src/host/server-files.ts (logging), tests/host/server-completions-images.test.ts (2 new tests), tests/host/server-multimodal.test.ts (rewritten)
**Outcome:** Success — all tests pass (17 image tests, 22 path tests, 4 multimodal tests), TypeScript build clean
**Notes:** Two separate workspace directories exist in AX: session workspace (`workspaceDir()`) and enterprise user workspace (`agentUserDir()`). Images are persisted to session workspace. The code is correct — the user was checking the wrong directory.

## [2026-02-26 08:33] — Persist generated images to workspace for durable URLs

**Task:** Generated images from `image_generate` were held in memory only. After `drainGeneratedImages()` ran, the bytes were gone. The `/v1/files/` download endpoint reads from workspace on disk — but generated images were never written there. Result: image URLs returned 404 on any future request.
**What I did:** Added workspace persistence in `processCompletion` after draining generated images. Each drained image is written to `safePath(workspace, ...fileId.split('/'))` so the download handler (`/v1/files/<fileId>`) resolves to the same path. Added 3 tests verifying: simple fileId persistence, subdirectory fileId persistence, and multiple image persistence.
**Files touched:** src/host/server-completions.ts, tests/host/server-completions-images.test.ts
**Outcome:** Success — 278 host tests pass, TypeScript build clean
**Notes:** The `image_data` path (inline agent output via `extractImageDataBlocks`) already wrote to workspace. Only the `image_generate` path was missing disk persistence.

## [2026-02-26 08:17] — HTTP API multimodal image response

**Task:** Fix HTTP API gap: generated images weren't returned to HTTP API clients (only Slack/channel path worked)
**What I did:** Updated `handleCompletions` in server.ts to destructure `contentBlocks` from `processCompletion` and build multimodal `ContentPart[]` when response contains image blocks. Image blocks become `image_url` parts pointing to `/v1/files/<fileId>?session_id=<id>`. Added `ContentPart` type to server-http.ts and updated `OpenAIChatResponse.message.content` to `string | ContentPart[]`. Streaming mode still uses plain text (SSE delta.content is always string). Created `tests/host/server-multimodal.test.ts` with 3 tests using `vi.mock` on processCompletion: image response returns ContentPart[], text-only stays string, no session_id falls back to requestId.
**Files touched:** src/host/server-http.ts, src/host/server.ts, tests/host/server-multimodal.test.ts (new)
**Outcome:** Success — 3/3 new multimodal tests pass, 20/20 existing server tests pass, TypeScript build clean
**Notes:** Session IDs must be valid UUIDs or 3+ colon-separated segments (per `isValidSessionId`). Test initially used `test-session-123` which failed validation — fixed to use `randomUUID()`.

## [2026-02-26 06:24] — Switch Slack file upload to files.uploadV2 SDK method

**Task:** Fix Slack file upload silently failing — files uploaded but not shared to channel (mimetype: "", shares: {}, channels: [])
**What I did:** Root cause: the manual 3-step upload flow used HTTP PUT for the upload step, but Slack expects HTTP POST (known issue: bolt-js #2326). The Slack SDK's `files.uploadV2()` method wraps the 3-step flow correctly using POST. Replaced the entire manual upload flow (httpsPut helper, node:https import, getUploadURLExternal → PUT → completeUploadExternal) with a single `app.client.files.uploadV2()` call. Used `initial_comment` on the first upload to combine text + image as a single Slack message. Updated tests: removed node:https mock, replaced 3-step upload assertions with uploadV2 assertions, added tests for thread_ts passing and fallback when attachment has no content.
**Files touched:** src/providers/channel/slack.ts, tests/providers/channel/slack.test.ts
**Outcome:** Success — 40 Slack tests pass, 5 server-channels tests pass, TypeScript build clean
**Notes:** The SDK's `FilesUploadV2Arguments` type uses `thread_ts: string` (not optional), so conditional spread doesn't work — use a mutable Record<string,unknown> object with `as any` cast instead.

## [2026-02-26 03:51] — Eliminate disk round-trip for generated images

**Task:** `image_generate` handler wrote images to disk (ENOENT if workspace didn't exist), then channel handler read them back. Unnecessary — bytes are already in memory on the host.
**What I did:** Replaced disk writes in `image_generate` handler with an in-memory session-scoped map (`pendingImages`). Added `drainGeneratedImages(sessionId)` export that `processCompletion` calls after the agent finishes. Drained images become `ExtractedFile` entries + `image` content blocks in the response — the same path the channel handler already uses for direct Slack upload. Removed `fs`, `paths`, and `safe-path` imports from image handler.
**Files touched:** src/host/ipc-handlers/image.ts, src/host/server-completions.ts, tests/host/ipc-handlers/image.test.ts
**Outcome:** Success — 159 test files, 1633 tests pass, TypeScript build clean
**Notes:** The image bytes now flow: provider → handler memory → processCompletion drain → ExtractedFile → channel upload. No disk write at all for the Slack path. The `extractedFiles` mechanism already existed for `image_data` blocks — generated images just reuse it.

## [2026-02-26 03:42] — Fix OpenRouter image generation: create dedicated provider

**Task:** OpenRouter image generation returned 404 HTML — was hitting `/images/generations` which doesn't exist on OpenRouter
**What I did:** OpenRouter uses `/chat/completions` with `modalities: ["image", "text"]` for image generation, not the `/images/generations` endpoint used by OpenAI. Created a dedicated `src/providers/image/openrouter.ts` provider that:
1. POSTs to `/api/v1/chat/completions` with `modalities: ["image", "text"]`
2. Parses the response from `choices[0].message.images[0].image_url.url` (base64 data URL)
3. Extracts MIME type and image buffer from the `data:image/png;base64,...` format
Updated provider-map to point `openrouter` to the new provider instead of `openai-images.js`. Updated default model to `google/gemini-2.5-flash-preview-image-generation`. Added 5 tests.
**Files touched:** src/providers/image/openrouter.ts (new), src/host/provider-map.ts, src/onboarding/prompts.ts, tests/providers/image/openrouter.test.ts (new)
**Outcome:** Success — 158 test files, 1629 tests pass, TypeScript build clean
**Notes:** Three distinct image generation API shapes: OpenAI (`/images/generations`, b64_json response), Gemini (`/generateContent`, inlineData parts), OpenRouter (`/chat/completions` with modalities, data URL in message.images). Each needs its own provider.

## [2026-02-26 03:20] — Expose image_generate tool to agents

**Task:** Agents couldn't generate images — the IPC handler existed but the tool wasn't exposed to any agent runner
**What I did:** Added `image_generate` to both the tool catalog (TypeBox, for pi-agent-core/pi-coding-agent) and the MCP server (Zod, for claude-code). Updated tool count from 27→28 in 4 test files, added `image_generate` to expected tool name lists in 2 test files, removed `image_generate` from `knownInternalActions` in sync test.
**Files touched:** src/agent/tool-catalog.ts, src/agent/mcp-server.ts, tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts, tests/sandbox-isolation.test.ts, tests/agent/tool-catalog-sync.test.ts
**Outcome:** Success — all 1618 tests pass, TypeScript build clean
**Notes:** The IPC handler, schema, and image providers were already fully implemented. This was purely a wiring gap — the tool was never added to the agent-facing catalog or MCP server.

## [2026-02-26 02:45] — Fix claude-code runner dropping image blocks

**Task:** Images sent via Slack to the claude-code agent were silently discarded — the agent responded "I don't see any image"
**What I did:** Root cause: `runClaudeCode()` in claude-code.ts extracted only text from `config.userMessage`, discarding all `image_data` blocks. The Agent SDK's `query()` accepts `AsyncIterable<SDKUserMessage>` with structured `MessageParam` content including `ImageBlockParam`. Fixed by: (1) extracting `image_data` blocks from `rawMsg`, (2) building `SDKUserMessage` with `ImageBlockParam` entries (base64 source), (3) passing as `AsyncIterable` to `query()` when images are present, (4) falling back to plain string when no images. Extracted the logic into a testable `buildSDKPrompt()` helper.
**Files touched:** src/agent/runners/claude-code.ts (modified), tests/agent/runners/claude-code.test.ts (modified)
**Outcome:** Success — all 1618 tests pass, TypeScript build clean, 4 new tests for buildSDKPrompt
**Notes:** This was the second bug in the image pipeline (first was missing Slack auth header for url_private downloads). Both fixes together complete the Slack → claude-code image flow.

## [2026-02-26 00:00] — Unified image generation: config simplification + image provider category

**Task:** Simplify YAML config (model+model_fallbacks → models array, add image_models array) and implement full image generation provider category
**What I did:**
1. **Config simplification**: Replaced `model: string` + `model_fallbacks: string[]` with single `models: string[]` array (first=primary, rest=fallbacks). Added `image_models: string[]` for image generation. Updated Zod schema, Config type, LLM router, wizard, server, and all YAML configs.
2. **Image provider category**: Created complete image generation subsystem:
   - `src/providers/image/types.ts`: ImageProvider interface (generate, models)
   - `src/providers/image/openai-images.ts`: OpenAI-compatible provider (covers OpenAI, OpenRouter, Groq, Fireworks, Seedream)
   - `src/providers/image/gemini.ts`: Gemini image generation via generateContent with responseModalities
   - `src/providers/image/mock.ts`: Test mock returning 1x1 transparent PNG
   - `src/providers/image/router.ts`: Multi-provider fallback router (mirrors LLM router pattern)
3. **IPC integration**: Added `image_generate` action schema, handler (writes to workspace, returns fileId), wired into ipc-server
4. **Registry**: Conditional image router loading when `config.image_models` is configured
5. **Tests**: New image router test file (8 tests), updated router/config/wizard/tool-catalog-sync/phase1/phase2 tests, updated all 6 YAML test fixtures
**Files touched:**
- New: src/providers/image/types.ts, openai-images.ts, gemini.ts, mock.ts, router.ts, src/host/ipc-handlers/image.ts, tests/providers/image/router.test.ts
- Modified: src/types.ts, src/config.ts, src/providers/llm/router.ts, src/host/provider-map.ts, src/host/registry.ts, src/ipc-schemas.ts, src/host/ipc-server.ts, src/host/server.ts, src/onboarding/wizard.ts, ax.yaml, README.md
- Modified tests: tests/providers/llm/router.test.ts, tests/config.test.ts, tests/onboarding/wizard.test.ts, tests/agent/tool-catalog-sync.test.ts, tests/integration/phase1.test.ts, tests/integration/phase2.test.ts, + 6 YAML fixtures
**Outcome:** Success — 152 test files, 1537 tests pass, 0 failures
**Notes:** Key design: two implementation patterns cover all backends — OpenAI-compatible (same /v1/images/generations endpoint) for most providers, and Gemini (generateContent with image modalities) for Google. Aggregators like OpenRouter just need a different base URL. The compound model ID pattern (`provider/model`) and static provider allowlist work identically to the LLM layer.

## [2026-02-25 18:06] — Complete image_data pipeline: Anthropic, persistence guard, tests

**Task:** Finish the image_data pipeline — Anthropic provider support, defense-in-depth persistence guard, and comprehensive tests.
**What I did:**
1. Added `image_data` block handling to Anthropic provider's `toAnthropicContent()` — converts directly to Anthropic `base64` image source without disk round-trip. Exported the function for testability.
2. Added defense-in-depth guard to `serializeContent()` in conversation-store.ts — filters out any `image_data` blocks before JSON serialization, preventing accidental base64 leakage into SQLite.
3. Added tests:
   - `conversation-store-structured.test.ts`: 2 tests verifying image_data blocks are stripped during serialization
   - `server-completions-images.test.ts`: 3 tests for `extractImageDataBlocks()` — pass-through, single extraction with disk write, multiple interspersed blocks
   - `anthropic.test.ts`: 4 tests for `toAnthropicContent()` — string passthrough, image_data conversion, image fallback, image with resolver
   - `slack.test.ts`: 1 test for external upload flow (getUploadURLExternal → PUT → completeUploadExternal), updated mock to include new API methods
4. Fixed TypeScript build error: `Buffer` → `new Uint8Array(buffer)` for `fetch` body compatibility.
**Files touched:** src/providers/llm/anthropic.ts, src/conversation-store.ts, src/providers/channel/slack.ts, tests/conversation-store-structured.test.ts, tests/host/server-completions-images.test.ts, tests/providers/llm/anthropic.test.ts, tests/providers/channel/slack.test.ts
**Outcome:** Success — 76/76 tests pass across all 6 affected test files. TypeScript build clean (only pre-existing @opentelemetry missing package errors).
**Notes:** The `toAnthropicContent` function was unexported — had to export it for direct testing. The Buffer-to-Uint8Array conversion was needed because Node.js fetch's BodyInit doesn't accept Buffer directly in strict TypeScript mode.

## [2026-02-25 17:00] — Add image_data transient block type and in-memory image pipeline (WIP)

**Task:** Enable agents to generate images (via tool_result image_data blocks) and have them flow through the pipeline to Slack as file uploads, without persisting raw base64 in conversation history or on disk unnecessarily.
**What I did:**
1. Added `image_data` content block type to `src/types.ts` and its Zod schema to `src/ipc-schemas.ts`
2. Updated `src/host/server-completions.ts`: `extractImageDataBlocks()` pulls image_data blocks out of agent response, decodes base64 to Buffer, writes to workspace, and returns both workspace-relative file refs (for persistence) and in-memory ExtractedFile buffers (for outbound). New `ExtractedFile` type and `CompletionResult.extractedFiles` field.
3. Updated `src/host/server-channels.ts`: outbound attachment path now uses in-memory `extractedFiles` Map for O(1) lookup, falling back to disk read for file refs not in the map.
4. Updated `src/providers/channel/slack.ts`: replaced deprecated `files.uploadV2` with modern 3-step external upload flow (`files.getUploadURLExternal` → PUT → `files.completeUploadExternal`).
**Files touched:** src/types.ts, src/ipc-schemas.ts, src/host/server-completions.ts, src/host/server-channels.ts, src/providers/channel/slack.ts
**Outcome:** Partial — core pipeline is wired up. Still need: Anthropic provider image_data handling, conversation store persistence guard, tests.
**Notes:** The `image_data` block type is transient — it should never be serialized into conversation history. The extraction step in server-completions replaces image_data blocks with persistent `image` (file ref) blocks before storing.

## [2026-02-25 05:00] — Add image support in chat (both directions)

**Task:** Add image support in chat messages (inbound and outbound), using file references instead of embedded data, with file storage in workspace and HTTP API for web UI upload/download
**What I did:** Full-stack implementation across 15+ files:
1. **Content types**: Added `image` variant to `ContentBlock` union (`{ type: 'image', fileId, mimeType }`) in types.ts and Zod schema in ipc-schemas.ts
2. **HTTP file API**: Created `server-files.ts` with `POST /v1/files` (upload, 10MB limit, UUID naming) and `GET /v1/files/*` (download with correct Content-Type). Wired in server.ts.
3. **LLM integration**: Made `toAnthropicContent()` async with `resolveImageFile` callback that reads files from workspace and base64-encodes for Anthropic Vision API. Added `ResolveImageFile` type to LLM provider types. Wired image resolver through ipc-handlers/llm.ts using session workspace.
4. **Conversation store**: Added `serializeContent()`/`deserializeContent()` for `string | ContentBlock[]` — JSON.stringify for arrays, auto-detect on load.
5. **Server pipeline**: Updated server-completions.ts for structured content, added `parseAgentResponse()` for `__ax_response` structured response protocol, updated server-http.ts request types.
6. **Slack integration**: Added `buildContentWithAttachments()` for inbound Slack image attachments (downloads, stores in workspace, returns ContentBlock[]). Added outbound image block → Slack file upload conversion.
7. **Agent runner**: Updated `ConversationTurn`, `StdinPayload`, `AgentConfig` to support `string | ContentBlock[]`. Added `extractText()` helper. Updated claude-code.ts and pi-session.ts to handle structured content.
8. **Binary file IPC**: Added `workspace_write_file` tool to catalog, MCP server, and workspace IPC handler for agent-side binary file writes (base64-encoded).
9. **Tests**: 5 new test files (server-files, conversation-store-structured, workspace-file, runner-images, server-completions-images) + updated 4 test files for tool count 23→24.
**Files touched:**
- New: src/host/server-files.ts, tests/host/server-files.test.ts, tests/conversation-store-structured.test.ts, tests/host/ipc-handlers/workspace-file.test.ts, tests/agent/runner-images.test.ts, tests/host/server-completions-images.test.ts
- Modified: src/types.ts, src/ipc-schemas.ts, src/providers/llm/types.ts, src/providers/llm/anthropic.ts, src/host/ipc-handlers/llm.ts, src/host/server.ts, src/host/server-http.ts, src/host/server-completions.ts, src/host/server-channels.ts, src/conversation-store.ts, src/agent/runner.ts, src/agent/runners/claude-code.ts, src/agent/runners/pi-session.ts, src/host/ipc-handlers/workspace.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts
- Modified tests: tests/sandbox-isolation.test.ts, tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts
**Outcome:** Success — 150 test files, 1491 tests pass (1 pre-existing skip)
**Notes:** Key design decisions: (1) No base64 in chat messages — file references only, resolved at LLM call time. (2) Session-scoped file storage via existing workspaceDir(). (3) HTTP API uses raw binary body (not multipart) for simplicity. (4) Structured content backward-compatible — plain strings still work everywhere. (5) Agent-side binary writes use base64 encoding through IPC. (6) Slack integration reuses existing channel attachment infrastructure.
