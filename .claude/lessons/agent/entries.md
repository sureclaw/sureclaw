# Agent

### Prompt instructions must specify exact tool names and paths — not just filesystem locations
**Date:** 2026-03-26
**Context:** Agent was making 10+ attempts to read a skill SKILL.md file — trying workspace_read, read_file, bash cat, bash find — because the skills prompt said "read from ./user/skills/" without specifying which tool.
**Lesson:** When telling the agent to access a resource in the system prompt, always specify the exact tool name AND a concrete parameter example. Vague "read from" instructions cause the LLM to guess across multiple tools. Explicitly ban wrong tools if there are common confusions (e.g., "Do NOT use workspace_read for this").
**Tags:** prompt, skills, tool-guidance, LLM-behavior

### request_credential returns immediately — the agent must be told to stop
**Date:** 2026-03-26
**Context:** Agent called request_credential, got available=false, then kept trying to run the skill script and call APIs without the credential. The tool description said "ends the current turn" but nothing enforced it.
**Lesson:** IPC tools that expect the agent to change behavior (like stopping) must have IMPERATIVE instructions in the description, not passive descriptions. "This ends the current turn" is passive; "you MUST stop immediately" is imperative. The LLM treats tool descriptions as suggestions unless the language is directive.
**Tags:** credential, tool-description, LLM-behavior, prompt

### web_fetch IPC bypasses MITM proxy — no credential placeholder replacement
**Date:** 2026-03-26
**Context:** Agent fell back from bash (skill script) to web_fetch IPC to call Linear API. web_fetch goes through IPC to the host, which makes the HTTP request directly — not through the MITM proxy. Credential placeholders in headers are sent as-is.
**Lesson:** The `web_fetch` IPC tool cannot inject credentials. Only bash/curl child processes benefit from credential placeholder replacement (via HTTP_PROXY → MITM proxy). If the agent falls back from a skill script to web_fetch, credentials won't work. This is a design gap.
**Tags:** credential, web_fetch, proxy, MITM, IPC

### Debugging k8s credential issues: kubectl exec vs runner process.env
**Date:** 2026-03-26
**Context:** Used `kubectl exec` to inspect sandbox pod env — saw `SSL_CERT_FILE=/etc/ax/ca.crt` (doesn't exist) and `HTTP_PROXY=NOT SET`. Thought credentials were broken. But `kubectl exec` shows pod-spec env, not the runner's `process.env` which is updated at runtime.
**Lesson:** `kubectl exec` starts a fresh process with pod-level env vars. The runner modifies `process.env` after processing the work payload (writes CA cert to /tmp/, sets HTTP_PROXY/HTTPS_PROXY, updates SSL_CERT_FILE). Child processes spawned BY the runner inherit the updated env. Diagnose by: (1) check host logs for `credential_injected`, (2) check `/tmp/ax-ca-bundle.pem` exists, (3) test curl with manually-set env vars matching what the runner would set.
**Tags:** k8s, kubectl, debugging, process-env, credential, proxy

### HttpIPCClient has two token scopes — don't conflate them
**Date:** 2026-03-25
**Context:** Chat UI stuck on "Thinking..." after turn 3. `fetchWork()` used `this.token` which `setContext()` rotates per-turn for IPC routing. After turn 2, the work-fetch poll sent the wrong token to session-pod-manager, getting 404 forever.
**Lesson:** `HttpIPCClient` has two distinct tokens: (1) the pod's **auth token** (`AX_IPC_TOKEN` from env, used for `GET /internal/work`) — this is the pod identity, registered once in `tokenToSession`. (2) The **per-turn IPC token** (from payload's `ipcToken`, set via `setContext()`) — used for `POST /internal/ipc` calls and LLM proxy. These must never be conflated. `fetchWork()` must always use the original auth token.
**Tags:** http-ipc-client, session-pod-manager, token, k8s, work-fetch, multi-turn

### Weaker models rename discriminator fields — always normalize before actionMap lookup
**Date:** 2026-03-15
**Context:** Gemini Flash sent `{"operation":"fetch"}` instead of `{"type":"fetch"}` for the `web` multi-op tool, causing silent tool failure and hallucinated content
**Lesson:** Tool descriptions saying "Operations:" can cause Gemini/weaker models to use `operation` instead of `type` as the discriminator field. Always use `extractTypeDiscriminator()` from tool-catalog.ts when destructuring multi-op tool params — it checks common aliases (operation, action, op, command, method). This is the same pattern as `normalizeOrigin()` and `normalizeIdentityFile()` but at the discriminator level. When debugging "agent hallucination" bugs, always check server logs for whether the tool was called and what params were sent — the root cause may be param naming, not missing tool calls.
**Tags:** gemini, tool-catalog, normalization, discriminator, hallucination, debugging

### Apple Container listen-mode IPCClient must receive session context after stdin
**Date:** 2026-03-14
**Context:** Debugging "No workspace registered for session" error with Apple Container sandbox
**Lesson:** In Apple Container listen mode, the IPCClient is created before stdin is parsed (to start the listener early for the host bridge). If the early client is stored on `config.ipcClient`, the runner's `??` operator skips creating a new client with sessionId. Always call `setContext()` on the early client after stdin provides the sessionId, otherwise IPC messages lack `_sessionId` and the host falls back to a mismatched bridge context sessionId.
**Tags:** apple-container, ipc, listen-mode, sessionId, workspace, sandbox

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
