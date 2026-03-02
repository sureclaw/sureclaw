# Agent

### pi-coding-agent does NOT re-export pi-agent-core types
**Date:** 2026-02-27
**Context:** Removing pi-agent-core as a user-facing agent type — expected to also drop the npm dep
**Lesson:** `@mariozechner/pi-coding-agent` does not re-export `Agent`, `AgentTool`, `StreamFn`, or `AgentMessage` from `@mariozechner/pi-agent-core`. If you need these types, you must either keep pi-agent-core as a direct dep or create a local barrel re-export. Check package exports (`dist/index.d.ts`) before assuming transitive deps surface their types.
**Tags:** pi-agent-core, pi-coding-agent, npm, types, dependencies

### claude-code.ts should use shared buildSystemPrompt() like other runners
**Date:** 2026-02-26
**Context:** claude-code.ts manually duplicated prompt building logic (importing PromptBuilder, loadIdentityFiles, loadSkills directly). Refactoring it to use shared buildSystemPrompt() from agent-setup.ts simplified the code and gave it the toolFilter for free.
**Lesson:** When all runners need the same derived data (system prompt + filter context), use the shared `buildSystemPrompt()` from agent-setup.ts. Don't duplicate the prompt-building logic in individual runners. If a runner needs custom prompt context fields, extend AgentConfig rather than reimplementing.
**Tags:** runners, claude-code, prompt, agent-setup, refactoring

### claude-code runner discards non-text content blocks — must extract and forward via SDKUserMessage
**Date:** 2026-02-26
**Context:** Images from Slack were downloaded correctly and passed to the agent as `image_data` ContentBlocks, but the claude-code runner stripped them to text-only
**Lesson:** The `runClaudeCode()` runner filters `config.userMessage` to text-only (`b.type === 'text'`), then passes a plain string to the Agent SDK `query()`. To forward images, extract `image_data` blocks separately, build an `SDKUserMessage` with `MessageParam.content` containing both `TextBlockParam` and `ImageBlockParam` entries, and pass as `AsyncIterable<SDKUserMessage>` to `query()`. The `ImageBlockParam.source` uses `{ type: 'base64', media_type, data }` matching Anthropic's `Base64ImageSource`. Note: the `media_type` field must be a literal union type, not `string` — cast `ImageMimeType as AnthropicMediaType`.
**Tags:** claude-code, agent-sdk, images, SDKUserMessage, ImageBlockParam, vision

### Retry logic must check for valid output before retrying
**Date:** 2026-02-27
**Context:** Agents completed work but got retried because the tsx wrapper crashed with exit code 1
**Lesson:** When an agent subprocess exits non-zero but produced valid stdout output, accept the output instead of retrying. The wrapper crash is irrelevant if the agent finished its work. In `server-completions.ts`, check `response.trim().length > 0` before entering the transient-failure retry path.
**Tags:** retry, fault tolerance, agent lifecycle, exit codes

### Agent messages must flow through trusted host — never sandbox-to-sandbox
**Date:** 2026-02-28
**Context:** Designing inter-agent messaging for the orchestration system
**Lesson:** Even though agents need to talk to each other, messages MUST route through the host process. The sandbox security boundary means agents have no network access and cannot reach each other's IPC sockets. The host mediates all communication: validates messages, enforces scope (same-session only), checks sender/recipient status, and logs to audit. This is more latency than direct messaging but preserves the security invariant that sandboxes are isolated.
**Tags:** security, messaging, orchestration, sandbox, ipc, agent-communication
