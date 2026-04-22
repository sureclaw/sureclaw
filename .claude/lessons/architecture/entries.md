# Architecture

## Multistream loggers need a per-stream FLOOR equal to the most-permissive child override
**Date:** 2026-04-22
**Context:** Task 7 review revealed a subtle bug: `wrapPino.child` correctly set `child.level='debug'` when `LOG_LEVEL_<COMPONENT>=debug` was configured, but in production code paths (pretty/syncFile/transport) the pino instance was wired with `pino.multistream(streams)` where each stream had its OWN `level` filter. So a child's debug message would clear pino's child gate and reach the multistream — only to be silently dropped by the per-stream `level: 'info'` filter. The single-stream test path (`opts.stream`) never exercised this because the pino root's `level` was the only filter there. Tests passed; production was broken. The fix: at logger init, scan all `LOG_LEVEL_*` env vars (plus `LOG_LEVEL`) and compute the minimum (most-permissive); set the per-stream/per-target `level` to that minimum. Root pino keeps the no-component resolved level so non-component callers still filter at LOG_LEVEL.
**Lesson:** When a pino logger has BOTH a root `level` AND a per-stream `level` (multistream/transport), child-level overrides only "work" if the per-stream filter is at least as permissive as the most-permissive override. The right architecture: root pino level = the default (so non-component callers filter normally), per-stream level = the minimum across all configured overrides (so any child the operator widens can clear the floor), child.level = the per-component override (the actual gate). Tests for log-filter behavior MUST cover the multistream/transport path, not just the single-stream test branch — spy on `pino.multistream` to capture the streams array AND inject a Writable in place of the FD destination, so you can assert both the configured per-stream level and what actually flows through.
**Tags:** logger, pino, multistream, log-levels, per-component, testing-coverage, regression-test

## Per-component log levels: env-var convention + child() honors override
**Date:** 2026-04-22
**Context:** Task 7 of chat-correlation added `LOG_LEVEL_<COMPONENT>` env support so an operator can crank one noisy subsystem to debug without drowning the rest of the host. Two design choices: (a) the convention itself — `sandbox-k8s` → `LOG_LEVEL_SANDBOX_K8S` (uppercase + hyphens-to-underscores), no allowlist needed, deterministic mapping; (b) where the override applies — only `createLogger({component})` would have missed the dominant call pattern in the codebase, which is `getLogger().child({component: 'foo'})`. So `wrapPino.child` ALSO inspects the bindings for a `component` key and applies the env override. Resolution priority: explicit `level` opt → `LOG_LEVEL_<COMPONENT>` → `LOG_LEVEL` → `'info'`. The "explicit wins" rule required a separate `bindComponent` helper inside `createLogger` that uses pino's child directly (bypassing the env override) when the level was already resolved from explicit `opts.level`.
**Lesson:** When adding env-var operator overrides to a logger, (1) pick a deterministic name mapping and document it in code comments at the resolver site, (2) make BOTH the construction-time API and the dominant `child({field})` pattern honor the override (otherwise call sites silently miss it), (3) preserve the "explicit caller intent always wins" rule by routing the construction-time component-binding step through a code path that bypasses the env override. The widening happens at child-creation time, so changing env vars after process start has no effect — operators set these at deploy time, which is the right time anyway.
**Tags:** logger, observability, env-vars, log-levels, per-component, operator-tooling

## Logging hygiene: warn/info/error level semantics tied to chat lifecycle
**Date:** 2026-04-22
**Context:** Task 7's reclassification pass exposed an inconsistent mental model: warn was used for both "operator should look at this" and "this could mean the chat dies." The clearer rule that emerged: tie levels to the chat-lifecycle outcome. (1) Recoverable failures where the chat continues with degraded behavior (host_git_sync_failed, host_identity_fetch_failed, memory_recall_error) → info, not warn. (2) Per-attempt failures inside retry loops (agent_response_error) → info, not warn — retries may succeed. (3) Chat-fatal at a layer (pod_failed, pod_watch_error, pod_timeout in the sandbox provider) → error, even if the host's retry loop ultimately masks it with a successful retry. (4) Cleanup/operational issues (pod_cleanup_failed for non-404, sandbox_state_unavailable_fallback, tcp_bind_failed) → warn. The canonical chat outcome is the single chat_complete (info) or chat_terminated (error) line — that's what operators scan; everything else is fill-in detail at debug.
**Lesson:** When picking a log level, ask "would an operator paged at 3 AM care about THIS line?" If yes → error or warn. If only useful when debugging one specific chat → debug. The chat-fatal vs recoverable split is more useful than warn-as-default. Per-attempt failures inside a retry loop are NOT chat-fatal because the retry may succeed — they're info; the terminal chat_terminated is the only real failure escalation.
**Tags:** logger, log-levels, chat-lifecycle, observability, operator-experience

## Shell out to `jq` rather than bundling node-jq or jq-wasm for `_select` projection
**Date:** 2026-04-22
**Context:** `call_tool`'s `args._select` is a jq string that filters/reshapes the response before it lands in the agent's context. Three implementation choices: (a) `node-jq` (native binding — extra build step, prebuilds per arch, hard to debug), (b) `jq-wasm` (~2MB, noticeably slower), (c) shell out to the `jq` binary via `node:child_process.spawn`. Went with (c) because jq is already baked into the container image and every dev box, fork/exec cost is negligible at the rate `call_tool` fires (seconds apart at worst), and the failure mode of "jq binary missing" is a single clear error instead of a build-time binding mystery.
**Lesson:** When a feature needs a well-known Unix tool AND is host-side (not in the agent sandbox) AND fires at human-scale frequency, prefer shelling out to the binary over bundling a library. Pin a tight timeout (we use 500ms — projections aren't a compute step), fail loud on missing binary, keep the wrapper narrow (one function, one caller). Save the library/wasm complexity for hot paths where process-spawn overhead matters.
**Tags:** jq, projection, subprocess, dependency-strategy, tool-catalog

## Spill file responsibility split: host emits envelope, agent writes the file
**Date:** 2026-04-22
**Context:** `call_tool` auto-spills responses that exceed `spillThresholdBytes` (default 20 KiB). Two ways to split the work: (A) host writes `/tmp/tool-<id>.json` and returns just a pointer — requires host filesystem access to a path the agent can read, which cuts across the sandbox boundary. (B) host returns a `{truncated: true, full, preview}` envelope; agent-side stub writes `full` to a spill file inside the sandbox and surfaces a `{truncated, spillPath, preview}` stub to the LLM. Went with (B). Host stays filesystem-free, spill files live in the process that actually owns the filesystem they're on, the split matches the trust boundary (host decides what gets spilled, agent decides where to write it).
**Lesson:** When a feature needs a filesystem side-effect AND crosses a trust/sandbox boundary, the side-effect belongs on the LESS-TRUSTED side. The trusted side hands back data + metadata; the sandbox performs the write inside its own filesystem. This keeps sandbox escape surface minimal, keeps the trusted side testable without filesystem mocks, and makes per-sandbox cleanup the sandbox's problem (which it already is).
**Tags:** spill, auto-truncation, sandbox-boundary, call-tool, filesystem-responsibility

## IPC-action module pattern: context-scoped resolver + injected dispatcher + structured error envelope
**Date:** 2026-04-22
**Context:** `describe_tools` and `call_tool` land as new IPC actions in the tool-dispatch rollout. The registration pattern they established: (1) action schema in `ipc-schemas.ts` with `.strict()` Zod validation; (2) handler module in `src/host/ipc-handlers/` exporting a factory `createXHandler(deps)` that takes BOTH a direct-resolver (for unit tests) AND a `resolveX(ctx) => X | undefined` closure (for real per-request wiring — the server registers one closure at boot that reads from a per-session `Map<sessionId, X>`); (3) all failures surface as `{error, kind}` envelopes with a closed `ErrorKind` enum — never throw across the IPC boundary; (4) the server-init wiring instantiates the handler factory with the closure + the real dispatcher providers, so the handler itself has zero imports from `server-init.ts`.
**Lesson:** When adding a new IPC action that needs per-request context AND external providers AND structured errors: factor handler construction through a factory, accept BOTH a direct-value and a ctx-resolver closure on the deps, and return typed `{error, kind}` envelopes for every failure path. This makes the handler directly unit-testable (pass in-memory values), lets the real server scope things per session without globals, and gives the client a stable error shape instead of throws+stringly-typed messages. `describe_tools` + `call_tool` are the canonical example; see `src/host/ipc-handlers/call-tool.ts` for the full pattern.
**Tags:** ipc-handlers, factory-pattern, per-request-context, structured-errors, registration

## SSE event ordering: emit turn-level side-band events AFTER the finish-reason chunk and BEFORE `[DONE]`
**Date:** 2026-04-21
**Context:** Task B2 of the surface-failures pipeline emits per-turn diagnostics as `event: diagnostic` named SSE frames in `handleCompletions`. The question is where in the frame sequence they go. The chat transport (and most SSE-consuming clients) treat every frame before the `finish_reason` chunk as streaming content — so emitting diagnostics earlier would interleave them into the assistant message text. Emitting them AFTER `[DONE]` doesn't work either, because most clients close the stream on `[DONE]` and throw away anything later. The right slot is the narrow window AFTER the final `finish_reason` chunk and BEFORE `data: [DONE]\n\n` — the client has the finish signal, knows the message is done, but hasn't torn down yet. A similar pattern applies to `event: oauth_required`, `event: status`, `event: content_block` in the same handler.
**Lesson:** When adding a new turn-terminal side-band SSE event, emit it in the narrow window between the final `sendSSEChunk(...)` with a non-null `finish_reason` and `res.write('data: [DONE]\n\n')`. Not before the finish chunk (clients treat it as streaming content), not after `[DONE]` (clients close the stream). Also: a clean turn (zero diagnostics / zero status events / whatever) must produce zero side-band frames — don't emit a sentinel "empty" event, just skip the loop. Clients shouldn't have to distinguish "no data" from "no event".
**Tags:** sse, streaming, event-ordering, completions, chat-transport

## Per-turn collectors: fresh instance per call, closure-captures-by-reference for cross-closure writes
**Date:** 2026-04-21
**Context:** Task B2 threads a `DiagnosticCollector` through `processCompletion` → `getOrBuildCatalog({build: async () => { ... populateCatalogFromSkills({diagnostics, ...}) }})` → `CompletionResult.diagnostics`. The collector is created fresh at the top of `processCompletion`, passed into the `build` closure, and read via `collector.list()` AFTER the build resolves. Two ways this could go wrong: (1) if the collector were module-scoped, turn N's diagnostics would leak into turn N+1's banner; (2) if the collector were passed by value (it's not — objects are references in JS), pushes inside the closure wouldn't survive. The correct pattern falls out naturally: create per-call, pass by reference, read after. The subtler correctness check: when `getOrBuildCatalog` hits its cache and `build` never fires, the collector stays empty — the snapshot is `[]` — the UI sees no banner. That's right: the user saw the banner on the turn that did the build.
**Lesson:** When you need a closure to accumulate something that the outer scope will later emit, instantiate the accumulator in the outer scope (fresh per call, never module-scoped), pass it into the closure, and read the snapshot after the closure resolves. Don't try to return accumulated data from the closure itself — if the closure is wrapped by a cache layer that sometimes skips invoking it, you'll get stale data on cache hits. The "empty on cache hit" behavior is usually the right thing (the accumulated signal already fired on the turn that populated the cache) but think about it explicitly — if you'd want the signal to re-fire on cache hits, you need a different design (e.g., cache the accumulated snapshot alongside the cached value).
**Tags:** closures, per-turn-state, collectors, sse, cache, diagnostic-surfacing

## When a helper builds "value + shape" in one pass and a new caller needs a different shape, split out the value lookup — don't add a shape knob
**Date:** 2026-04-21
**Context:** Task 7.4 of tool-dispatch-unification needed credential resolution for OpenAPI dispatch (4 auth schemes → 4 different header/query shapes). The existing `resolveMcpAuthHeadersByCredential` returned `{Authorization: 'Bearer <value>'}` in one call — perfect for MCP (bearer-only), wrong for OpenAPI. Two options: (1) add an `authScheme` param to the existing function so it builds the right shape, (2) factor out a `resolveCredentialValueByEnvName` that returns the raw value and let each caller build its own shape on top. Picked (2). The existing MCP call sites pass through unchanged (no risk of regression from adding a default `authScheme: 'bearer'` that someone forgets to override later); the new OpenAPI dispatcher implements the `switch (authScheme)` shape-building locally, where the auth-scheme-specific knowledge lives.
**Lesson:** When an existing helper does "lookup + format" and a new caller needs the same lookup with a different format, **split the lookup out** rather than parametrizing the format. Helpers that return a formatted header string are a convenience for the first caller; they become a liability for the second. The raw value is the minimum viable shared contract. Two ~10-line helpers (one value-only, one bearer-header-building on top) are clearer than a single 30-line helper with a `switch` over format options. This also avoids the "default parameter hides a bug" risk — a bearer-default with an optional scheme arg quietly ships bearer auth whenever a new call site forgets to specify the scheme.
**Tags:** helpers, refactoring, credentials, mcp-vs-openapi, minimum-viable-contract, architecture

## Per-turn caches keyed on agent state must also be keyed on caller identity
**Date:** 2026-04-19
**Context:** Task 2.5 of tool-dispatch-unification added a cache for the per-turn `CatalogTool[]` to skip redundant `listTools` calls. First instinct was `(agentId, HEAD-sha)` — same skill snapshot → same tools. But the `listTools` call goes through `resolveMcpAuthHeaders`, which picks a `skill_credentials` row scoped to the caller's `userId`. Two users on the same agent + HEAD can legitimately see different tool sets (different Linear workspace, different Slack team). A `(agentId, HEAD-sha)` cache would leak user-1's tools to user-2. Fix: key on `(agentId, userId, HEAD-sha)`. Added test verifying per-user isolation.
**Lesson:** Before caching anything that involves credentials, trace the call graph from the build function back to every identity-scoped lookup. If any of them reads from a per-user store (even transitively via a header resolver), the cache key must include `userId`. Memory cost is marginal — a handful of extra entries per active user per agent — and the correctness win (no cross-user leakage) is non-negotiable. Applies to tool catalogs, MCP tool lists, OAuth token caches, anything that touches `skill_credentials` / `credential_store` under the hood.
**Tags:** caching, per-user-scoping, credentials, security, tool-catalog

## Pure host helpers that the agent also needs: move to `src/types/`, shim the old path
**Date:** 2026-04-19
**Context:** Task 2.4 of tool-dispatch-unification needed `renderCatalogOneLiners` from `src/host/tool-catalog/render.ts` on the agent side (to render the "## Available tools" prompt block from the host-delivered `CatalogTool[]`). The original signature took a stateful `ToolCatalog` class instance — fine for host callers, awkward for the agent which just has an array. Refactor path: make the shared helper accept `CatalogTool[]` directly (pure, stateless), put it at `src/types/catalog-render.ts`, and rewrite the host-side `render.ts` as a 6-line shim that calls `catalog.list()` and forwards. One behavior, two entry points — host-side test still green, agent imports the pure helper.
**Lesson:** When moving a pure helper across the host→agent boundary, take the opportunity to **shed the stateful dependency** if the helper doesn't actually need it. The shared helper's signature should be the simplest thing that works (an array, a plain object) — not a class reference. Keep the old stateful-signature entry point as a backward-compat shim in the host module so existing callers don't churn. Rule of thumb: if the helper's body only calls `.list()` / `.get()` / other read-only methods on the class, it doesn't need the class.
**Tags:** host-agent-boundary, shared-helpers, pure-functions, backward-compat, refactoring

## Host/agent shared types go in `src/types/` (or `src/types.ts`), not `src/host/`
**Date:** 2026-04-19
**Context:** Task 2.3 of tool-dispatch-unification needed `CatalogTool` on the agent side (to ship the catalog through stdin into `AgentConfig`). The type lived in `src/host/tool-catalog/types.ts`, and the agent MUST NOT import from `src/host/`. Two options: (1) move the type to a shared location, (2) update all the host-side callers to the new path. Moved the file to `src/types/catalog.ts` and kept the original path as a 14-LOC re-export — 5 existing host call sites stayed green with zero churn, and the re-export doubles as a signpost pointing future readers to the new home.
**Lesson:** When a host-owned type crosses the host→agent boundary via the stdin payload, move the authoritative definition to `src/types/<name>.ts` (or extend `src/types.ts` if it's a couple of lines). Re-export from the old path so existing host-side imports don't need to change in the same commit. Pure constraint: the shared types file depends only on `zod` and other `src/types/*` files — never on `src/host/*` or `src/agent/*`. This also keeps `src/types/` as the list of "this is a cross-cutting contract" — a useful grep target when someone asks "what flows across the IPC/stdin boundary?"
**Tags:** types, host-agent-boundary, stdin-payload, refactoring, imports

## Freeze per-request slices of global allowlists at request entry; don't query the allowlist on the hot path
**Date:** 2026-04-18
**Context:** Step 7 replaced a global, mid-session-mutable `ProxyDomainList.isAllowed(domain)` (synchronous, called per HTTPS CONNECT) with a per-agent computation from `skill_domain_approvals` joined with enabled skills. The naive fix was async — each CONNECT would hit the DB. That would've changed the web-proxy's hot path from O(1) Set lookup to an async Kysely query per request. The right fix: compute `getAllowedDomainsForAgent(agentId)` once at session start, freeze the Set, and hand its `.has` in as `allowedDomains` to `startWebProxy`. Mid-session admin approvals apply on the NEXT session — which also matched prior behavior in practice, since the old implementation relied on session-level restart semantics anyway.
**Lesson:** When replacing a global in-memory lookup with a DB-backed per-subject query, don't do the lookup per-request. Compute the per-subject slice at request entry (session start, request handler entry, etc.) and freeze it as a cheap read-only structure. The proxy doesn't care that the allowlist is derived from DB rows — it only cares that `has(domain)` is O(1) and synchronous. Changing "the allowlist is a mutable global" to "the allowlist is a frozen per-session Set" is almost always the right shape when moving from in-memory to DB-backed state.
**Tags:** architecture, proxy, allowlist, session-frozen, hot-path, skills, single-source-of-truth

## Replace "reconcile + materialized store" with "live derivation + cache invalidation" when the upstream is already authoritative
**Date:** 2026-04-18
**Context:** The skills subsystem spent months on a reconcile pipeline (git snapshot → `SkillStateStore` → MCP applier + proxy applier + startup rehydrate). Every trigger could fail independently. The state store aged. The live path (`getAgentSkills` reading git + `skill_credentials` + `ProxyDomainList`) was correct, fast with a per-(agentId, HEAD) snapshot cache, and had zero "stuck state" failure modes. Deleting the reconciler (step 6) removed ~3020 LOC and replaced the post-receive hook's 500-line pipeline with a 20-line HMAC-verify + `snapshotCache.invalidateAgent(agentId)`.
**Lesson:** If a downstream store is always derived from an upstream source (git, DB rows, etc.) and the upstream is authoritative, the question is never "how do I keep them in sync" — it's "is the derivation cheap enough to do on read?" Measure it. If it's cheap with a cache keyed on the upstream's version, delete the store. Cache-bust on the upstream's change signal (push hook, DB write). You don't need a reconcile pipeline to avoid recomputation; you need a cache with an invalidation signal. This generalizes beyond skills — any subsystem shaped "event handler → writes to derived table → consumers read derived table" is a candidate for collapse when the upstream read is ≤10ms.
**Tags:** architecture, reconciler, cache, derivation, single-source-of-truth, skills

## Push derived state at turn boundaries instead of having the sandbox pull it
**Date:** 2026-04-18
**Context:** The skills subsystem originally had the agent fetch its skill index via the `skills_index` IPC right after connecting, with a filesystem scan as a fallback when the fetch returned empty/undefined. Failure modes: empty-array IPC responses masked real on-disk skills (fresh agents whose repos predated newly-added seed skills never learned about them); the filesystem fallback ran inside the synchronous prompt builder's `?? (() => scan())()` thunk; tests had to simulate both the IPC and the filesystem branches. Replacing the pull with a per-turn stdin-payload push (`host → getAgentSkills(agentId, deps) → payload.skills → config.skills → buildSystemPrompt`) deleted the schema, the handler, the helper, and the fallback in one step.
**Lesson:** When the host already controls the data and the agent only consumes it to build the prompt, push it via the stdin payload at turn start rather than giving the agent an IPC action to pull it. The payload is the authoritative per-turn contract; adding a field there is strictly cheaper than adding an IPC action (no Zod schema, no handler registration, no sync-test knownInternalActions entry, no `setContext` timing worry, no transport-error fallback). Reserve IPC for state the agent actually computes or initiates — not for "host-owned, renders once per turn" data.
**Tags:** ipc, stdin-payload, architecture, skills, push-vs-pull

## When deleting a REST endpoint, grep the admin UI client for its caller
**Date:** 2026-04-17
**Context:** Phase 7 Task 7 removed the backend handlers for `GET /admin/api/agents/:id/skills` (+ the per-skill CRUD routes) — but the admin dashboard client in `ui/admin/src/lib/api.ts` still exported `agentSkills` / `agentSkillContent` / `updateSkill` / `deleteSkill` methods, and `agents-page.tsx` still rendered a `SkillsTab` wired to them via a sidebar nav entry + `activeSection === 'skills'` render branch. The whole tab was silently 404'ing from the moment Task 7 landed. The main `npm run build` + `tsc` in `src/` stayed green because the admin UI has its own `tsconfig.json` under `ui/admin/` that the root build doesn't touch.
**Lesson:** When removing a REST handler in `src/host/server-admin.ts`, always grep `ui/admin/` for callers — the `api` client in `ui/admin/src/lib/api.ts` is a separate codebase with its own typecheck (`cd ui/admin && npx tsc --noEmit`). Look for: API method definitions, `activeSection === '<id>'` branches in agents-page, SectionId union entries, Playwright route mocks in `ui/admin/tests/fixtures.ts`, and spec files importing the mock data. The dashboard is the last consumer and the easiest one to forget.
**Tags:** refactoring, deletion, admin-ui, rest-api, phase-7, dead-code

## Multi-task deletion phases leave "dormant-caller" dead code that only a final sweep finds
**Date:** 2026-04-17
**Context:** Phase 7 tasks 1–6 deleted the skill_install IPC, ClawHub client, plugin manifest machinery, CLI, and DB data. The build stayed green through each task because tasks were scoped to remove entire subsystems at a time. But the host still had dormant readers of the empty `documents.skills` collection (`findSkillContent` in `server-admin.ts`, `loadSkillsFromDB` in `inprocess.ts`) that ran on every request, returned empty results, and were never grep-visible from the retired IPC-action names. Task 7's grep of `DocumentStore.*skill` is what flushed them out.
**Lesson:** When a multi-task phase rips out a storage-backed feature, the final cleanup task should grep for *readers* of the backing store (`documents.get('<collection>'`, `documents.list('<collection>'`), not just writers / IPC handlers / CLI entry points. Silent empty-result callers keep pulling their weight in deps interfaces, mock fixtures, and test matrices long after the feature is dead. Remove them with the rest or the next person will.
**Tags:** refactoring, deletion, phase-7, dead-code, grep-discipline

## When deleting a subsystem, inline its last-surviving type into the sibling that uses it
**Date:** 2026-04-17
**Context:** Phase 7 Task 3 deleted `src/plugins/{fetcher,install,parser,store,types}.ts`. The `types.ts` file was going away, but `src/plugins/mcp-manager.ts` (which stays — phase-4 depends on it) still imported `PluginMcpServer` from `./types.js`. Leaving `types.ts` alive just for one interface used by one file would have kept a stub alive for no reason.
**Lesson:** When a shared-types module has only one surviving consumer after a deletion pass, inline the type into the consumer rather than keeping the module as a shell. This leaves the codebase with strictly fewer files and strictly fewer cross-file imports. If/when a second consumer shows up, you can re-extract. Don't preserve structure "just in case" — that's how you end up with 6-line modules that future greps mistake for important seams.
**Tags:** refactoring, deletion, types, module-boundaries, phase-7

## Deletion tasks need a dependency audit, not just a grep of "what imports the target"
**Date:** 2026-04-17
**Context:** Phase 7 Task 2 (delete `src/clawhub/registry-client.ts` + `src/providers/storage/skills.ts`) assumed the previous task's cleanup was sufficient to leave zero live importers. It wasn't — `server-admin.ts` (admin CRUD routes), `server-init.ts` (a dead DB-allowlist block), and `plugins/install.ts` (skill upserts) still pulled from the target modules. The plan scoped each of those to future tasks, but the build broke immediately without touching them.
**Lesson:** Before running a pure-deletion task, `rg "<module>" src tests` and confirm every hit is either (a) another file being deleted in the same task or (b) tolerable for a minimal local patch. If a file imports the target and is scoped to a later task, decide upfront: patch it now (smallest incursion), or reorder tasks. Don't discover mid-build that Task N requires part of Task N+1. Cross-task dependencies in deletion plans are the rule, not the exception.
**Tags:** refactoring, deletion, planning, cross-task-dependency, phase-7

## IPC-sourced config with filesystem fallback: use `config.X ?? scan()` in sync builders
**Date:** 2026-04-17
**Context:** Phase 3 Task 7 wired `skills_index` IPC into the runner so the host-authoritative skill list wins over a filesystem scan, while keeping `buildSystemPrompt` synchronous. The natural pattern: a sync prompt builder that reads `config.skills ?? loadSkillsMultiDir(skillDirs)`, plus a separate async `fetchSkillsIndex()` the runner awaits right after `client.connect()` and before calling the builder. If the fetch throws or returns malformed data, the helper returns `undefined` and the builder falls through to the filesystem scan.
**Lesson:** When moving data from filesystem-owned to host-owned via IPC, keep the synchronous builder/consumer untouched — just let it read `config.X ?? <legacy-scan>`. Do the async fetch in the runner wire-up layer. This keeps tests deterministic (no network needed — pass `config.skills` or let the fallback scan run), and transport errors degrade gracefully. Guard the mutation with `if (config.X === undefined)` so injected values (e.g., from tests) always win over IPC.
**Tags:** ipc, runner, fallback-pattern, sync-builder, prompt, skills
**Date:** 2026-04-06
**Context:** During the single-workspace refactor (removing agent/user workspace split), host-side code like server-files.ts and server-channels.ts still uses `userWorkspaceDir()` for local file storage (upload/download). These are host-side paths, not sandbox paths.
**Lesson:** When simplifying the sandbox workspace model, keep deprecated host-side path helpers (agentWorkspaceDir, userWorkspaceDir) available for backward compatibility in host-only code (file upload/download, image resolution). Mark them @deprecated. Only remove sandbox-facing code (SandboxConfig fields, env vars, payload fields). Host-side and sandbox-side are separate concerns.
**Tags:** workspace, refactoring, backward-compat, host-side, sandbox

## Chat UI prose classes require @tailwindcss/typography plugin
**Date:** 2026-03-31
**Context:** Chat UI markdown-text.tsx used Tailwind `prose` classes but `@tailwindcss/typography` was not installed. All prose-* utility classes were silently no-ops — headings, lists, code blocks, and tables rendered as unstyled elements.
**Lesson:** When using Tailwind v4 with `prose` classes, you MUST: 1) install `@tailwindcss/typography`, 2) add `@plugin "@tailwindcss/typography"` in the CSS file. Without it, prose classes silently do nothing. Also, `react-markdown` does NOT parse GFM tables by default — you need `remark-gfm` as a remarkPlugin.
**Tags:** tailwind, typography, prose, react-markdown, remark-gfm, chat-ui

## Transport text part IDs must be unique across tool-call boundaries
**Date:** 2026-03-31
**Context:** Chat UI transport used a single `textPartId = 'text-0'` for the entire SSE stream. After `finish_reason: 'tool_calls'`, subsequent text deltas reused the same ID, causing assistant-ui to append new text to the previous text part without whitespace.
**Lesson:** In `processResponseStream`, after a `tool-calls` finish, reset `started = false` and increment the text part ID counter so the next text segment creates a fresh text part. Don't emit a `finish` chunk for tool-calls — only emit finish for the final `stop`.
**Tags:** transport, assistant-ui, text-part, tool-calls, streaming, chat-ui

## Cap'n Web RpcTarget only exposes prototype methods — use dynamic class construction
**Date:** 2026-03-28
**Context:** Building Cap'n Web RPC server that dynamically creates methods from MCP tool schemas.
**Lesson:** Cap'n Web's `RpcTarget` only exposes prototype methods over RPC, not instance properties or methods added via `Object.defineProperty()` on instances. To dynamically add methods, create a class that `extends RpcTarget` and add methods to its `.prototype` before instantiation. Arrow functions on prototype work for capturing external state via closure (mcpProvider, ctx).
**Tags:** capnweb, rpc-target, dynamic-methods, prototype

## Reuse existing proxy as transport for new internal services
**Date:** 2026-03-28
**Context:** Initially built a separate Unix socket + custom RpcTransport for Cap'n Web. Realized the web proxy is already an HTTP server that every sandbox can reach.
**Lesson:** When a sandboxed agent needs to reach a new host-side service, don't create a new transport. Add an `internalRoutes` intercept to the existing web proxy. The proxy detects the hostname before DNS/SSRF checks and handles the request in-process. This works for all sandbox types (Docker, Apple, k8s) because they all already have `HTTP_PROXY` configured. The pattern: `internalRoutes: new Map([['ax-service', handler]])` → agent fetches `http://ax-service/path` through its existing proxy.
**Tags:** proxy, transport, capnweb, internal-routes, sandbox, simplification

### Replace async approval callbacks with synchronous allowlists to avoid deadlocks
**Date:** 2026-03-22
**Context:** Wiring ProxyDomainList into proxy startup to replace onApprove callback that caused deadlocks (proxy blocked waiting for user approval while agent was blocked waiting for proxy).
**Lesson:** When a synchronous decision boundary is needed (proxy must immediately allow/deny), replace async callback patterns (onApprove → await eventBus → user click) with pre-computed allowlists (Set<string>) plus a notification callback (onDenied) that queues for out-of-band review. The allowlist is a snapshot at proxy startup time; new domains from skill installs update the ProxyDomainList but the per-session proxy keeps its own Set copy. This trades "immediate interactive approval" for "never deadlocks" — the right trade when the proxy blocks agent execution.
**Tags:** proxy, deadlock, allowlist, async-callback, domain-approval

### assistant-ui useExternalHistory requires withFormat() — direct load() is never called
**Date:** 2026-03-21
**Context:** Thread history never loaded when clicking threads in the sidebar despite correct adapter setup
**Lesson:** `useExternalHistory` in `@assistant-ui/react-ai-sdk` calls `historyAdapter.withFormat?.(storageFormatAdapter).load()`, NOT `historyAdapter.load()`. The optional chaining `?.` silently returns `undefined` when `withFormat` is missing, causing history to appear broken with zero errors. Always implement `withFormat()` on `ThreadHistoryAdapter` when using with `useAISDKRuntime`.
**Tags:** assistant-ui, history, withFormat, thread-switching, silent-failure

### assistant-ui RuntimeAdapterProvider context may not propagate to runtimeHook internals
**Date:** 2026-03-21
**Context:** Used `unstable_Provider` to wrap thread instances with `RuntimeAdapterProvider` for history, but `useRuntimeAdapters()` inside `useAISDKRuntime` returned null
**Lesson:** Instead of using `RuntimeAdapterProvider` context via `unstable_Provider`, pass adapters directly to `useAISDKRuntime(chat, { adapters: { history } })`. This is more reliable and simpler.
**Tags:** assistant-ui, adapters, context, useAISDKRuntime

### assistant-ui tool call rendering uses tools.Fallback not ToolCall component key
**Date:** 2026-03-21
**Context:** Added `ToolCall` component to `MessagePrimitive.Parts` components but tool calls didn't render
**Lesson:** `MessagePrimitive.Parts` components prop uses `tools: { Fallback: Component }` or `tools: { by_name: { toolName: Component } }` for tool calls. There is no `ToolCall` component key. The Fallback receives `{ toolName, args, status, addResult, resume }` props.
**Tags:** assistant-ui, tool-calls, MessagePrimitive, Parts

### Chat UI requires custom ChatTransport for OpenAI SSE — DefaultChatTransport uses AI SDK data stream format
**Date:** 2026-03-21
**Context:** Debugging why chat messages sent from the UI produced no visible response despite 200 OK from server.
**Lesson:** The AI SDK's `DefaultChatTransport` (extended by `AssistantChatTransport`) uses `parseJsonEventStream2` which expects AI SDK data stream format (JSON SSE with `UIMessageChunk` schema), NOT OpenAI-compatible SSE format (`data: {"choices":[{"delta":{"content":"..."}}]}`). Since AX returns OpenAI SSE, you must extend `HttpChatTransport` and override `processResponseStream` to parse OpenAI deltas and emit `text-start`/`text-delta`/`text-end`/`finish` chunks. Also: the `prepareSendMessagesRequest` callback's `options.id` comes from `options.chatId` (set by `useChat({ id })`), and the `user` field in the request body must follow `"userId/threadPart"` format for the server to derive valid session IDs via `main:http:{userId}:{threadPart}`.
**Tags:** chat-ui, assistant-ui, ai-sdk, streaming, transport, openai-sse

### NATS eventbus provider implements full EventBus interface — no separate NATS SSE needed
**Date:** 2026-03-20
**Context:** Extracting shared HTTP route dispatch from server-k8s.ts. The k8s server had an inline NATS-based SSE handler that subscribed directly to NATS subjects and forwarded events to SSE clients.
**Lesson:** The NATS eventbus provider (`src/providers/eventbus/nats.ts`) already implements subscribe/subscribeRequest by subscribing to NATS subjects and dispatching to listener callbacks. The shared `handleEventsSSE` which uses `eventBus.subscribe()` works correctly in k8s mode because the eventBus IS backed by NATS. When deduplicating handlers, check whether the EventBus abstraction already bridges the underlying transport before keeping mode-specific handlers.
**Tags:** eventbus, nats, sse, server-k8s, abstraction-layer

### Use callback injection to share HTTP handlers between server modes
**Date:** 2026-03-20
**Context:** Extracting duplicated handleCompletions/scheduler callback from server.ts and host-process.ts into shared modules
**Lesson:** When two modules share 90% of HTTP handler logic but differ in the completion runner (processCompletion vs processCompletionWithNATS), use a `runCompletion` callback parameter in the shared handler. The caller injects its mode-specific runner. Same pattern works for `preFlightCheck` (bootstrap gate in server.ts, absent in host-process.ts). This avoids conditional mode flags inside shared code.
**Tags:** refactoring, server, host-process, callback-injection, composition

### parseAgentSkill requires fallback checks direct frontmatter fields
**Date:** 2026-03-19
**Context:** Debugging why `requires.env` was always empty when parsing skills with direct-frontmatter `requires` blocks (not nested under `metadata.openclaw`).
**Lesson:** `parseAgentSkill()` resolves `requires` from `resolveMetadata(fm)?.requires` which only checks nested `fm.metadata.{openclaw,clawdbot,clawdis}.requires`. Skills using simple direct frontmatter `requires:` blocks (the common format) were silently ignored. Always check both `meta?.requires ?? fm.requires` for fallback. The silent `catch {}` blocks in `collectSkillCredentialRequirements` made this hard to diagnose.
**Tags:** skill-parser, frontmatter, requires, credentials, silent-failure

### In-memory promise maps create hidden session affinity requirements
**Date:** 2026-03-19
**Context:** Replacing credential-prompts.ts in-memory promise map with event bus coordination for mid-request credential collection.
**Lesson:** In-memory Maps that store pending Promises (like `Map<sessionId, resolver>`) create an implicit requirement that the same process handles both the request and the resolution. In a multi-replica environment (k8s), the HTTP endpoint that receives the credential may hit a different replica than the one waiting on the Promise. Use the event bus (in-process for local, NATS-backed for k8s) to coordinate instead — subscribe per-requestId and emit from any replica.
**Tags:** event-bus, session-affinity, k8s, credential-prompts, architecture

### Post-agent credential loop pattern
**Date:** 2026-03-19
**Context:** Implementing mid-request credential collection where agent requests credentials during execution, then host collects and re-spawns.
**Lesson:** When an agent needs credentials mid-turn: (1) agent calls credential_request IPC to signal what it needs, (2) host records in shared Map<sessionId, Set<envName>>, (3) after agent exits, host checks the map, re-scans skills, emits credential.required events via SSE, waits for user input via event bus, (4) re-spawns agent with credentials in env. The re-spawn needs a minimal stdin payload — keep it simple and let the agent confirm success.
**Tags:** credential-collection, agent-respawn, post-agent-loop, processCompletion

### Shared outbound proxies need per-turn auth to preserve session identity
**Date:** 2026-03-19
**Context:** Designing a generalized HTTPS proxy that could support MITM credential injection for sandboxed CLI tools in Docker and k8s.
**Lesson:** Never treat a shared outbound proxy as transparent infrastructure when policy or credential injection depends on request identity. If the proxy cannot bind each request to a concrete AX turn/session, approvals, auditing, and credential decisions collapse to a coarse global scope. Add explicit short-lived proxy auth first, then layer MITM or service-specific policy on top.
**Tags:** proxy, identity, session, k8s, mitm, architecture, auditing

### K8s service names generate env vars that collide with application env vars
**Date:** 2026-03-18
**Context:** Created a k8s Service named `ax-web-proxy`. Kubernetes auto-generates `AX_WEB_PROXY_PORT=tcp://10.96.104.65:3128` in all pods in the namespace. Our code read `process.env.AX_WEB_PROXY_PORT` expecting a number, got `tcp://...`, parsed to NaN, and crashed.
**Lesson:** Never name a k8s Service such that its auto-generated env vars (`<SERVICE>_PORT`, `<SERVICE>_HOST`, `<SERVICE>_PORT_<PORT>_TCP`) collide with your application's env vars. The transform is: service name uppercased, hyphens→underscores, suffixed with `_PORT`, `_HOST`, etc. Either rename the service or use a distinct env var name (we renamed to `AX_PROXY_LISTEN_PORT`).
**Tags:** k8s, service-discovery, env-vars, naming-collision, debugging

### Warm pool pods don't get per-request env vars from sandbox.spawn()
**Date:** 2026-03-18
**Context:** `host-process.ts` passes `AX_WEB_PROXY_URL` via `extraSandboxEnv` into `sandboxConfig.extraEnv`. The k8s provider puts these into the pod spec on `spawn()`. But warm pool pods are pre-created without per-request env vars — they receive work via NATS payload. Any per-request env var must be explicitly added to both the NATS stdin payload AND `parseStdinPayload()` in `runner.ts`.
**Lesson:** When adding a new per-request env var for k8s sandboxes: (1) Add it to `extraSandboxEnv` in `host-process.ts` (cold spawn path). (2) Add it to `stdinPayload` in `server-completions.ts` (NATS payload). (3) Add parsing in `parseStdinPayload()` in `runner.ts`. (4) Apply it in `applyPayload()`. Missing any step means warm pool pods silently lack the value.
**Tags:** k8s, warm-pool, nats, env-vars, payload, runner

### Synchronous child process execution + web proxy governance = deadlock
**Date:** 2026-03-18
**Context:** Debugging agent hang on `npm install -g` in container mode. `execFileSync` blocks the event loop, but npm routes through the web proxy which calls `requestApproval()` — a 120s blocking wait for the agent to send `web_proxy_approve` IPC. Since the agent is blocked on execFileSync, the IPC can never arrive.
**Lesson:** Never use `execFileSync`/`execSync` for bash commands in the agent or host process when those commands may trigger proxy-governed network requests. Use async `spawn` instead. For known package manager commands, pre-approve well-known registry domains (registry.npmjs.org, pypi.org, etc.) BEFORE executing the command to break the circular dependency.
**Tags:** deadlock, web-proxy, execFileSync, spawn, sandbox, container, npm

### K8s filesystem lifecycle must stay inside one pod or use explicit remote handoff
**Date:** 2026-03-17
**Context:** Comparing the original workspace-permissions plan to the current k8s implementation. `server-completions.ts` still runs provision, agent, and cleanup as separate sandbox spawns, while the k8s sandbox provider mounts `emptyDir` volumes that exist only for one pod.
**Lesson:** Never design a k8s workflow that depends on filesystem continuity across separate pod spawns unless you use a real shared store (PVC/object store) and explicit handoff. Pod-local `emptyDir` state dies with that pod, so provision/run/cleanup must happen in the same pod, or the handoff must be pushed through an external system such as GCS/HTTP staging. Treat NATS as the control plane and keep bulk workspace state out of it.
**Tags:** k8s, workspace, emptydir, orchestration, nats, http, architecture

### Prefer HTTP over NATS for large binary payloads in k8s
**Date:** 2026-03-17
**Context:** Redesigning k8s workspace file syncing from NATS base64+chunking to HTTP staging. The original approach sent file contents through NATS IPC (base64-encoded, chunked at ~800KB to fit NATS 1MB limit). When the HTTP forward proxy was introduced, this became unnecessary complexity.
**Lesson:** When k8s pods need to transfer large binary data to the host, use HTTP (via the host's service endpoint) instead of NATS. NATS is great for small control messages (IPC calls, references) but has a 1MB default payload limit that forces chunking for file transfers. HTTP has no such limit and is the natural transport for file uploads. The pattern: upload data via HTTP POST → get back a reference key → send the reference via NATS IPC. Delegate filesystem-heavy work to workspace-cli.ts (the sidecar) instead of doing it in the agent runner.
**Tags:** k8s, nats, http, workspace, architecture, file-transfer, sidecar

### NATS nc.request() is incompatible with JetStream-captured subjects
**Date:** 2026-03-16
**Context:** Debugging `ipc_llm_error: undefined` in k8s sandbox pods. NATSIPCClient used `nc.request()` for IPC calls, but the agent received `{stream, seq}` (JetStream PubAck) instead of the IPC response.
**Lesson:** When a NATS JetStream stream captures the target subject, the NATS server sends a PubAck to the `nc.request()` reply inbox before the subscriber's `msg.respond()` arrives. Since `nc.request()` takes the first response, it returns the PubAck instead of the real response. Use manual `subscribe(inbox)` + `publish(subject, payload, {reply: inbox})` and filter out PubAck responses (messages with `stream`+`seq` fields but no `ok` field). This is resilient regardless of JetStream configuration.
**Tags:** nats, jetstream, ipc, k8s, request-reply, puback

### Filesystem-based state doesn't survive pod filesystem boundaries in k8s
**Date:** 2026-03-16
**Context:** Debugging k8s agent identity loss on every session. The agent-runtime pod is a separate Kubernetes pod with its own filesystem. IPC handlers on the agent-runtime pod couldn't read the admins file from the host pod's filesystem, so state checks always saw an empty admins file. This made every identity_write handler skip persistence because it thought there were no admins configured.
**Lesson:** In k8s NATS dispatch architecture, the host pod and agent-runtime pod have separate filesystems. Never rely on filesystem state for access control checks between pods. Instead: (1) Gate the check on whether the state actually exists locally (`hasAnyAdmin()`), (2) Defer to the host layer for validation (IPC client<->host trust model), (3) Cache critical state in shared databases (PostgreSQL) rather than files, or (4) Pre-distribute state to both pods at deployment time. The admin file is a per-deployment credential list — it's fine to keep it on the host pod only, as long as the agent-runtime pod's gatekeeping logic doesn't assume the file exists locally.
**Tags:** k8s, architecture, distributed-systems, nats-dispatch, filesystem, ipc, security

### Three tool dispatch paths all need sandbox wiring
**Date:** 2026-03-15
**Context:** Wiring local sandbox into agent tool dispatch for the unified container model.
**Lesson:** AX has THREE separate tool creation paths: `createIPCTools()` in ipc-tools.ts (pi-coding-agent), `createIPCToolDefinitions()` in pi-session.ts (pi-session runner), and `createIPCMcpServer()` in mcp-server.ts (claude-code). When adding a cross-cutting concern like local sandbox execution, all three must be updated. The MCP server uses a ternary pattern (tool function is sandbox ? local : ipc), while the others use switch statements. The tool-catalog-sync test catches missing parameter registrations immediately — always run it first.
**Tags:** agent, sandbox, tool-dispatch, mcp-server, architecture

### Workspace provider mounts must be pre-resolved before sandbox spawn
**Date:** 2026-03-13
**Context:** Wiring workspace provider directories into sandbox mounts. The sandbox can't add mounts after spawn, so workspace scopes must be pre-mounted before the sandbox process starts.
**Lesson:** When a workspace provider is active, pre-mount all needed scopes (agent, user) in server-completions.ts BEFORE constructing the sandbox config. Use the returned paths from workspace.mount() as the agentWorkspace/userWorkspace values in SandboxConfig. The workspaceMountsWritable flag tells sandbox providers to use rw instead of ro mounts. The end-of-turn commit() validates all changes — the writable mounts are safe because the workspace provider's two-layer validation (structural + scanner) gates persistence.
**Tags:** workspace, sandbox, architecture, security

### Seatbelt sandbox-exec -D parameters must always be defined
**Date:** 2026-03-13
**Context:** Removing the `skills` field from SandboxConfig. Seatbelt uses `-D SKILLS=...` in its policy file, and removing it entirely would break the seatbelt policy parser.
**Lesson:** When removing a sandbox config field that's used as a seatbelt `-D` parameter, set it to `/dev/null` rather than omitting it entirely. The seatbelt policy file references all `-D` variables and will fail to parse if any are undefined. The safe no-op path `/dev/null` is already the established convention (used for AGENT_WORKSPACE and USER_WORKSPACE when absent).
**Tags:** sandbox, seatbelt, canonical-paths, security

### Anchor fast-path designs at the existing IPC seam
**Date:** 2026-03-08
**Context:** Reviewing the unified WASM sandbox plan against AX's current host, IPC, and sandbox implementation.
**Lesson:** When proposing a new execution fast path, start from the existing agent-visible contract (`sandbox_bash`, `sandbox_read_file`, `sandbox_write_file`, `sandbox_edit_file`) and the real host-side dispatch seam (`createSandboxToolHandlers()`). Do not assume new tools, new IPC actions, or a new provider kind until the fast path is proven; otherwise the plan underestimates blast radius and drifts from the codebase.
**Tags:** architecture, ipc, sandbox, wasm, tool-catalog, planning

### Provider-local migrations pattern for shared database connections
**Date:** 2026-03-05
**Context:** Refactoring 10+ standalone SQLite connections into a shared DatabaseProvider. Each subsystem (storage, audit, memory, scheduler, files, orchestration) needed its own tables.
**Lesson:** Each consumer should have its own migration file (e.g., `src/providers/storage/migrations.ts`) that returns a `MigrationSet` with prefixed names (e.g., `storage_001_messages`). Consumers call `runMigrations(database.db, myMigrations(database.type))` at create() time. This keeps migration ownership local while sharing the connection. Use a `dbType` parameter for dialect-specific SQL (datetime defaults, autoincrement, FOR UPDATE SKIP LOCKED).
**Tags:** database, migrations, kysely, provider-pattern, sqlite, postgresql

### Union return types for sync/async interface compatibility
**Date:** 2026-03-05
**Context:** JobStore interface needed to support both sync (in-memory) and async (Kysely) implementations. Making the interface fully async would force unnecessary `await` on simple Map operations.
**Lesson:** Use `T | Promise<T>` return types (e.g., `list(): CronJobDef[] | Promise<CronJobDef[]>`) when an interface has both sync and async implementations. Callers must always `await` the result (awaiting a non-Promise is a no-op). This avoids forcing the simpler implementation to wrap everything in `Promise.resolve()`.
**Tags:** typescript, interfaces, async, union-types, provider-pattern

### Object literal methods cannot reference sibling methods via `this`
**Date:** 2026-03-04
**Context:** nats-sandbox-dispatch.ts had a `close()` method calling `this.release()` in a returned object literal. TypeScript compiled it but `this` was undefined at runtime because object literals don't bind `this` like classes.
**Lesson:** When a function returns an object literal with methods that need to call each other, extract the shared logic into standalone functions declared before the return statement. Use `release: releasePod` in the object and call `releasePod(reqId)` from `close()`. Never rely on `this` in plain object literals.
**Tags:** typescript, this-binding, object-literal, nats

### Shared Map pattern for cross-concern state in server.ts
**Date:** 2026-03-04
**Context:** Moving sandbox tools to IPC required the host-side handlers to resolve the workspace directory for each session, but workspace paths are set up in processCompletion and consumed in IPC handlers.
**Lesson:** When two subsystems (completionDeps and IPC handlers) need shared per-session state, create a `Map<string, T>` in server.ts and pass it to both. The completion flow registers/deregisters entries, and handlers look them up by sessionId. The key insight is that `requestId` from processCompletion becomes `sessionId` in IPC context (it's passed via the stdin payload). Always clean up Map entries in a `finally` block.
**Tags:** architecture, ipc, workspace, session, state-sharing

### marked v17 renderer uses token objects, not positional args
**Date:** 2026-03-03
**Context:** Upgrading marked from v11 to v17 broke the custom CLI markdown renderer
**Lesson:** marked v17 changed all renderer methods from positional arguments (e.g., `link(href, title, text)`) to token objects (e.g., `link({ href, title, tokens })`). Methods receive `this` bound to the `_Renderer` instance with `this.parser.parseInline(tokens)` for inline content and `this.parser.parse(tokens)` for block content. Critical gotcha: `list()` CANNOT pass `token.items` to `this.parser.parse()` — the parser doesn't recognize `list_item` tokens. Must iterate items manually and call `this.listitem(item)` for each.
**Tags:** marked, markdown, renderer, migration, breaking-change

### pi-agent-core AuthStorage now uses factory methods
**Date:** 2026-03-03
**Context:** Upgrading @mariozechner/pi-agent-core from 0.52 to 0.55 broke AuthStorage instantiation
**Lesson:** AuthStorage constructor is now private. Use `AuthStorage.create(path)` for file-based storage, `AuthStorage.inMemory()` for tests, or `AuthStorage.fromStorage(backend)` for custom backends. The instance methods (setRuntimeApiKey, etc.) are unchanged.
**Tags:** pi-agent-core, auth, factory-method, migration

### `command -v` is a shell builtin — execFile needs `/bin/sh`
**Date:** 2026-03-03
**Context:** Implementing bin-exists.ts for safe binary PATH lookup. Used `execFile('command', ['-v', name])` which fails because `command` is a POSIX shell builtin, not an external binary.
**Lesson:** Always use `execFile('/bin/sh', ['-c', 'command -v NAME'])` for POSIX binary existence checks. The input name must be regex-validated (`/^[a-zA-Z0-9_.-]+$/`) before passing to the shell to prevent injection. On Windows, `where` IS an external binary, so `execFile('where', [name])` works directly.
**Tags:** shell, security, bin-exists, cross-platform

### TOCTOU defense for two-phase handlers: use content-derived tokens
**Date:** 2026-03-03
**Context:** Implementing skill_install with inspect→execute two-phase flow. The skill content could change between inspect and execute, leading to the user approving one command but executing a different one.
**Lesson:** Compute a SHA-256 hash (inspectToken) of the canonicalized install steps during inspect. Require the same token during execute. Before executing, re-parse the skill and recompute the hash — if it doesn't match, reject with `token_mismatch`. This binds the execute to exactly what was inspected.
**Tags:** security, toctou, skills, install

### Prefer structural layout fixes over runtime workarounds
**Date:** 2026-03-01
**Context:** Skills dir was inside workspace, requiring a per-turn copy to avoid mount permission overlap. Moving skills to be a peer of workspace (`agentIdentityDir()/skills` instead of `agentWorkspaceDir()/skills`) eliminated the need entirely.
**Lesson:** When two directories need different mount permissions, fix the directory layout so they're peers — don't work around a bad layout with runtime copying. A one-line path change beats 15 lines of temp-dir management.
**Tags:** architecture, simplicity, sandbox, skills, workspace

### Provider contract pattern IS the plugin framework — packaging is the missing piece
**Date:** 2026-02-26
**Context:** Evaluating whether AX needs a plugin framework for extensibility
**Lesson:** AX's provider contract pattern (TypeScript interface + `create(config)` factory + static allowlist in provider-map.ts) is already 90% of a plugin framework. The gap is packaging and distribution, not architecture. A monorepo split into scoped npm packages (@ax/provider-{kind}-{name}) can shrink core to ~3K LOC while preserving the static allowlist security invariant. The allowlist entries just change from relative paths to package names. No new trust boundary needed for first-party packages.
**Tags:** architecture, plugins, providers, provider-map, monorepo, packaging

### Cross-provider imports should go through shared-types.ts, not sibling directories
**Date:** 2026-02-28
**Context:** Preparing provider extraction (Step 2b) — scheduler imported types directly from channel/, memory/, and audit/ directories
**Lesson:** When one provider category needs types from another (e.g., scheduler needs `SessionAddress` from channel), import from `src/providers/shared-types.ts` — never directly from `../channel/types.js`. This keeps the import graph clean for eventual package extraction. The shared-types file is purely re-exports; canonical definitions stay in their home provider's types.ts. A structural test in `tests/providers/shared-types.test.ts` enforces this by scanning source imports.
**Tags:** architecture, imports, providers, cross-provider, shared-types, extraction-prep

### Shared utilities between routers go in src/providers/router-utils.ts
**Date:** 2026-02-28
**Context:** image/router.ts was importing parseCompoundId from llm/router.ts — a cross-provider runtime dependency
**Lesson:** If multiple provider routers share utility functions (like `parseCompoundId`), extract them to `src/providers/router-utils.ts`. Don't have one router import from another — that creates a dependency between provider categories. When extracting the shared function, add a re-export from the original location for backwards compatibility, and mark it for removal in a future phase.
**Tags:** architecture, imports, router, shared-utils, parseCompoundId, extraction-prep

### EventBus should be optional and synchronous to avoid blocking the hot path
**Date:** 2026-02-28
**Context:** Implementing a streaming event bus for completion observability
**Lesson:** When adding cross-cutting observability to a request pipeline, make the bus synchronous (fire-and-forget) and optional (`eventBus?.emit()`). This way: (1) it never blocks the completion pipeline even if a listener is slow, (2) existing code paths work unchanged when no bus is wired in, (3) listener errors are isolated per-listener so one bad subscriber can't take down the pipeline. Use try/catch around each listener invocation, not around the emit loop.
**Tags:** event-bus, observability, architecture, performance, optional-dependency

### Extend the EventBus rather than replacing it for orchestration
**Date:** 2026-02-28
**Context:** Designing agent orchestration — needed to decide whether to build a new event system or reuse the existing EventBus
**Lesson:** The existing EventBus already emits llm.start, tool.call, llm.done events throughout the pipeline. Instead of creating a parallel event system, use auto-state inference: subscribe to the EventBus and map existing events to agent state transitions (llm.start → waiting_for_llm, tool.call → tool_calling, etc.). This avoids modifying existing IPC handlers while still getting rich agent state. The bridge pattern (listen → translate → update) is better than forking.
**Tags:** architecture, event-bus, orchestration, bridge-pattern, state-management

### Canonical path names should match their semantic role, not implementation
**Date:** 2026-03-01
**Context:** Renamed /workspace→/scratch, /agent-identity→/agent, etc. The old names were either too verbose or didn't convey the right mental model to the agent (e.g., /workspace didn't communicate "this is ephemeral").
**Lesson:** Short canonical names that describe purpose (/scratch, /agent, /shared, /user) are better than names that describe implementation (/workspace, /agent-identity, /agent-workspace, /user-workspace). The agent doesn't need to know it's a "workspace" — it needs to know it's ephemeral scratch space.
**Tags:** canonical-paths, naming, agent-ux

### Eliminate redundant mount points rather than documenting differences
**Date:** 2026-03-01
**Context:** Both /workspace (cwd) and /scratch were session-scoped ephemeral rw directories. The only difference was naming. Instead of explaining the subtle difference to agents, we removed one.
**Lesson:** If two mount points have the same lifecycle, permissions, and purpose, merge them. Agents don't benefit from subtle filesystem distinctions — they benefit from a small, clear set of canonical paths.
**Tags:** canonical-paths, simplification, mount-points

### AX has two workspace directories — session sandbox vs enterprise user
**Date:** 2026-02-26
**Context:** After migrating file storage from session workspace to enterprise user workspace
**Lesson:** AX has TWO distinct workspace directories:
1. **Session workspace** (`~/.ax/data/workspaces/<session-id-path>/`) — agent sandbox CWD, where agents can write files directly during execution. Ephemeral, tied to session ID.
2. **Enterprise user workspace** (`~/.ax/agents/<name>/users/<userId>/workspace/`) — durable per-user storage. Used for file uploads/downloads, generated image persistence, and `/v1/files/` API. Keyed by agent name + user ID.
After the migration, images are persisted to the **enterprise user workspace** and served via `?agent=<name>&user=<id>` query params. The session workspace remains as the sandbox CWD for agent execution.
**Tags:** workspaces, paths, session-id, images, file-api, enterprise

### Duplicate bootstrap files in both configDir and identity mount for agent visibility
**Date:** 2026-03-02
**Context:** Restructuring agent directory to isolate identity files in a mountable subdirectory. BOOTSTRAP.md and USER_BOOTSTRAP.md need to be readable by the sandboxed agent but also serve as authoritative state for host-side checks.
**Lesson:** When the host needs a file for server-side state checks AND the agent needs to read it from its sandbox mount, duplicate the file into both locations. The host copy in `agentConfigDir` is authoritative; the agent-readable copy in `identityFilesDir` is a convenience duplicate. On bootstrap completion, delete from both. This is simpler than adding stdin payload fields or symlinks.
**Tags:** architecture, bootstrap, identity, sandbox, file-layout

### OverlayFS for merging skill layers with fallback
**Date:** 2026-03-01
**Context:** Agent-level and user-level skills needed to appear as a single /skills directory. OverlayFS merges them with user skills shadowing agent skills. Falls back to agent-only when overlayfs is unavailable (macOS, unprivileged).
**Lesson:** Use overlayfs for merging read-only layers where user content should shadow shared content. Always implement a fallback for environments without overlayfs support (macOS, containers without CAP_SYS_ADMIN). The fallback can be degraded (agent-only) as long as the IPC layer still manages both via host-side operations.
**Tags:** overlayfs, skills, sandbox, fallback

### Node.js fetch() rejects transfer-encoding and content-length headers
**Date:** 2026-03-17
**Context:** Implementing HTTP forward proxy — POST requests through the proxy returned 502 errors.
**Lesson:** When forwarding HTTP requests via Node.js `fetch()`, always strip `transfer-encoding` and `content-length` headers from the incoming request before passing them to `fetch()`. Node's undici-based fetch handles these internally and throws `InvalidArgumentError: invalid transfer-encoding header` if you set them manually. Same pattern as the existing `tcp-bridge.ts`.
**Tags:** fetch, proxy, http, headers, transfer-encoding

### Async server.listen() required for ephemeral port assignment
**Date:** 2026-03-17
**Context:** Creating the web proxy with TCP ephemeral port (listen: 0) — the port was 0 when returned synchronously.
**Lesson:** When using `server.listen(0)` for ephemeral port assignment, the port is only available after the listen callback fires. Make the startup function async and await the listen promise to get the assigned port from `server.address()`.
**Tags:** net, server, listen, port, async

### SELECT-then-INSERT is a race condition — use atomic upsert
**Date:** 2026-03-21
**Context:** ensureExists() in ChatSessionStore used SELECT to check existence, then INSERT or UPDATE — a classic TOCTOU pattern.
**Lesson:** Always use `INSERT ... ON CONFLICT (id) DO UPDATE SET ...` for upsert operations. The SELECT-then-act pattern has a race window where two concurrent callers both see "not exists" and both try to INSERT, causing a duplicate key error. SQLite and PostgreSQL both support the atomic ON CONFLICT syntax.
**Tags:** sqlite, race condition, upsert, TOCTOU, database
