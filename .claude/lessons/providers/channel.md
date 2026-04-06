# Provider Lessons: Channel

### Slack url_private URLs require Authorization header — plain fetch fails silently
**Date:** 2026-02-25
**Context:** Debugging why Slack image attachments resulted in "I don't see any image" from the LLM
**Lesson:** Slack's `url_private` URLs (returned in file attachment objects) require `Authorization: Bearer <bot_token>` to download. A plain `fetch(url)` returns 401/302, and if the download failure is caught+continued (like in buildContentWithAttachments), the image is silently dropped. Any channel provider that has authenticated URLs needs a `downloadAttachment` method to handle auth — don't put auth knowledge in the generic download pipeline.
**Tags:** slack, url_private, authentication, image-attachments, silent-failure

### Slack file upload: use SDK's files.uploadV2(), not manual 3-step flow
**Date:** 2026-02-26
**Context:** Manual 3-step Slack file upload (getUploadURLExternal -> HTTP PUT -> completeUploadExternal) silently failed — files uploaded but not shared to channel (mimetype: "", shares: {}, channels: []).
**Lesson:** Slack's upload URL expects HTTP POST, not PUT. Using PUT causes the file to be created but not properly processed — no mimetype detection, no channel sharing. This is a known issue (bolt-js #2326). Always use the Slack SDK's `files.uploadV2()` method instead of implementing the 3-step flow manually. It handles POST correctly and wraps the entire flow. Use `initial_comment` to combine text + file as a single message.
**Tags:** slack, file-upload, uploadV2, http-method, put-vs-post

### OS username != channel user ID — admins file seed doesn't help channels
**Date:** 2026-02-22
**Context:** Bootstrap gate blocks all Slack users because admins file is seeded with `process.env.USER` (OS username) but Slack messages come with Slack user IDs
**Lesson:** When seeding identity/access files, remember that the seeded value (OS username) only works for CLI/local access. Channel providers (Slack, Discord, etc.) use their own user ID formats. For channel access during bootstrap, use an auto-promotion mechanism (`.bootstrap-admin-claimed` atomic claim file) to let the first channel user become admin.
**Tags:** bootstrap, admin, channels, slack, user-id, access-control

### Node.js Buffer -> fetch body: use standalone ArrayBuffer to avoid detached buffer errors
**Date:** 2026-02-25
**Context:** Slack file upload failed with "fetch failed" / "Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer"
**Lesson:** Node.js Buffers share an internal memory pool. When passing binary data to `fetch()` as a body, `new Uint8Array(buffer)` still references the pool's shared ArrayBuffer, which undici detaches during send. The fix is to create a standalone ArrayBuffer: `const ab = new ArrayBuffer(buf.byteLength); new Uint8Array(ab).set(buf);` then pass `ab` as the body. This ensures the ArrayBuffer is independent of the Buffer pool and won't be detached prematurely.
**Tags:** node, buffer, fetch, undici, arraybuffer, detached, slack, upload

### Node.js fetch body does not accept Buffer in strict TypeScript
**Date:** 2026-02-25
**Context:** Passing `att.content` (a Buffer) as `body` to `fetch()` in the Slack provider caused TS2769 — `Buffer` is not assignable to `BodyInit`.
**Lesson:** Wrap Buffer with `new Uint8Array(buffer)` when passing to `fetch()` body. Uint8Array is accepted by BodyInit; Buffer (which extends Uint8Array) is not in strict mode because of extra properties.
**Tags:** typescript, fetch, buffer, slack

### Multi-agent Slack: thread ownership is in-memory — not suitable for multi-pod
**Date:** 2026-04-04
**Context:** Implementing ThreadOwnershipMap for per-message agent routing in multi-agent Slack UX
**Lesson:** ThreadOwnershipMap stores thread-to-agent bindings in a plain Map (in-memory). This works for single-pod local deployments but would lose ownership tracking across pod restarts or in multi-pod k8s. If needed for k8s, move to a shared store (Redis, DB table, or NATS KV).
**Tags:** slack, multi-agent, thread-ownership, scalability, k8s

### Shared agents need separate Slack app registrations
**Date:** 2026-04-04
**Context:** Designing shared agent startup with per-agent Slack tokens
**Lesson:** Each shared agent requires its own Slack app registration with separate bot/app tokens. The env var convention is `{AGENT_ID_UPPERCASE}_SLACK_BOT_TOKEN` and `{AGENT_ID_UPPERCASE}_SLACK_APP_TOKEN`. If tokens are missing, the shared agent is silently skipped with a warning log. This matches the existing pattern of optional channel providers.
**Tags:** slack, multi-agent, shared-agents, tokens, configuration
