# Agent

### When binding correlation IDs into module-level loggers, do it in EVERY module that has its own `getLogger().child(...)`
**Date:** 2026-04-22
**Context:** Task 2 of chat-correlation-id added `AX_REQUEST_ID` -> `reqId` binding only on `src/agent/runner.ts`. Code review flagged that `runner.ts` is a thin dispatcher; the actual hot path (`runners/pi-session.ts`, `runners/claude-code.ts`) has its own module-level `logger = getLogger().child({ component: '...' })`, and those don't inherit the parent's bindings — they're siblings of the runner.ts child, not children of it. So `grep <reqId>` lit up the dispatcher and went dark for 99% of execution chatter.
**Lesson:** Pino child loggers inherit bindings from THEIR parent only. Two `getLogger().child({...})` calls in different modules are siblings (both children of the root logger), not parent/child. When propagating a contextual binding (reqId, sessionId, etc.) via the "read env at module load" pattern, audit ALL modules that build their own `getLogger().child({ component })` and apply the same env-bound recipe to each. Or refactor `getLogger()` itself to apply the binding centrally — but that has wider blast radius and only works if the env var is set before `getLogger()` is first called.
**Tags:** logging, pino, child-logger, correlation-id, sandbox-env, hidden-coupling

### LLM tool dispatch: prefer CLI shims over embedded-script execution
**Date:** 2026-04-21
**Context:** Replacing `execute_script` after observing 7-call thrash patterns in the kind cluster. Agents kept probing response shapes instead of iterating effectively.
**Lesson:** When the LLM needs to invoke tools with dynamic args or multi-step composition, give it native shell commands (symlinked catalog tools in PATH) and let it use bash + jq. This plays to its trained-on pattern: stream composition via pipes, filesystem as persistent state, atomic observable calls, linear errors. Embedded-script models (write-compile-run-correctly-first-try in a stateless subprocess) penalize the shape-learning iteration LLMs rely on.
**Tags:** tool-dispatch, cli, prompt-engineering, agent-design

### Removing a catalog entry is NOT enough — MCP server registrations are load-bearing
**Date:** 2026-04-21
**Context:** Task 11 of the tool-cli-shims plan was supposed to be a surgical "remove `execute_script` from `TOOL_CATALOG` only; handler and wiring stay" commit. The theory was that a `git revert` of just this commit could bring the tool back for the LLM if something regressed, while the handler served as a safety net. Reality: `src/agent/mcp-server.ts` registers `execute_script` at server-creation time with `tool('execute_script', getToolDescription('execute_script'), ...)`. That `getToolDescription` throws `Unknown tool: execute_script` the instant the catalog entry is gone, which blows up `createIPCMcpServer()` entirely. The claude-code runner boots an MCP server on startup → whole runner is broken, not just the LLM-visible tool list.
**Lesson:** Before splitting "hide from LLM" from "delete handler" into two separately-revertable commits, grep the codebase for `getToolDescription('<name>')` AND any other unconditional references to the tool name. If any trusted subsystem reads the catalog entry at module-load or object-construction time (not just at dispatch time), the two-step retirement pattern does NOT work — removing the catalog entry alone is a breaking change, and the "single-commit rollback" safety story is a fiction. In those cases either (a) make the consumer resilient to a missing entry first, or (b) land catalog removal + wiring removal in the same commit. Same principle applies to any "soft-retire via config flag" pattern where downstream code treats the config entry as required.
**Tags:** catalog, mcp-server, rollback-strategy, two-step-deprecation, tool-catalog, hidden-coupling

### `!==` checks on string sentinels have an empty-string hole — use `&&`-guarded checks
**Date:** 2026-04-21
**Context:** Task 5's argv[0] shim dispatch used `if (argv0 !== 'tool') { return callTool(argv0, argv, opts); }` to detect busybox-style invocation. Code reviewer pointed out: `'' !== 'tool'` is `true`, so an empty-string `argv0` would be treated as a shim invocation and fire an IPC `call_tool` with `tool: ''`. The `?? 'tool'` fallback in `index.ts` (`basename(process.argv[1] ?? 'tool')`) didn't fully close the hole because `basename('')` returns `''`, not `'tool'`.
**Lesson:** When using `!== '<sentinel>'` to detect a "special" value and fall through to the default branch otherwise, remember the falsy values slip through. For string sentinels, use `if (x && x !== '<sentinel>')` so empty/undefined/null all fall through to the default path. Equivalent for arrays: `if (arr.length > 0 && ...)`. The TDD signal here is cheap: add one test that passes the empty value — it'll flag this class of bug in seconds.
**Tags:** defensive-coding, string-checks, argv0-dispatch, tool-cli, sentinel-values
**Date:** 2026-04-21
**Context:** `src/cli/tool/flags.ts` was coercing any string matching `/^-?\d+(\.\d+)?$/` via `Number(raw)`. A 20-digit Linear/GitHub ID (e.g. `12345678901234567890`) passes the regex but exceeds `Number.MAX_SAFE_INTEGER` (2^53 ~ 9e15) and silently rounds. Worse, `--id=007` becomes `7` because `Number("007") === 7`. Both silently dispatch to wrong entities.
**Lesson:** When coercing stringly-typed user input to a narrower type, always check the round-trip. After `const n = Number(raw)`, gate on `String(n) === raw` — if they differ, coercion lost info (big ints, leading zeros, exotic forms like `1e3`) so keep the string. The regex gate alone is NOT sufficient. This pattern generalizes to any type narrowing: if the narrower type's serialization doesn't round-trip to the original input, you've changed the data. Don't.
**Tags:** type-coercion, flag-parsing, number-precision, tool-cli, safe-integer, round-trip-invariant

### Preamble-injected schemas should carry only what the preamble actually validates
**Date:** 2026-04-20
**Context:** Task 6.4 needed `ax.callTool` to throw actionable per-tool errors before the IPC call. First instinct was to embed each catalog tool's full JSON schema in `__AX_TOOL_SCHEMAS__` so the preamble could do type checking, enum checking, etc. locally. That duplicates what the host's Zod boundary already enforces and bloats every script's preamble by multiple KB.
**Lesson:** The preamble's role is to catch the two mistakes that dominate agent failures (bare-string args and missing required keys) — not to re-implement Zod client-side. Ship a compact `{properties: string[], required: string[]}` map, not the full schema. With 50 tools × 5 props each that's ~70 bytes/tool. The host still does full validation at the IPC boundary, so per-property type errors get the same actionable message they always did — just one network hop later. Don't pay preamble bytes for validation the host already runs.
**Tags:** execute-script, preamble, tool-dispatch-unification, ax.callTool, schema-injection, tradeoff

### Conditional catalog tools piggyback on ToolFilterContext, not parallel registration paths
**Date:** 2026-04-19
**Context:** Task 3.5 of tool-dispatch-unification needed to register `describe_tools` + `call_tool` ONLY in `indirect` mode. First instinct was to add a conditional registration branch in `createIPCToolDefinitions` / `createIPCMcpServer`. That splinters a single registration path into two shapes and makes the sync test (tool-catalog <-> mcp-server) awkward.
**Lesson:** When a tool is conditional on a config flag, put the flag on `ToolFilterContext` (not the factory's opts). Keep the registration path single-shape: the tool always lives in `TOOL_CATALOG` and `mcp-server.ts`'s `allTools`, and `filterTools(ctx)` drops it based on the flag. This means the sync tests, tool-count tests, and integration tests keep working uniformly — no "in mode X, TOOL_CATALOG has Y tools; in mode Z, it has W" branching. Host ships the flag via the stdin payload; `buildSystemPrompt` threads it into `toolFilter`. One source of truth, one filter point.
**Tags:** tool-catalog, mode-filtering, tool-dispatch-unification, filterTools, architecture

### Soft "read X and follow it" prompts lose to familiar training patterns — name the anti-patterns explicitly
**Date:** 2026-04-18
**Context:** Admin reported the agent produced a `.ax/skills/linear/SKILL.md` that parsed as INVALID. The agent wrote `claude_desktop_config.json`-style YAML (`title:`, bare credential strings, `mcp: { type: stdio, command: npx, args: [...] }`) inside a ```yaml fenced block, with a `# Linear Skill` heading on line 1 instead of frontmatter. AX's parser requires `---` on line 1 with strict Zod fields. The skills module prompt said "read `.ax/skills/skill-creator/SKILL.md` and follow it" — too soft; the model pattern-matched to "I know MCP configs" and improvised from training.
**Lesson:** When the model has a strong, familiar pattern from training (Claude Desktop MCP config, generic `.env` files, etc.) that conflicts with our actual format, a "read X and follow it" instruction is not enough. Name the anti-patterns explicitly ("do NOT improvise from training; the parser rejects: YAML in a fenced code block, `title:` instead of `name:`, bare credential strings, stdio MCP, unknown top-level keys") AND include a WRONG/RIGHT side-by-side in the target doc. The anti-pattern list is what trips the guardrail — the model's "I know this" reflex has to collide with a named rejection to stop. Also pin those strings with a regression test so future edits can't quietly soften the guardrails back.
**Tags:** prompt-engineering, skills, anti-patterns, training-priors, skill-creator, frontmatter
### RuntimeModule short-circuits in bootstrap mode — integration tests must seed identity
**Date:** 2026-04-18
**Context:** Adding an integration test in `tests/agent/agent-setup.test.ts` that asserted on the Runtime module's render block (at the time, `/workspace/.ax/tools/` guidance; post-Phase-6 the Runtime module renders the tool catalog instead — but the bootstrap-mode gotcha is unchanged). Test failed because the rendered prompt contained only `## Skills`, not the Runtime section at all.
**Lesson:** `RuntimeModule.shouldInclude(ctx)` short-circuits to `false` in bootstrap mode — and `isBootstrapMode(ctx)` is true whenever `identityFiles.soul` OR `identityFiles.identity` is empty. The default `loadIdentityFiles(undefined)` zeroes every field, so ANY agent-setup integration test that asserts on Runtime output (or any non-bootstrap module) must pass `config.identity: { soul: 'X', identity: 'Y', ... }`. Unit tests at the module level already know this; the gotcha is only at the `buildSystemPrompt` integration boundary.
**Tags:** prompt, runtime-module, bootstrap-mode, integration-test, agent-setup

### ALL LLM providers must handle image_data and file_data ContentBlocks — not just Anthropic
**Date:** 2026-04-01
**Context:** After fixing runners to inject `file_data` blocks into IPC messages, PDFs still weren't summarized. The Anthropic provider's `toAnthropicContent()` handled `file_data` → `document` blocks correctly, but the deployed model was `openrouter/google/gemini-3-flash-preview` which routes through `openai.ts`. Its `toOpenAIMessages()` only extracted `text` blocks from `ContentBlock[]`, silently dropping `file_data` and `image_data`.
**Lesson:** When adding new ContentBlock types, you must update ALL LLM providers, not just the Anthropic one. The OpenAI-compat provider (`src/providers/llm/openai.ts`) is used by OpenRouter, DeepInfra, and any provider with an OpenAI-compatible API. For OpenAI format: `image_data` → `{ type: 'image_url', image_url: { url: 'data:mime;base64,...' } }`, `file_data` → `{ type: 'file', file: { file_data: 'data:mime;base64,...', filename: '...' } }`. The model in the deployed config determines which provider path is used — check `config.models.default` to know which provider will actually handle the content.
**Tags:** llm-provider, openai-compat, openrouter, file-data, image-data, content-blocks, gemini

### Both runners must handle ALL ContentBlock types from server — not just text
**Date:** 2026-03-31
**Context:** PDF attachments uploaded via chat UI were silently dropped. The server correctly converted PDFs to `file_data` blocks, but both pi-session.ts and claude-code.ts only extracted `text` type blocks, discarding `file_data`. Markdown worked coincidentally because the server converts it to `text` blocks.
**Lesson:** When the server resolves file attachments, it produces different ContentBlock types depending on MIME type: `text` for text-like files, `file_data` for binary (PDFs, etc.), `image_data` for images. Runner code that extracts content from `rawMsg` MUST handle all three. For the proxy path (direct Anthropic SDK), `file_data` must be converted to Anthropic `document` blocks. For the IPC path, `file_data` blocks pass through because `toAnthropicContent()` on the host handles them.
**Tags:** runner, content-blocks, file-attachment, pdf, pi-session, claude-code, proxy

### New ContentBlock types MUST be added to ipc-schemas.ts contentBlock union
**Date:** 2026-03-31
**Context:** After adding `file_data` block support to runners, the IPC `llm_call` still failed because the Zod schema in `ipc-schemas.ts` uses `.strict()` mode and didn't include `file_data` as a valid content block variant. The error was `"messages.1.content: Invalid input"` — not immediately obvious as a schema mismatch.
**Lesson:** When adding a new ContentBlock type to `src/types.ts`, you MUST also add a corresponding variant to the `contentBlock` Zod union in `src/ipc-schemas.ts`. The IPC layer validates every field with `.strict()`, so unknown block types are silently rejected. Check both `types.ts` AND `ipc-schemas.ts` whenever a new content type is introduced.
**Tags:** ipc, zod, schema, validation, content-blocks, strict-mode

### Generated CLIs must not block on stdin when spawned as subprocess
**Date:** 2026-03-30
**Context:** MCP CLI tools generated by generateCLI() hung indefinitely when the bash tool spawned them as subprocesses. The readStdin() function waited for EOF on process.stdin, but the parent process (spawn with stdio: ['pipe', 'pipe', 'pipe']) never closed the stdin pipe.
**Lesson:** When generating CLI tools that may be spawned as subprocesses, never do `for await (const chunk of process.stdin)` without a timeout. Use a short timeout (e.g., 50ms) on stdin reading so the CLI doesn't block when no data is piped in, while still supporting piped JSON input for the `cmd1 | cmd2` use case.
**Tags:** codegen, stdin, subprocess, blocking, spawn, cli

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
