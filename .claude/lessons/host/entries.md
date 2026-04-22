# Host

### Outer catch in a long async function MUST also fire the canonical termination event
**Date:** 2026-04-22
**Context:** Task 6 review caught that the outer catch in `processCompletion` (server-completions.ts) flowed `completion_error` (error level) → `attach` → `chat_complete` (info level), so an operator running `grep "chat_complete\|chat_terminated"` would see `chat_complete` and conclude the chat succeeded. The original implementer's inline comment called this "a pre-existing gap" — but `chat_complete` was brand new in Task 6, so the gap was newly created by adding the wrapper without teaching the outer catch about it.
**Lesson:** When a structural wrapper (like `attach`) emits a success event on every return, every catch site that returns through the wrapper MUST first call the corresponding termination event + flag. Pattern: `if (!chatTerminated) logChatTermination(...); markTerminated();` before `return attach(...)`. Gate the emit on `!chatTerminated` so a more-specific inner site (e.g. spawn-throw that already emitted `phase: 'spawn'`) wins over the generic outer-catch fallback (`phase: 'dispatch', reason: 'completion_error'`). The `markTerminated()` is unconditional — its job is to suppress the success-side emit, not to dedupe terminations. Also: when adding the wrapper, audit every catch block in the function body, not just the return statements.
**Tags:** chat-termination, outer-catch, exactly-once, attach-pattern, code-review

### Pair every error-level "ended badly" event with an info-level "ended well" event of the same shape
**Date:** 2026-04-22
**Context:** Task 6 of the chat-correlation rollout added `logChatComplete` alongside `logChatTermination`. Without the success-side counterpart, operators scanning a slow or noisy log could only see the failure cases — they had no way to confirm "this chat finished, here's how long it took." Adding chat_complete with the SAME field shape (sessionId, agentId, durationMs, phases, sandboxId) means a single `grep "chat_complete\|chat_terminated"` covers every chat outcome with timing.
**Lesson:** When you add a canonical failure event for an operation, pair it with a canonical success event AT THE SAME TIME. Same field shape, different name + level. Two patterns matter: (1) emit the success event from a structural wrapper (the `attach` helper in `processCompletion` here) so a future contributor adding a new return path can't forget; (2) gate it on a `terminated` flag so a chat that already emitted `chat_terminated` doesn't ALSO emit `chat_complete`. The flag must be set at every termination call site — `markTerminated()` after every `logChatTermination(...)`, AND before any `throw` that flows into an outer catch which itself calls the wrapper. Operator workflow becomes "exactly one canonical line per operation regardless of outcome" — drill via reqId for context, alert on level >= error.
**Tags:** chat-complete, chat-terminated, observability, log-events, attach-pattern, exactly-once

### Coarse phase timing beats microbenchmark accuracy for operator triage
**Date:** 2026-04-22
**Context:** Adding phase-timing to `processCompletion` for the chat_complete event. Tempted to instrument every await boundary; ended up with four buckets — `scan` / `dispatch` / `agent` / `persist` — that account for the bulk of wall-clock time. The fast-path collapses dispatch into agent (no sandbox spawn) so it shows three phases instead of four. That's accurate, not a bug.
**Lesson:** When adding phase timing to a triage-grade log event, pick coarse buckets that map to operator mental models ("LLM was slow", "storage was slow", "catalog setup was slow"). 4-5 phases max. Sub-second precision is unnecessary; this isn't a benchmark, it's a "where do I look first" pointer. Use a small `phase('name')` helper that returns a `done()` closure — phases that never `done()` simply don't appear in the payload, which is correct by construction (a turn that returned before that phase started shouldn't claim phase data). Skip the trap of timing per-attempt inside a retry loop — the operator workflow is "was the agent slow?" not "which attempt was slow?"; per-attempt visibility lives at debug level via `agent_complete`.
**Tags:** phase-timing, observability, log-events, triage, operator-ux, processCompletion

### Canonical "chat ended" event must fire EXACTLY ONCE — never per retry attempt
**Date:** 2026-04-22
**Context:** Task 4 of the chat-correlation rollout wired `logChatTermination(...)` into the `agent_response_error` catch block inside the retry loop in `server-completions.ts`. Each failed attempt emitted `chat_terminated`, so a chat that failed once but succeeded on retry left a stale terminal event in the logs. Same problem at the safety-timer site in `server.ts` — the rejection it threw flowed into the same retry-loop catch and added a second emit.
**Lesson:** When you add a "this thing ended badly" event inside a retry loop, do NOT call the emit from the catch block — that fires once per ATTEMPT, not once per ENDED THING. Pattern: a small tracker object (record per attempt, emit-once at the terminal branch). The recorded most-recent cause should win over the generic terminal reason so the event names what actually killed it (e.g. `agent_response_timeout` not `agent_failed`). See `createWaitFailureTracker` in `src/host/chat-termination.ts` for the canonical shape — `record({reason, details})` per attempt, `emitTerminal(reqLogger, terminal)` at the truly-exhausted branch. Add a test that asserts `fail-then-succeed = 0 emits, all-fail = 1 emit` — not just "the emit fires." The exactness is the whole point.
**Tags:** chat-termination, retry-loop, exactly-once, observability, log-events, anti-pattern

### AX has its own `Logger` interface — don't import from `pino` even if a plan says to
**Date:** 2026-04-22
**Context:** Implementing `logChatTermination` per a plan that said `import type { Logger } from 'pino'`. AX defines its own `Logger` interface in `src/logger.ts` (debug/info/warn/error/fatal/child) — pino is an implementation detail, not the public type. Code throughout `src/host/` already imports `import { type Logger, ... } from '../logger.js'`.
**Lesson:** When wiring a new helper that takes a logger, always `import type { Logger } from '../logger.js'` (or `'../../src/logger.js'` from tests). Plans/notes that say `from 'pino'` are wrong for this codebase — pino's `Logger` has a different shape (level, isLevelEnabled, bindings, etc.) and would cause type drift if leaked into the host API. Cross-check against an existing host file (e.g. `src/host/server-completions.ts` line ~22) before trusting any logger-related import in a plan.
**Tags:** logger, pino, types, host, plans

### Agent UX hints belong in the prompt, not in the generated file
**Status: superseded 2026-04-20 (Phase 6 of tool-dispatch-unification)** — generated tool modules no longer exist; tools flow through `ax.callTool` / `call_tool` meta-tools with per-tool JSON Schemas rendered inline in the prompt. The underlying principle ("load-bearing hints go in the prompt, not in discoverable files") still applies — for current application, enforce it at `src/host/tool-catalog/render.ts`.
**Date:** 2026-04-19
**Context:** Fixed Linear retry spiral in layers: first the JSDoc (matched signature + enum union), then codegen guard (allow no-args), then a response-shape warning in the generated module's file header. Each fix helped but the agent kept hitting the next-in-line failure mode — enum hallucination (`type: 'active'`) and `.map` on a wrapped `{issues: [...]}` object. Both hints were in the *file*, but the agent never `read_file`s a generated module before calling its exports. It reads the system prompt. So the hints were effectively invisible.
**Lesson:** When you're writing hints to guide an agent's code generation, the only hints the agent is GUARANTEED to see are the ones in its system prompt (or its direct tool descriptions). File headers, JSDoc in imported modules, inline comments — these are discoverable, not loaded. If the cost of a mistake is a full LLM turn, pay the prompt-token cost to inline the hint. For AX specifically: enum values go in the `loadToolIndex` render (so signatures in the prompt say `type?: "a"|"b"|"c"`), and wrapping-protocol notes go in `RuntimeModule` adjacent to the `Available modules` section. The file-level header stays as secondary documentation — it's cheap to add and catches the rare "I wonder what this returns" file-reading agent, but it's not load-bearing. **How to apply:** before adding documentation to a generated file's body or header, ask: "what loads this into the agent's context?" If the answer is "only an explicit `read_file` the agent might or might not do," the hint is decorative. Put the load-bearing copy in the prompt module that renders alongside the pointer, and keep the file-level version as a fallback.
**Tags:** agent-ux, prompt-engineering, toolgen, documentation, load-bearing, codegen, superseded

### Defensive input guards must not reject the no-args case when all params are optional
**Date:** 2026-04-19 (updated 2026-04-20 — Phase 6 ported the guard into `ax.callTool`'s preamble)
**Context:** Originally landed in codegen's runtime guard — `listTeams()` with no args threw `TypeError: listTeams expects a single object argument`, but all of `list_teams`'s params (limit, cursor, orderBy, ...) are optional, and no-args is a legitimate "list everything" call. The guard was written as `if (params === null || typeof params !== 'object') throw`, which catches the string-arg mistake it was designed to catch AND the undefined-from-no-args case. Agents interpret the thrown TypeError the same way they interpret the IPC error it replaced — "I got the shape wrong" — and retry with arbitrary new shapes. The codegen pipeline is gone now; the equivalent guard lives in the `ax.callTool` preamble injected into `execute_script` sandboxes (see `src/agent/execute-script.ts`), keyed off a compact `{properties[], required[]}` map emitted per tool.
**Lesson:** When adding a defensive argument guard in front of a tool call, split the decision by whether any parameter is required. If `required.length === 0`, normalize undefined/null args to `{}` before the guard runs. If any param IS required, keep the bare check so a missing-required call still surfaces the actionable "expects a single object argument" error. **How to apply:** for `ax.callTool` and any equivalent front-end dispatch guard, check whether the zero-arg invocation should be valid (it is for pure list/enumerate operations, it isn't for operations that need an ID). Default the arg when required-set is empty, leave it bare when not. Add a test per branch so the guard's breadth can't silently regress.
**Tags:** ax.callTool, agent-ux, runtime-guard, defensive-programming, optional-params, preamble

### Silent response-wrapping contracts force agents into exploration turns
**Status: superseded 2026-04-20 (Phase 6 of tool-dispatch-unification)** — there's no generated module header anymore. If this problem resurfaces under the catalog/`ax.callTool` world, surface the wrapping convention via the tool description in `src/host/tool-catalog/render.ts` (inline in the prompt) rather than a separate file.
**Date:** 2026-04-19
**Context:** Many MCP servers (Linear, etc.) return list payloads as JSON-string text blocks containing an object keyed by the plural resource name: `list_issues` → `{issues: [...], pageInfo: {...}}`. Our generated stubs return whatever the tool response content is — we have no way to document the return shape because the MCP SDK's `connectAndListTools` only surfaces `inputSchema`, not `outputSchema`. Agents read the JSDoc, see list-looking names (`listIssues`), call `result.map(...)`, hit `X.map is not a function`, and burn 3-6 turns figuring out the wrapper. Every mistake costs a full LLM round trip.
**Lesson:** If you can't type a response precisely at codegen time, put the *convention* in a prominent place the agent will read before writing code — the module header is that place. Name the wrapping pattern, give a concrete example with the real tool name, and show the "log raw first" recovery pattern. Don't try to auto-unwrap `{<plural>: [...]}` heuristically — responses that also include pagination (`pageInfo`) would lose it, and different servers use different wrapper keys. Documentation is cheaper, safer, and gets the agent unstuck in one turn. **How to apply:** any time you generate code that calls into a wrapping protocol (MCP, GraphQL pagination, OData, JSON:API), emit a one-paragraph header comment with the wrapping pattern. When surfacing `outputSchema` becomes possible, escalate from prose to typed JSDoc `@returns` — but until then, the comment is the lever.
**Tags:** toolgen, codegen, agent-ux, mcp, response-shape, documentation, pagination, superseded

### In-memory registries that live past the request need a repopulation trigger on every restart path
**Date:** 2026-04-19
**Context:** (Historical: the tool-modules-git-native migration referenced here was itself deleted in Phase 6 of tool-dispatch-unification; `discoverAllTools` has been replaced by `ensureToolsDiscoveredForHead`, which runs per-turn from `server-completions.ts` and populates `McpConnectionManager.toolServerMap` lazily. The meta-lesson is still the one that matters.) Task 5 of the tool-modules-git-native migration removed the per-turn `discoverAllTools` call from `server-completions.ts`, correctly reasoning that the generated tool modules are now git-committed and don't need per-turn regen. But `discoverAllTools` had a second side-effect — populating `McpConnectionManager.toolServerMap` (agentId → toolName → serverUrl) — which the runtime tool-batch handler still depended on. After the removal, the map got populated ONLY by admin refresh-tools clicks. Between a pod restart and the next click, every subprocess tool call failed with "MCP gateway not configured." The inprocess fast-path kept its own discovery call so its map stayed warm, making the regression invisible in the common dev-loop. Classic hidden side-effect.
**Lesson:** Whenever you remove (or stop calling) a function that writes to an in-memory, in-process registry, ask: "what populates this registry on pod restart?" If the only answer is a human action (admin click, startup scan, cron), add an automatic re-populator at every entry point that reads the registry. Bonus points if you HEAD-cache (or similar cheap dedup) so the re-populator fires automatically on first use rather than adding network cost to every hot-path call. **How to apply:** search for all readers of the registry, then confirm each reader has a plausible path to a populator that runs without human action. Prefer "lazy trigger on first use, dedupe by stable key" over "eager repopulate at startup" — the former degrades gracefully if the registry's data source is temporarily unavailable.
**Tags:** mcp, in-memory-registry, side-effects, task-5, tool-server-map, pod-restart, repopulation

### When multiple code paths do "the same thing", an inconsistency between them is a regression waiting to ship
**Date:** 2026-04-19
**Context:** `tool-batch.ts` has four success-path branches that all push a tool-call result into the `results` array. The dispatcher path (landed first) had `try { results.push(JSON.parse(result.content)); } catch { results.push(result.content); }`. The unified/plugin/default paths (added later) each had `results.push(result.content)` — a raw-string push. Nothing in tests enforced parity. MCP servers that return JSON-string payloads (Linear, many others) landed through the later-added paths as strings, while agents' generated tool stubs assumed object returns. Agent code `team.id` was undefined; `teamId: undefined` shipped back to the server; server said "expected string"; spiral.
**Lesson:** When you see four branches that all write to the same accumulator with slightly different code, refactor them through a single helper at the point of inconsistency — even if "they're basically the same thing." The shape of the pushed value is part of the IPC contract; four hand-rolled variants is four chances for one to drift. **How to apply:** search `tool-batch.ts` (and any other dispatcher with N enumerated backends) for `results.push(`/`output.push(` calls on the success side; if they're not funneling through a shared helper, extract one. Add a test per path that exercises an edge case (JSON-string, non-JSON string, pre-parsed object, nullish content) so drift shows up as a red test, not a silent production regression.
**Tags:** tool-batch, ipc, consistency, refactor, regression, mcp, dispatcher-paths

### Codegen JSDoc must match the generated function signature exactly
**Status: superseded 2026-04-20 (Phase 6 of tool-dispatch-unification)** — the codegen pipeline (`src/host/toolgen/`) was deleted. Tool schemas are now rendered as inline JSON Schema via `src/host/tool-catalog/render.ts`; the "generated JSDoc must match the signature" class of bug no longer exists. The surviving analogue is: when rendering per-tool help, the signature in the description and the actual `inputSchema` handed to Zod must agree, and `ax.callTool`'s preamble throws a typed error (not a Zod record error) on bare-string args.
**Date:** 2026-04-19
**Context:** `src/host/toolgen/codegen.ts` generated tool-stub modules whose function signature was `listCycles(params)` (single object), but whose JSDoc advertised positional tags (`@param {string} teamId`). Agents read the JSDoc, called `listCycles("team-uuid")`, the string reached IPC, Zod `z.record(...)` rejected it as "expected record, received string". The error gave no hint about the fix, so the model retried with arbitrary new call shapes — we saw a user prompt produce 16 thrash `execute_script` calls in a single turn.
**Lesson:** For agent-facing generated code, JSDoc is part of the interface — a mismatch between docs and signature is a spec bug that manifests as retry spirals. When emitting `function fn(params)`, the docs must say `@param {object} params` and enumerate `params.*` properties with `[params.*]` for optionals. Also pair the docs with a runtime guard that throws `TypeError` with sample call syntax when the argument is not an object — defense in depth, since some models will still ignore the docs and the typed error name+message ends the retry loop much faster than a Zod record error. **How to apply:** any time you generate JS/TS stubs from a schema, treat the generated JSDoc and the generated signature as a single artifact; write at least one test asserting the JSDoc shape matches the calling convention, and one asserting the guard rejects wrong-shape inputs before the wire.
**Tags:** toolgen, codegen, jsdoc, agent-ux, error-messages, runtime-guard, retry-loop, superseded

### When deleting a reconciler, audit every side-effect it performed
**Date:** 2026-04-18
**Context:** (Historical: `.ax/tools/<skill>/` commits no longer exist — the codegen pipeline was deleted in Phase 6 of tool-dispatch-unification. Swap in "catalog entries" for "`.ax/tools/<skill>/` commits" if rereading today. The meta-lesson about reconciler side-effects is the point.) Skills SSoT migration (step 6) removed the reconciler pipeline and replaced its responsibilities with live git-derived state + tuple-keyed tables. The replacement wires credentials (`skill_credentials`) and domain approvals (`skill_domain_approvals`) at approval time. But the old reconciler also called `addMcpServer` — persisting skill-declared `mcpServers[]` to the `mcp_servers` table AND registering with `McpConnectionManager`. The new flow picked up the DB side (sort of — actually, no, it didn't do that either) and completely dropped the mcpManager side. Bug: `.ax/tools/<skill>/` commits never landed because `discoverAllTools` iterates an empty registry.
**Lesson:** Reconcilers are Swiss Army knives — when you delete one, enumerate every write-side effect and explicitly re-wire each one in the replacement, or decide deliberately to drop it. A checklist from `git log` + `git grep` + a few test agents would have caught this. Symmetric question for every future refactor: "what did the old thing write to, and who reads those writes?" If any consumer isn't being fed by some replacement, that's the silent-regression zone. **How to apply:** when removing a reconciler, daemon, or any effectful pipeline, write down its outputs explicitly, then verify each output has a corresponding producer in the new design. Don't trust the test suite to catch missing side-effects — if nothing tests the consumer path, the missing producer won't show up until production use.
**Tags:** skills, reconciler, refactor, regression, side-effects, ssot-migration

### Skill-scoped keys + orphan sweep are BOTH required to fix delete-then-re-add auto-enable
**Date:** 2026-04-18
**Context:** Admin reported re-adding a previously deleted skill auto-enabled without approval. My first instinct was a one-shot fix: make `storedCredentials`/`approvedDomains` keys include `skill_name` so a prior skill's row can't satisfy a different skill's requirement. That's necessary — cross-skill envName collision was a real bleed — but it doesn't cover the user's actual case: the re-added skill has the *same name* as before, so its own orphan rows still match. The second half is an orphan sweep: on every state read, delete `skill_credentials` + `skill_domain_approvals` rows whose `skill_name` isn't in the current workspace snapshot. Between steps the skill was absent; sweep ran; rows gone; re-add shows pending.
**Lesson:** Grant revocation has two failure modes that look similar but need different fixes. (1) Cross-entity bleed — key your "is this approved?" lookup by the entity name, not just the credential/domain. (2) Lifecycle staleness — when the entity is absent from the source of truth, clean up its rows so re-adding starts fresh. Fixing only (1) leaves (2) silently broken for same-name re-adds. The sweep has to run from every state-read entry point (admin UI paths AND proxy allowlist) so the timing of the user's next action doesn't determine the outcome. Idempotent + cheap enough to run on every read.
**Tags:** skills, approvals, security, state-derivation, lifecycle, orphans, invariants

### `AuditProvider.result` is `'success' | 'blocked' | 'error'` — not `'failure'`
**Date:** 2026-04-18
**Context:** (Historical: the "refresh-tools sync" referenced here is part of the codegen pipeline deleted in Phase 6 of tool-dispatch-unification. The audit-enum lesson stands on its own.) Task 4 of the tool-modules plan suggested emitting `result: 'failure'` on an audit entry when the refresh-tools sync throws. `tsc` rejected it: `src/providers/audit/types.ts` defines the enum as `'success' | 'blocked' | 'error'`. The UI side uses a wider `'ok' | 'error' | 'blocked' | 'timeout'`, so don't cross-reference there either.
**Lesson:** When emitting audit entries, the only three values that compile are `'success'`, `'blocked'`, and `'error'`. Use `'error'` for thrown exceptions / recoverable write failures, `'blocked'` for policy rejections (taint budget, path traversal, scanner hit), and `'success'` for everything that actually completed. Never invent a word like `'failure'` or `'ok'` at a call site — `tsc` will catch it, but a reviewer without the error in front of them will propose the wrong rename if the reference value ends up in a test too.
**Tags:** audit, enum, types, typescript

### `safePath` guards filesystem paths; use a fail-fast segment check for repo-relative commit paths
**Date:** 2026-04-18
**Context:** (Historical: `syncToolModulesForSkill` was deleted in Phase 6 of tool-dispatch-unification. The `safePath` vs repo-relative-path meta-lesson still applies to any future code that commits via git plumbing.) `syncToolModulesForSkill` takes a `skillName` and composes `.ax/tools/<skillName>/<server>.js` — a repo-relative path passed to `workspace.commitFiles`. My first instinct was to reach for `safePath()`, but that helper resolves against a filesystem base and verifies containment on disk. The commit here is landed via git plumbing (`hash-object`, `update-index --cacheinfo <path>`) — there's no on-disk base to contain against. A `..` segment would just silently land a blob at an unintended path inside the repo.
**Lesson:** When a segment is going into a repo-relative path that will be committed via plumbing (not written to the filesystem first), `safePath` is the wrong tool. Validate the segment inline with a small guard — reject `''`, `/`, `\`, `..`, `\0` — and fail fast BEFORE calling the commit primitive. The filesystem-containment check of `safePath` has no equivalent in git's object model, so you'd be adding a step that can't actually verify anything. Keep `safePath` for when the base is a real directory on disk.
**Tags:** safe-path, git, commit-files, path-traversal, repo-relative, invariants

### Don't mark deps optional "for test fixtures" — required-in-production means required in the type
**Date:** 2026-04-18
**Context:** Step 2 of the skills SSoT redesign threaded two new stores (`skillCredStore`, `skillDomainStore`) through `ApproveDeps`. I marked them optional with `?` on the theory that "test fixtures that construct partial `AdminDeps` keep working" and used `if (deps.skillCredStore) await deps.skillCredStore.put(...)` at the call sites. Reviewer flagged this as dead-code paranoia: in production they're wired unconditionally in the same `if (providers.database)` block as other required deps, every test fixture that exercises this code path already sets them, and the `if` guards inside the hot loop would be silently skipped in a misconfiguration instead of producing a loud error.
**Lesson:** If a dep is always present whenever the code path runs (in production AND in every test that actually reaches it), mark it required on the narrow helper's dep interface. Narrow upstream at the boundary (e.g. the route handler does `const { x } = deps; if (!x) return 503;`), then spread the narrowed locals into the helper call: `helper({ ...deps, x }, ...)`. Wider composition interfaces (`AdminDeps`, `HostCore`, `AdminSetupOpts`) can keep the dep optional to represent legitimate skip paths (no DB, disabled subsystem). The test-fixture concern is a non-issue — fixtures that don't exercise the code path don't need the dep; fixtures that do need to set it anyway. CLAUDE.md: "Don't add fallbacks for scenarios that can't happen."
**Tags:** typescript, optional-deps, type-narrowing, test-fixtures, yagni, dead-code

### Use empty-string sentinel in composite PKs when the "null" value needs to participate in the key
**Date:** 2026-04-18
**Context:** Step 2 of the skills SSoT redesign added `skill_credentials (agent_id, skill_name, env_name, user_id)` as a PK. The conceptual meaning of `user_id=null` is "agent-scoped, shared across users." The design doc wrote `user_id TEXT NULL` in the sketch — but Postgres refuses to include a nullable column in a PK constraint, and even if it accepted it, `WHERE user_id = $sessionId OR user_id IS NULL` behaves differently from `WHERE user_id IN ($sessionId, '')` due to NULL comparison semantics.
**Lesson:** When a "no value" sentinel needs to participate in a composite primary key or WHERE-clause tuple match, use an empty string (`''` with `NOT NULL DEFAULT ''`) not NULL. Document the meaning in a column comment. Turn-time lookup becomes a clean `WHERE user_id = $session_user_id OR user_id = ''`, no `IS NULL` branch, and the PK constraint works on both dialects. Reserve NULL for columns that are truly optional AND never part of a uniqueness/lookup key.
**Tags:** sql, primary-key, null, sentinel, postgres, sqlite, composite-key

### One clock, not two — DB-side `sqlEpoch(dbType)` for both defaults AND ON CONFLICT updates
**Date:** 2026-04-18
**Context:** `createSkillCredStore.put` originally passed `Math.floor(Date.now() / 1000)` in the `.values({ created_at, updated_at })` object AND in `doUpdateSet({ updated_at })`, while the column defaults in the migration used `sqlEpoch(dbType)` (`unixepoch()` / `EXTRACT(EPOCH FROM NOW())::integer`). Two clocks — host and DB — can skew if the app server's wall clock drifts from the DB's. Reviewer flagged this as a subtle bug waiting for a chaos day.
**Lesson:** For tuple-keyed tables with DB-defaulted epoch timestamps, don't set those columns on insert at all — let the migration default apply. For `doUpdateSet({ updated_at })`, pass the same `sqlEpoch(dbType)` RawBuilder the migration default uses. Thread `DbDialect` into the store factory (matches the `buildXMigrations(dbType)` pattern). One clock (DB-side), no host-clock dependence, and future stores that need the same semantics reuse the same helper without reinventing it. The earlier "JS-computed is dialect-neutral" shortcut was a local optimum that traded correctness for code terseness — reject it.
**Tags:** kysely, on-conflict, epoch, timestamp, sqlite, postgres, dialect, clock-skew

### Cache hit must be provably I/O-free — delete the repo between calls to prove it
**Date:** 2026-04-18
**Context:** While writing `tests/host/skills/get-agent-skills.test.ts` for the snapshot-cache-hit behavior, my first draft asserted "call count of getBareRepoPath stays at 1" — that checked the cache *path* was taken but didn't prove `buildSnapshotFromBareRepo` never ran. A bug where the cache key was wrong but the bare repo happened to still be walked would have passed that test silently.
**Lesson:** For any cache-hit test, after populating the cache, remove the underlying resource the cold path would read from. `fs.rmSync(bareRepoPath, { recursive: true, force: true })` between the first and second call forces the second call to fail if anything reaches for the filesystem. Same pattern applies to HTTP-backed caches (point the base URL at a dead host), DB-backed caches (drop the table), etc. Counter call-count alone is a proxy metric; filesystem/IO unavailability is the real assertion.
**Tags:** testing, caching, test-design, io-unavailability, lru

### Use `Map` for LRU in Node — insertion order is guaranteed, no dep needed
**Date:** 2026-04-18
**Context:** Implementing `src/host/skills/snapshot-cache.ts` — considered pulling `lru-cache` but it's a transitive-dep-heavy package for a <50-line bounded cache.
**Lesson:** JavaScript's `Map` guarantees iteration order matches insertion order (ECMAScript spec). That means `map.keys().next().value` is always the oldest key, and `delete + set` moves an entry to the end. An LRU cache with `get`/`put`/`evict-oldest-over-bound` takes ~20 lines and zero dependencies. Reach for `lru-cache` only if you need TTL, size-based eviction, or dispose callbacks — otherwise ship a Map-backed `createSnapshotCache({ maxEntries })`. Gotcha: the `delete+set` pattern matters on BOTH `get` (touch-to-refresh) AND `put` of an existing key (otherwise the order stays at the old insertion position).
**Tags:** lru, cache, map, iteration-order, dependencies

### Never import hardcoded-'sqlite' migration constants in code that may run against Postgres
**Date:** 2026-04-17
**Context:** `server-init.ts` imported `skillsMigrations` and `adminOAuthMigrations` — default exports of `src/migrations/{skills,admin-oauth-providers}.ts` that are baked as `build*('sqlite')`. When the DB provider was Postgres, those DDLs injected `unixepoch()` (SQLite-only) into `created_at` defaults, causing startup to fail with `function unixepoch() does not exist`.
**Lesson:** In any code path that can see both dialects (the host boot path, any provider that accepts a shared `DatabaseProvider`), always import the `build*` factory and pass `providers.database.type`. The hardcoded-'sqlite' exports in `src/migrations/*.ts` exist only for standalone SQLite-only fallbacks (e.g. wizard, scheduler fallback) — treat them as red flags anywhere else. Ideally we'd delete them, but today's fix is: factory + dialect arg whenever the DB is pluggable.
**Tags:** migrations, postgres, sqlite, dialect, server-init

### Defensive factory defaults hide init-order bugs — hoist side effects into the order they're needed
**Date:** 2026-04-17
**Context:** PR #181 review: `createAdminHandler` auto-generated `admin.token` if unset, which worked great for anything going through that factory. But `initHostCore` also consumed `admin.token` (via `deriveOAuthKey`), and it ran *first*. On a fresh install with no `AX_OAUTH_SECRET_KEY`, `deriveOAuthKey('', ...)` threw (refusing sha256('') as a key), `adminOAuthProviderStore` stayed undefined, we logged a misleading "OAuth disabled" warning, and THEN `createAdminHandler` generated a token seconds later. The defensive default in the downstream factory gave the illusion everything was fine — while the upstream silently degraded a feature.
**Lesson:** When two subsystems both touch the same piece of config and order matters, put the generation/derivation step at the *first* point of consumption, not the last. Keep defensive defaults in downstream factories (they're still valuable for tests that construct the downstream directly), but accept that they're no-ops on the happy path. Flag this in the comment so future readers don't assume the downstream gen is the source of truth. The rule: "if initialization order matters, initialize explicitly and early; don't rely on later factories to paper over it."
**Tags:** initialization, order-of-operations, factories, defensive-defaults, oauth, admin-token

### Fire-and-forget must use `void p.catch(...)`, not `try { await }` — and tests must flush microtasks
**Date:** 2026-04-17
**Context:** PR #181 review: `admin-oauth-flow.ts#resolveCallback`'s docstring promised fire-and-forget on `reconcileAgent`, but the implementation was `try { await input.reconcileAgent(...) } catch { logger.warn(...) }`. A slow reconcile (git fetch, lock contention, etc.) would hold up the OAuth success HTML in the user's browser for tens of seconds. The UI polls `/skills/setup` every 2s anyway, so the await bought nothing and hurt perceived latency. Fix: `void input.reconcileAgent(...).catch(err => logger.warn(...))`. Side effect on the test: the existing "reconcile throws → still returns ok" test trivially passed (the rejection now fires AFTER the fn returns), so it no longer verified anything useful.
**Lesson:** When the contract is "fire-and-forget + log on failure", write `void p.catch(handler)` — NOT `try { await p }`. The `void` operator makes the intent explicit and keeps ESLint happy on the floated promise. For the test: don't just assert the return value — assert NO unhandled promise rejection escaped. Pattern: `process.on('unhandledRejection', listener)`, run the call, `await new Promise(r => setImmediate(r))` to flush the microtask queue, assert the listener captured nothing. This catches both (a) missing `.catch` and (b) accidentally returning the rejected promise from a helper.
**Tags:** fire-and-forget, promises, void-operator, testing, microtask-flush, unhandled-rejection

### Text PKs in SQLite are case-sensitive by default — normalize to lowercase on read/write for user-supplied identifiers
**Date:** 2026-04-17
**Context:** PR #181 review: the admin OAuth provider store used `provider` as a text PK with no normalization. SQLite's default text collation is `BINARY`, so `'Linear'` and `'linear'` hash to different rows. Combined with a lookup site that passed the frontmatter value verbatim (`'linear'` from skill YAML), a duplicate upsert with `'Linear'` would silently create a shadow row that never matched lookups. Outcome: admin-registered provider overrides invisibly disabled.
**Lesson:** For any SQLite text PK that holds a user-supplied identifier (provider names, envNames, skill names), normalize the case on BOTH read and write inside the store module — don't leave normalization to each caller. Lowercase is the convention in this codebase. Also add duplicate-avoidance tests: upsert(`'Name'`) then upsert(`'NAME'`) should produce ONE row, not two. If you genuinely need case-preservation, either (a) store the original in a separate column and key off the normalized one, or (b) switch the column to `COLLATE NOCASE` — but be aware Postgres + SQLite handle that differently and Kysely doesn't abstract it.
**Tags:** sqlite, collation, text-pk, normalization, case-sensitivity, kysely

### Use AbortSignal.timeout(ms) for outbound fetch timeouts (Node 18+)
**Date:** 2026-04-17
**Context:** Phase 6 Task 4 token-exchange. `fetch(tokenUrl, { body, headers })` against an external OAuth provider will hang indefinitely if the provider is slow/unreachable — Node's global fetch has no default timeout. The pre-Node-18 pattern was a manual `AbortController` + `setTimeout` dance: create controller, schedule `controller.abort()`, pass `signal: controller.signal`, clear the timer on success/failure. Works but verbose and leaks timers on mistakes.
**Lesson:** For any outbound fetch to a third party (OAuth token endpoints, webhook receivers, etc.), add `signal: AbortSignal.timeout(15_000)` to the request init. It's a Node 18+ static that bundles the abort controller and timeout into one line, auto-cleans up, and surfaces as a `DOMException` with `name === 'TimeoutError'` on timeout. Pick 15s for OAuth-style synchronous exchanges; longer only if the endpoint is known-slow. Pair with status-only logging (see the sibling lesson about OAuth error-body logging) — don't let timeout failures leak the request body into logs either.
**Tags:** fetch, timeout, abortsignal, node18, outbound-http, oauth

### "matched" is state consumption, not exchange success — callback fall-through must gate on matched, not ok
**Date:** 2026-04-17
**Context:** Phase 6 Task 4. The `/v1/oauth/callback/:provider` handler tries the admin-initiated flow first and, on no match, falls through to the agent-initiated `oauth-skills.ts` path. First instinct was `if (adminResult.ok)` to decide when to return; fall-through happened on any failure. That would leak already-claimed admin states to the agent module, and also let a URL-path-mismatch attack carry a valid state into the other handler.
**Lesson:** Design dispatcher return types as `{ matched: false } | { matched: true; ok: true } | { matched: true; ok: false; reason: ... }`. `matched: true` means the dispatcher *consumed* the routing token (the OAuth state, here), regardless of whether the exchange succeeded. Any fall-through logic MUST gate on `matched: false`, never on `ok`. Apply the same rule when another subsystem also claims states (oauth-skills stores its own pending-flow map — we must NEVER release a state from admin-flow to agent-flow). Provider-path mismatch on the admin flow: consume the state, audit the mismatch, return `matched: true, ok: false` — never `matched: false`.
**Tags:** oauth, callback, state-machine, fall-through, dispatch, security

### Never log upstream response bodies on OAuth failures — they can echo back secrets
**Date:** 2026-04-17
**Context:** Phase 6 Task 4 token-exchange failure path. The existing `oauth-skills.ts` logged the raw response body on non-2xx (`body: text`). Some OAuth providers include the submitted `client_secret` or authorization `code` in their error responses (verbose error echoing), so that log line could persist secrets to pino files or centralized log aggregators.
**Lesson:** When an external identity provider returns an error, log `{ status, bodyLength }` only — never the body itself. If a particular provider routinely sends structured error codes you want visibility into, parse the body and whitelist specific known-safe fields (`error: 'invalid_grant'` etc.) before logging. Default is: status + length, no body. Same rule applies to token-exchange audit args.
**Tags:** oauth, logging, secrets, upstream-errors, audit

### Derive redirect_uri scheme from x-forwarded-proto first, req.socket.encrypted second
**Date:** 2026-04-17
**Context:** Phase 6 Task 3 — computing the OAuth `redirect_uri` server-side for the admin-initiated flow. In production, the host runs behind a TLS-terminating proxy (nginx, Cloudflare), so `req.socket.encrypted` is `false` even though the user's browser spoke `https` to the proxy. Building `http://<host>/v1/oauth/callback/linear` in that case means the authorization server will refuse (the OAuth app is registered with the `https` URI) or — worse — issue tokens to an `http` endpoint that the browser will downgrade-reject.
**Lesson:** When constructing a server-origin URL from an incoming request, check `req.headers['x-forwarded-proto']` first (and accept only the FIRST value if it's comma-separated — proxies chain them), fall back to `(req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'`. If the header exists but is empty, don't use it; fall back. For OAuth specifically, prefer letting operators configure an exact `redirectUri` via admin-registered provider config — proxies add enough uncertainty that "compute from the request" should be a fallback, not the primary path.
**Tags:** http, proxy, x-forwarded-proto, oauth, redirect_uri, tls

### Kysely's DeleteResult is an array; sum numDeletedRows across it
**Date:** 2026-04-17
**Context:** Phase 6 Task 1. The admin OAuth store needs `delete()` to return whether a row was actually removed (idempotent API contract: first delete returns true, second returns false). My first instinct was `const res = await db.deleteFrom(...).execute(); return res.numDeletedRows > 0n` — but Kysely's `execute()` on a delete returns `DeleteResult[]`, not a single object. Single-statement backends give you a one-element array, multi-statement backends (CTE-ful Postgres queries, multi-DB) give you multiple. Accessing `.numDeletedRows` directly on the array silently yields `undefined` (which is not > 0n, so the function always returns false).
**Lesson:** When consuming Kysely mutation results, always treat them as arrays and sum the `numDeletedRows`/`numUpdatedRows`/`numInsertedOrUpdatedRows` fields across the batch. Pattern: `const total = res.reduce((n: bigint, r) => n + r.numDeletedRows, 0n); return total > 0n`. The bigint literal `0n` matters — these fields are `bigint`, not `number`.
**Tags:** kysely, database, delete, idempotence, bigint

### AES-256-GCM: encode (iv || ciphertext || tag) into a single blob
**Date:** 2026-04-17
**Context:** Phase 6 Task 1 encrypting OAuth client secrets at rest. Node's `crypto` API forces you to keep track of three separate pieces (iv, ciphertext, tag) because `getAuthTag()` is returned *after* `final()`. Storing them in three DB columns is possible but annoying — every read/write gets a third the readability.
**Lesson:** For AES-256-GCM at rest, concatenate `Buffer.concat([iv(12), ciphertext, tag(16)])` and base64-encode the whole thing into a single TEXT column. On read: slice `iv = buf[0..12)`, `tag = buf[len-16..len)`, `ct = buf[12..len-16)`. Reject blobs shorter than 12+16 bytes up front — `decipher.setAuthTag` will throw on those anyway but a clear error beats an opaque GCM failure. Never reuse IVs; always `randomBytes(12)` per encrypt call.
**Tags:** crypto, aes-gcm, secrets-at-rest, node-crypto, encryption

### Admin auth is bypassed on loopback when BIND_HOST defaults to 127.0.0.1
**Date:** 2026-04-17
**Context:** Phase 5 Task 8 end-to-end verification. I was curling `/admin/api/*` endpoints with and without `Authorization: Bearer <token>` to confirm auth worked. Both succeeded. My first instinct was "the token check is broken" — it wasn't. `server.ts:332` sets `localDevMode = bindHost === '127.0.0.1' || bindHost === '::1'`, and `server-admin.ts:197` does `skipAuth = authDisabled || externalAuth || (localDevMode && isLoopback(clientIp))`. When the process binds to 127.0.0.1 AND the request comes from a loopback address, the token check is skipped — by design, for local dev.
**Lesson:** When testing admin endpoints locally, don't rely on "curl succeeded without a token → auth is broken" as a signal. To exercise the real auth path, either (a) set `BIND_HOST=0.0.0.0` and curl from a non-loopback address (not trivial on a dev laptop), (b) set `admin.disable_auth: false` and force a non-loopback connection, or (c) add a unit test that constructs AdminDeps with `localDevMode: false` and asserts the 401 — which is how `tests/host/server-admin.test.ts` already does it. If you're writing a task spec that says "curl with Authorization: Bearer $TOKEN", call this out explicitly so the reader knows the token is decorative on loopback.
**Tags:** admin-api, auth, localDevMode, BIND_HOST, loopback, testing

### EventBus has a single catch-all subscribe — filter by type in-handler
**Date:** 2026-04-17
**Context:** Phase 5 Task 5 needed a subscriber for `credential.required` events. My first reach was `eventBus.on('credential.required', listener)` because that's the EventEmitter-style API. But `src/host/event-bus.ts` only exposes `subscribe(listener)` (all events) and `subscribeRequest(requestId, listener)` (per-request) — no per-type subscription. The correct pattern is `eventBus.subscribe((event) => { if (event.type !== 'credential.required') return; ... })`.
**Lesson:** When wiring new subscribers on AX's event bus, skip the `.on('eventName', ...)` reflex — `EventBus` is catch-all. Subscribe once, guard `event.type` at the top of the handler. Also: `event.data` is `Record<string, unknown>` (not typed per event), so narrow fields yourself (`typeof data.envName === 'string'`). Do NOT change the event shape to fit a subscriber — read what's there, fall back to defaults if a field's missing.
**Tags:** event-bus, subscribe, pub-sub, host, patterns

### Audit-log failures must surface, not swallow
**Date:** 2026-04-17
**Context:** Phase 5 Task 3: the approve helper originally wrapped `providers.audit.log` in a try/catch that logged `skill_approve_audit_failed` and returned 200 — reasoning "audit failure shouldn't fail the approve call since creds + domains are already persisted." Spec review flagged it: CLAUDE.md lists "Everything is audited" as a security invariant. Silent audit loss on a security-relevant action (credential write + domain approval) is exactly the evidence gap the invariant exists to prevent. Unlike the reconcile path — where swallow-and-log is fine because the DB is already consistent and startup-rehydrate catches up — audit has no recovery mechanism. If the audit provider drops a record, it's gone.
**Lesson:** For any handler that performs a security-relevant mutation, treat the audit-log call like any other required side effect: no try/catch unless you have a concrete recovery path (which for audit, you almost never do). Let the error propagate to the outer request catch — a 5xx (or even a 4xx with a real error message) is the correct signal to operators. "Swallow-and-log" is valid when the surrounding state converges by some other mechanism (reconcile loops, idempotent retries, startup rehydration). It is NOT valid for append-only logs, audit trails, or anything whose absence can't be detected later. When in doubt, ask: "if this fails silently, is there a downstream process that will notice?" If the answer is no, let it throw.
**Tags:** audit, security-invariants, error-handling, admin-api, swallow-and-log, evidence-gap

### Multi-step admin endpoints must validate-all before they apply-anything
**Date:** 2026-04-17
**Context:** Phase 5 `POST /admin/api/skills/setup/approve` performs three applies (credentials → domains → reconcile). Early drafts interleaved validation with application ("parse cred, write cred, parse domain, approve domain, ..."), which would have left the system in a half-approved state on any downstream validation error — e.g. a bogus domain in the body after the first credential was already persisted. The spec's load-bearing invariant is: if *any* validation step fails, zero credentials written, zero domains approved, no reconcile.
**Lesson:** For multi-step endpoints that persist state, structure the handler as two distinct phases with no interleaving: (1) run every validation check against the request body and the pending card/state, collecting any first failure into an error return; (2) only if all checks pass, begin applying side effects. Also enforce the contract in a dedicated test: mix one valid item with one invalid item in the same body and assert that the valid item is NOT persisted. Without that test the atomicity can regress silently.
**Tags:** admin-api, atomicity, validation, approve, skills

### When a helper imports from a route handler, use a narrower deps interface to dodge cycles
**Date:** 2026-04-17
**Context:** Phase 5 Task 3 helper `approveSkillSetup` needed several fields from `AdminDeps` (defined in `server-admin.ts`). Importing `AdminDeps` back into the helper would have created a circular type import, since the route handler in `server-admin.ts` needs to import the helper too. `Pick<AdminDeps, ...>` would import the whole type transitively.
**Lesson:** When a helper module is consumed by the same module that owns a big "deps" type, declare a local narrower interface in the helper listing only the fields it actually uses, with the specific provider-typed sub-fields (e.g. `providers: ProviderRegistry`). The caller passes its full deps through — TypeScript's structural subtyping handles the compatibility for free. No shared type, no cycle.
**Tags:** typescript, circular-imports, admin-helpers, deps-interface

### Applier no-op checks must compare *all* runtime-observable fields, not just the identity key
**Date:** 2026-04-17
**Context:** PR #179 review: `mcp-applier` used `if (currentUrl === entry.url) continue;` as its idempotence check. That meant rotating a bearer credential while keeping the URL unchanged was silently skipped — the live server kept running with the stale `Authorization: Bearer ${OLD_TOKEN}` placeholder, and credential rotations never reached the runtime. The URL is the natural identity key (agents route on it), but it's not the only field the runtime consumes.
**Lesson:** Before treating a desired entry as "already applied," compare every field the live runtime actually uses — not just the identifier. For MCP entries that means URL *and* the computed header string (`Bearer ${TOKEN}`). Build the desired header up front, stash the current header in your `prior` map alongside the URL, and gate the no-op on both. Same pattern applies to any applier: enumerate runtime-observable fields, then compare all of them — missing one creates an invisible "stuck state" bug.
**Tags:** applier, mcp, idempotence, credential-rotation, code-review

### Closure-scoped `prior` maps need an explicit cleanup method for deleted keys
**Date:** 2026-04-17
**Context:** PR #179 review: `proxy-applier` used a `prior: Map<agentId, Set<domain>>` closure to diff desired vs previous. When an agent was deleted and later a new one created with the same ID, the stale `prior` entry caused the next apply to compute an incorrect diff (treating domains as already-present when the shared store had forgotten them). The fix was exposing a `removeAgent(agentId)` method that clears both the local `prior` and the shared store entry.
**Lesson:** Any long-lived closure-scoped Map keyed by an entity ID (agent, user, session) needs a paired cleanup hook invoked on entity deletion. Otherwise re-creating the entity starts with a stale baseline. Expose the cleanup as an explicit method on the returned object (not just a dangling `map.delete(id)` the caller has to know about). Pair it with cleanup of any shared downstream state so baseline and store stay in sync.
**Tags:** applier, closure-state, lifecycle, cleanup, code-review

### Don't emit "applied" events when the underlying apply failed
**Date:** 2026-04-17
**Context:** PR #179 review: reconcile orchestrator emitted `skills.live_state_applied` whenever either applier was configured, even if *both* applier calls threw. The event data carried `{ mcp: undefined, proxy: undefined }` but consumers looking at event type alone saw a false success signal. Fix: gate the emit on at least one summary field being defined.
**Lesson:** Event names communicate semantics. `foo.applied` means "foo was applied," not "we made an attempt." When applier calls are wrapped in per-call try/catch (so failures don't bubble), gate the success-shaped emit on "at least one non-undefined result," not on "the feature is enabled." Alternative: include explicit per-applier `ok` fields so subscribers can differentiate. Prefer gating unless failure is actually rare enough that downstream code wants to see both paths uniformly.
**Tags:** event-bus, error-handling, applier, reconcile, code-review

### Appliers diff desired-state against live runtime with a closure-scoped prior map
**Date:** 2026-04-17
**Context:** Phase 4 git-native skills needed to bridge the reconciler's `desired.{mcpServers,proxyAllowlist}` to the live `McpConnectionManager` + `ProxyDomainList`. The naive version would "re-read the live map, compute the diff, apply it" — but that blends other-source entries (plugins, database MCP, other agents) into the diff and risks clobbering them. The solution was to give each applier its own closure-scoped `prior` map keyed by the entries *this agent* previously wrote, plus a `source: 'skill:<agentId>'` tag on every registration so cross-source entries are never inspected. Startup rehydration then works by simply re-running `reconcileAgent` per agent — no separate "rebuild from DB" code path.
**Lesson:** When an applier module mutates a shared runtime map that other subsystems also write to, (1) tag every write with a source identifier (`source: 'skill:<agentId>'`), (2) keep a closure-scoped `prior` map of *only* the entries this applier owns — don't read back from the shared map to compute the diff, and (3) prefer re-running the full reconcile on startup over persisting a materialized "live state" — the desired-state computation is already idempotent and the DB has everything needed. Cross-source isolation falls out of the tag; rehydration falls out of the idempotency.
**Tags:** applier, reconcile, mcp-manager, proxy-domain-list, skills, startup, cross-source-isolation, architecture

### Shared resources consumed by both core and server.ts belong in HostCore
**Date:** 2026-04-17
**Context:** Phase 3 Task 4 — `SkillStateStore` needed to be reachable by both `createIPCHandler` (built inside `initHostCore`) and the reconcile-hook wiring (set up later in `server.ts`). Phase 2 originally created it in `server.ts:162`, but `initHostCore` had already finished by then, so the IPC handler couldn't see it. Moving creation into `server-init.ts` and returning it on `HostCore` (same pattern as `domainList`, `adminCtx`) made one instance reach both callsites.
**Lesson:** When a resource needs to be shared between `initHostCore` (which builds the IPC handler) and `server.ts` (which wires HTTP routes and external hooks), create it inside `initHostCore`, add it to the `HostCore` interface, and destructure it in `server.ts`. Don't create a second independent instance in `server.ts` — it silently desyncs from the one the IPC handler sees. The pattern already exists for `domainList`, `adminCtx`, `taintBudget`, `workspaceMap`.
**Tags:** host-core, server-init, shared-resources, architecture, ipc-handler

### Git worktrees share dist/ and node_modules — tsx resolves from main tree
**Date:** 2026-04-04
**Context:** Implementing multi-agent features in a worktree. Tests passed even before creating source files because tsx module resolution found the main tree's version via the shared dist/ directory.
**Lesson:** When using worktrees, always verify that module imports resolve from the worktree's `src/` not the main tree's `dist/`. Check with `find` before assuming a file doesn't exist. Copy files from main tree when needed.
**Tags:** worktree, tsx, module-resolution, testing

## Tool router header lookup must use server URL, not tool name
**Date:** 2026-03-29
**Context:** The tool router called `getServerMeta(agentId, call.name)` where `call.name` was the tool name (e.g. `linear__getIssues`), but `getServerMeta` expected a server name (e.g. `linear`). This silently failed to resolve headers for DB-configured MCP servers.
**Lesson:** When routing through a URL-based lookup chain (resolveServer returns URL, then you need metadata), look up by URL not by tool name. Add `getServerMetaByUrl` to avoid the name mismatch. Always verify the parameter semantics of lookup functions match what the caller actually has.
**Tags:** tool-router, mcp, header-resolution, naming-mismatch

## Scope proxy domain keys by agentId to prevent cross-agent collisions
**Date:** 2026-03-29
**Context:** Plugin proxy domain allowlist used `plugin:${pluginName}` as the key, which meant two agents installing the same plugin would share/overwrite domain entries, and uninstalling from one agent would remove domains for the other.
**Lesson:** Any per-agent resource key (proxy domains, command keys, etc.) must include agentId in the key to prevent cross-agent collisions. Use `plugin:${agentId}:${pluginName}` not `plugin:${pluginName}`.
**Tags:** proxy, domains, scoping, agentId, collision

## clearToolsForPlugin must run BEFORE removing servers from the map
**Date:** 2026-03-29
**Context:** When wiring plugin MCP tool-to-server URL cleanup into `removeServersByPlugin`, I called `clearToolsForPlugin` after the server deletion loop. But `clearToolsForPlugin` needs to read the server map to find which URLs belong to the plugin. By the time it ran, the servers were already gone, so no tool mappings were cleared.
**Lesson:** When a cleanup function depends on state that another cleanup function removes, always run the dependent cleanup first. In Map-based registries with cross-references, order of operations during removal matters — resolve dependencies before deleting the primary records.
**Tags:** ordering, cleanup, map, plugin, mcp, tool-router

### Proxy domain allowlist must also load from DB-stored skills on host startup
**Date:** 2026-03-26
**Context:** Skills installed via IPC are stored in the database `documents` table. On host restart, `server-init.ts` rebuilt the domain allowlist from filesystem and GCS skills only — not from the DB. This caused `api.linear.app` to be blocked with 403.
**Lesson:** When adding a new persistence path for data that feeds into startup initialization (like skills stored in DB vs filesystem), always check that the startup loader covers ALL persistence backends. The DB-stored skill domain extraction was added to `server-init.ts` as step 4 after filesystem and GCS scanning.
**Tags:** proxy, domains, startup, skills, database, persistence

### Never have two independent timers managing the same resource lifecycle
**Date:** 2026-03-26
**Context:** Session pod idle timeout (session-pod-manager) raced with watchPodExit safety timer (k8s.ts). watchPodExit fired at fixed time from pod creation; session-pod-manager fired from last activity. When watchPodExit won, it cleared the idle timer via removeSessionPod without killing the pod.
**Lesson:** When a resource has a primary lifecycle manager (session-pod-manager), any secondary timer (watchPodExit) must be set to a much larger value (24h backstop) — never competing with the primary. The secondary should only fire as an absolute safety net, not as a normal lifecycle event. Also ensure that any external removal path (removeSessionPod) also calls kill() to prevent orphans.
**Tags:** k8s, session-pod, idle-timeout, race-condition, timer

### Don't gate tool availability on intent detection — gate prompt instructions instead
**Date:** 2026-03-26
**Context:** The `skill` tool (install/update/delete) was filtered from the agent's tools when `skillInstallEnabled=false`, which was the default. Intent detection only matched install-like words, so "delete the linear skill" left the agent with no skill tool.
**Lesson:** Tool availability should be unconditional. Use intent detection to control prompt instructions (what the agent knows HOW to do), not tool definitions (what the agent CAN do). If a tool supports multiple operations (install+update+delete), don't gate all of them on intent for just one operation.
**Tags:** tool-catalog, filterTools, skill, intent-detection, prompt

### watchPodExit safety timeout must match session pod lifetime, not request timeout
**Date:** 2026-03-25
**Context:** Session pods were dying after 150s because `watchPodExit` used `config.timeoutSec` (120s per-request timeout) for its safety timer. The `.then()` on `exitCode` deletes the pod. Session-pod-manager still had the mapping → next turn queued work on a dead pod → hung forever.
**Lesson:** When spawning pods that will be registered as session pods (`deps.registerSessionPod` is defined), use `config.sandbox.idle_timeout_sec` (not `timeout_sec`) as the sandbox `timeoutSec`. Also always listen on `proc.exitCode` when registering session pods to clean up the session-pod-manager mapping on unexpected death.
**Tags:** k8s, session-pod, timeout, watchPodExit, hang

### resolveCredential must include global/unscoped fallback
**Date:** 2026-03-25
**Context:** Credentials stored via `/v1/credentials/provide` when session context was missing (host restarted after completion but before user entered credential) ended up in `global` scope. `resolveCredential()` only checked user and agent scopes → returned null → agent asked user for credentials again.
**Lesson:** `resolveCredential()` must fall back to unscoped `provider.get(envName)` (which maps to `global` scope in the database provider) after trying user and agent scopes. The in-memory `sessionContexts` map is volatile — always assume credentials might be stored at any scope level.
**Tags:** credentials, scope, global-fallback, session-context

### K8s work dispatch requires explicit queueWork wiring
**Date:** 2026-03-25
**Context:** The k8s simplification commit implemented session pod manager, GET /internal/work endpoint, and agent work loop in isolation — but never called `sessionPodManager.queueWork()` from the completion pipeline. Sandbox pods polled forever getting 404s.
**Lesson:** When implementing a producer-consumer pattern across files (server-k8s.ts creates sessionPodManager, server-completions.ts runs the pipeline), verify the handoff is actually wired. Check by grepping for the producer method (`queueWork`) — if it's only called in tests or the manager itself, the integration is missing. For k8s HTTP work dispatch: the `CompletionDeps` interface must include a `queueWork` callback, and it must be called in the k8s branch (where `deps.agentResponsePromise` is set) right before `startAgentResponseTimer`.
**Tags:** host, k8s, work-dispatch, session-pod-manager, integration-gap

### Session-long pods need session-level auth tokens, not per-turn tokens
**Date:** 2026-03-25
**Context:** Session pods were killed after each turn because: (1) work was keyed by per-turn token but pods poll with their original spawn token, (2) `proc.kill()` was called after every response, (3) `process.env.AX_IPC_TOKEN` in the agent was only set once (guarded by `!process.env.AX_IPC_TOKEN`).
**Lesson:** For session-long pods: use a two-layer token scheme. The pod gets a session-level `authToken` at spawn (stored in `tokenToSession` reverse map) for authenticating work fetch. Each turn creates a fresh `turnToken` for IPC calls, delivered inside the work payload. The agent MUST update `process.env.AX_IPC_TOKEN` unconditionally on each turn. Queue work by sessionId (not token), and `/internal/work` authenticates via `findSessionByToken(bearerToken) → sessionId → claimWork(sessionId)`. Never kill pods that are tracked by the session pod manager.
**Tags:** host, k8s, session-pod-manager, token, reuse, work-dispatch

### Proxy domain approval must be synchronous, not blocking
**Date:** 2026-03-22
**Context:** The old event-bus domain approval system caused deadlocks: agent blocked on bash (running curl), proxy blocked waiting for agent to approve the domain, agent can't approve because it's blocked. The `extractNetworkDomains` regex approach to pre-approve domains was brittle and failed on complex curl flags.
**Lesson:** Don't design systems where the proxy blocks waiting for the same agent that's blocked on the proxy. Use a synchronous allowlist instead: domains from installed skills are pre-approved at install time via `ProxyDomainList`. Unknown domains are denied immediately (no waiting) and queued for admin review. The host controls skill installation (`skill_install` IPC) and adds domains to the allowlist when generating the manifest.
**Tags:** host, web-proxy, deadlock, domain-allowlist, architecture

### Always handle socket errors on raw TCP before TLS wrapping
**Date:** 2026-03-22
**Context:** The MITM proxy wrapped `clientSocket` in a `tls.TLSSocket` but never added an error handler on the raw socket. When curl timed out (due to proxy approval deadlock), the TCP reset emitted an unhandled `error` event that crashed the host process.
**Lesson:** Always add `clientSocket.on('error', ...)` before creating a `tls.TLSSocket` wrapper. The TLS socket's error handlers don't catch errors on the underlying raw socket. Same applies to any socket piping or wrapping pattern.
**Tags:** host, web-proxy, socket, error-handling, crash

### Node.js fetch does NOT respect HTTP_PROXY env vars
**Date:** 2026-03-22
**Context:** Skills using Node.js SDKs (e.g., `@linear/sdk` which uses `fetch`) failed in k8s because Node.js built-in `fetch` (undici) ignores `HTTP_PROXY`/`HTTPS_PROXY`. Only curl/wget respect these. The sandbox has no direct port 443 egress, so fetch hangs.
**Lesson:** When testing web proxy credential injection, always test with curl first (respects proxy). Node.js fetch requires `--use-env-proxy` flag (Node 22+) or a custom global dispatcher. Skills that need API access should use curl, not Node.js SDKs, until Node proxy support is wired up.
**Tags:** host, web-proxy, node-fetch, proxy, k8s

### Post-agent credential detection must not gate on agent behavior
**Date:** 2026-03-20
**Context:** The post-agent credential loop only ran if the agent explicitly called `credential_request` AND `config.web_proxy` was truthy. Both conditions failed in practice.
**Lesson:** Never gate host-side detection on agent cooperation. The agent (especially smaller models) may not follow prompt instructions. Make detection unconditional — compare before/after workspace state, use ClawHub fallback for metadata when skill files lack frontmatter. Also: don't gate credential scanning on `config.web_proxy` since credentials are needed regardless of proxy config.
**Tags:** host, credentials, skills, defensive-design, model-agnostic

### LLM handler model precedence: req.model before configModel
**Date:** 2026-03-18
**Context:** Delegation passes `req.model` to override the default model, but `configModel ?? req.model` made the config default win
**Lesson:** In `createLLMHandlers`, the per-request `req.model` must take precedence over the `configModel` default. The correct precedence is `req.model ?? configModel ?? fallback`. The IPC handler is created once with `configModel` baked in, but delegation callers set `req.model` at call time — it must not be shadowed.
**Tags:** llm, model, delegation, ipc-handler, precedence

### processCompletionWithNATS must forward preProcessed for channel/scheduler paths
**Date:** 2026-03-18
**Context:** Scheduler callback in host-process.ts called processCompletion without preProcessed, causing double-enqueue and canary mismatch
**Lesson:** When `processCompletionWithNATS` wraps `processCompletion`, it must accept and forward the `preProcessed` parameter. Without it, the message gets scanned and enqueued twice — the first queue entry is orphaned and the outbound canary check compares against the wrong token, allowing canary-leak bypass. Always mirror server.ts's scheduler callback pattern.
**Tags:** k8s, nats, scheduler, canary, security, processCompletion, preProcessed

### provisionScope must use @google-cloud/storage SDK, not gsutil CLI
**Date:** 2026-03-17
**Context:** Agent pods had blank filesystem despite files being in GCS — debugging via `which gsutil` confirmed gsutil absent
**Lesson:** Agent pods don't have the Google Cloud SDK installed. Any in-pod GCS access must use the `@google-cloud/storage` Node.js SDK via lazy import. Never shell out to gsutil in code that runs inside agent pods. The write path already uses HTTP-to-host for the same reason.
**Tags:** k8s, gcs, gsutil, workspace, provisioning, pod, sdk

### GCS write prefix and provisioning prefix must come from the same source
**Date:** 2026-03-17
**Context:** Debugging blank k8s agent filesystem — files showed in GCS but agent saw nothing on next turn
**Lesson:** The GCS backend commits files using `config.workspace.prefix` (from the config file). The work payload builder was using `process.env.AX_WORKSPACE_GCS_PREFIX` for the provisioning prefixes. When only `config.workspace.prefix` was set, provisioning was silently skipped (all three GCS prefix fields were `undefined`). Fix: always derive the provisioning prefix from `config.workspace.prefix ?? process.env.AX_WORKSPACE_GCS_PREFIX`. When adding any read/write pair that both need the same GCS prefix, drive both from the same config source.
**Tags:** k8s, workspace, gcs, provisioning, config, env-var, blank-filesystem

### Streaming SSE must use try/catch/finally around processCompletion
**Date:** 2026-03-16
**Context:** Chat completions from web UIs hung forever when processCompletion threw during streaming mode
**Lesson:** When SSE headers are already sent (`res.headersSent === true`), the outer `handleRequest` catch block can't use `sendError()` — it must send an error SSE chunk + `data: [DONE]` + `res.end()` to close the stream. Always wrap streaming processCompletion in try/catch/finally. The `finally` must unsubscribe event bus listeners and clear keepalive timers. host-process.ts has the reference implementation.
**Tags:** streaming, sse, error-handling, server, hang

### Admin state is filesystem-based and doesn't sync across k8s pods
**Date:** 2026-03-16
**Context:** Fixed k8s agent identity persistence bug. The identity_write IPC handler checked `isAdmin(topDir)` by reading the local filesystem admins file. In k8s with NATS dispatch (separate host pod and agent-runtime pod), the agent-runtime pod always had an empty admins file because admin claims only happen on the host pod. Every identity_write returned `{ queued: true }` instead of persisting data.
**Lesson:** When admin state is filesystem-based and must be accessed from distributed pods, gate the admin check on `hasAnyAdmin()` — only enforce when admins are actually configured. When the admins file is empty (as on agent-runtime pods), skip the gate and let the host layer handle access control. This decouples admin persistence from distributed pod filesystems and avoids the sync problem entirely. Always check: is this gate only needed because I have configured admins, or is it a universal security requirement?
**Tags:** k8s, admin, identity, ipc-handlers, filesystem, nats-dispatch, access-control

### Sandbox tool handlers need their own mountRoot with workspace tier symlinks
**Date:** 2026-03-14
**Context:** After adding per-tier workspace permissions (agent/, user/ dirs), the agent still couldn't see these directories. The sandbox provider created a symlink mountRoot internally for the agent subprocess, but the IPC sandbox tool handlers on the host used workspaceMap (pointing to the scratch dir) as their CWD — no agent/ or user/ siblings existed there.
**Lesson:** When workspace tiers (agent/, user/) are available, processCompletion must create its own symlink mountRoot (via createCanonicalSymlinks) and store it in workspaceMap. The sandbox provider's internal mountRoot is only visible to the agent subprocess, not to the host-side tool handlers. Both sides need their own symlink layout pointing to the same real directories.
**Tags:** sandbox, workspace, symlinks, mountRoot, ipc-handlers, sandbox-tools, server-completions

### Admin TCP port must handle EADDRINUSE gracefully
**Date:** 2026-03-04
**Context:** When adding the admin dashboard with auto-TCP bind, integration tests started failing because multiple test-spawned servers all tried to bind port 8080. The `admin` config defaults to `enabled: true, port: 8080`, so every server instance tried to claim it.
**Lesson:** When auto-binding a TCP port for optional features (admin dashboard), catch EADDRINUSE and log a warning instead of crashing. Only throw for explicit `--port` from the user. Also: always add `admin: { enabled: false }` to test configs (ax-test.yaml) to prevent port conflicts in CI/parallel test runs.
**Tags:** server, admin, tcp, port, eaddrinuse, testing, config-defaults

### Tailwind v4 uses @tailwindcss/postcss, not direct tailwindcss plugin
**Date:** 2026-03-04
**Context:** The dashboard build failed with Tailwind v4 because `tailwindcss` can no longer be used directly as a PostCSS plugin. The PostCSS plugin moved to `@tailwindcss/postcss`. Also, `@tailwind base/components/utilities` directives were replaced with `@import "tailwindcss"`.
**Lesson:** When using Tailwind CSS v4+, use `@tailwindcss/postcss` in postcss.config.js and `@import "tailwindcss"` in CSS files. The `@tailwind` directives and `theme()` function in CSS are v3 patterns.
**Tags:** tailwind, css, postcss, build, dashboard

### IPC defaultCtx.agentId is 'system', not the configured agent name
**Date:** 2026-02-26
**Context:** Image resolver in ipc-handlers/llm.ts used `ctx.agentId` to look up images in user workspace, but images were persisted under `agentName` (typically 'main'). The resolver was looking in `~/.ax/agents/system/users/{user}/workspace/` instead of `~/.ax/agents/main/users/{user}/workspace/`.
**Lesson:** The IPC server's `defaultCtx` has `agentId: 'system'` — this is a fixed global context, not per-request. Any IPC handler that needs the configured agent name (from `config.agent_name`) must receive it as a separate parameter, NOT from `ctx.agentId`. The `agentName` is available in `createIPCHandler` scope and should be threaded through to any handler that needs it. The `_sessionId` injection mechanism only overrides `sessionId`, not `agentId`.
**Tags:** ipc, defaultCtx, agentId, image-resolver, workspace, enterprise

### Plugin providers use a runtime Map, not the static _PROVIDER_MAP
**Date:** 2026-02-27
**Context:** Implementing plugin framework — needed to register third-party providers at runtime without modifying the static allowlist (which would violate SC-SEC-002).
**Lesson:** Plugin-provided providers are stored in a separate `_pluginProviderMap` (Map), not in the `_PROVIDER_MAP` const. `resolveProviderPath()` checks the static map first, then falls back to the plugin map. This preserves the security invariant: built-in providers are static and auditable, while plugin providers are runtime-registered only by the trusted PluginHost after integrity verification. Use `registerPluginProvider()` (not direct map mutation) to add entries, and it will reject any attempt to overwrite built-in providers.
**Tags:** provider-map, plugins, security, SC-SEC-002, allowlist

### Child process IPC for plugins: fork() + process.send(), not worker_threads
**Date:** 2026-02-27
**Context:** Choosing between worker_threads and child_process for plugin isolation in PluginHost.
**Lesson:** Use `child_process.fork()` for plugin isolation, not `worker_threads`. Fork gives proper process isolation (separate V8 heap, can be sandboxed with nsjail), while workers share memory. The IPC protocol is simple: JSON messages over the built-in Node IPC channel (process.send/process.on('message')). Plugin sends `plugin_ready` on startup, host sends `plugin_call` with credentials injected server-side, plugin responds with `plugin_response`. This mirrors the agent<->host IPC pattern already used in AX.
**Tags:** plugins, plugin-host, isolation, child-process, ipc

### Orchestrator handle sessionId must match child agent event requestId
**Date:** 2026-03-01
**Context:** Heartbeat monitor was killing fire-and-forget delegates after 120s despite active tool/LLM work. The handle was registered with the parent's sessionId, but the child agent's events used a different requestId generated in handleDelegate.
**Lesson:** When registering an orchestrator handle for a child agent, the handle's `sessionId` must match the `requestId` that the child's `processCompletion` call will use for its events. Otherwise `sessionToHandles` lookup fails, auto-state never fires, and the heartbeat monitor sees no activity. The delegation handler should generate the child's requestId and pass it to onDelegate via `DelegateRequest.requestId`.
**Tags:** orchestration, heartbeat, delegation, sessionId, auto-state, requestId-alignment

### enableAutoState() must be called in production code
**Date:** 2026-03-01
**Context:** Auto-state inference existed in the orchestrator but was never called in server.ts — only in tests. This meant `tool.call` and `llm.done` events were never mapped to supervisor state transitions in production.
**Lesson:** After adding a feature to the orchestrator (like `enableAutoState()`), always wire it into `server.ts` where the orchestrator is created. Check that production code calls the method, not just tests. Also clean up the subscription in the shutdown path.
**Tags:** orchestration, auto-state, server, wiring, production-vs-test

### Session-to-handle mapping must be 1:N
**Date:** 2026-03-01
**Context:** Multiple agents can share a single sessionId — the auto-state inference map was Map<string, string> which lost earlier handles
**Lesson:** When building a mapping from sessionId to runtime entities (handles, connections), always use Map<string, Set<string>> or Map<string, string[]> to support multiple entities per session. A 1:1 map silently drops concurrent agents in the same session.
**Tags:** orchestrator, session-mapping, multi-agent, data-structure

### resolveCallerHandle OR vs AND bug pattern
**Date:** 2026-03-01
**Context:** Fixing caller identity resolution in orchestration IPC handlers where `bySession()` pre-filters candidates
**Lesson:** When writing `candidates.find()` after a pre-filter like `bySession(ctx.sessionId)`, never use `||` with a condition that the pre-filter already guarantees (e.g. `h.sessionId === ctx.sessionId`). The `||` makes the whole predicate always true, returning the first candidate. Use `&&` to narrow within the pre-filtered set.
**Tags:** logic-bug, find-predicate, orchestration, ipc-handlers

### Orchestration handlers now wired into createIPCHandler
**Date:** 2026-03-01
**Context:** Previously orchestration IPC handlers were defined but never registered in the main dispatcher
**Lesson:** After wiring orchestration handlers via `opts.orchestrator` in `createIPCHandler`, the cross-component test skip set is still needed because that test doesn't configure an orchestrator. Update the comment from "separate handler" to "requires Orchestrator instance" for accuracy.
**Tags:** ipc-server, orchestration, handler-registration, cross-component-test

### Async fire-and-forget needs a collect mechanism, not polling
**Date:** 2026-03-01
**Context:** Added `wait: false` to delegate, told the prompt to "poll via agent_orch_status" — but that IPC action wasn't exposed as an agent tool. The agent resorted to `sleep 15 && echo ...`.
**Lesson:** When adding an async fire-and-forget pattern, always provide a **blocking collect tool** (like `delegate_collect`) that accepts handleIds and awaits all results. Polling is bad UX for LLMs — they improvise with sleep/retry. A collect action that blocks until done is cleaner. Also: verify end-to-end that the agent actually has access to every tool/action referenced in its prompt.
**Tags:** delegation, async, fire-and-forget, agent-tools, prompt-tool-mismatch

### Inject filesystem ops as deps for testable HTTP handlers
**Date:** 2026-03-03
**Context:** Building the webhook handler needed existsSync/readFileSync for transform files, but mocking the filesystem in tests is fragile.
**Lesson:** When a handler needs to check file existence or read files, inject those as callbacks in the deps struct (e.g. `transformExists: (name) => boolean`, `readTransform: (name) => string`) instead of importing fs directly. This makes the handler fully testable with simple mocks and avoids temp file setup/teardown in tests. The server.ts composition root provides the real implementations.
**Tags:** testing, dependency-injection, webhook, server-composition

### Features in server.ts must also be ported to host-process.ts
**Date:** 2026-03-05
**Context:** Webhook transforms were fully implemented in server.ts (local all-in-one) but the k8s host entry point (host-process.ts) was never updated. K8s acceptance tests returned 404 for all webhook routes.
**Lesson:** AX has two HTTP server entry points: `server.ts` (local) and `host-process.ts` (k8s). Any new HTTP route or feature added to server.ts MUST also be ported to host-process.ts — or better, extract the shared route handling into a common module. The dispatch mechanism differs (direct processCompletion vs NATS publish), but route matching, auth, rate limiting, and response shaping should be shared. Always run acceptance tests in BOTH local and k8s environments to catch this class of gap.
**Tags:** host-process, server, k8s, webhook, integration-gap, dual-entry-point

### Per-session NATS LLM proxy must be started for claude-code in k8s mode
**Date:** 2026-03-05
**Context:** Phase 3 implementation had `startNATSLLMProxy()` written but not called in agent-runtime-process.ts. The claude-code runner also lacked k8s detection to switch from TCP bridge to NATS bridge.
**Lesson:** When adding cross-pod communication (like LLM proxying via NATS), both sides must be wired: the proxy subscriber (agent-runtime) AND the publisher (sandbox pod/nats-bridge). The proxy is per-session (scoped to `ipc.llm.{sessionId}`) and must be cleaned up in `finally` blocks. Detection in the agent subprocess uses env vars (`NATS_URL`) since CLI args are set by the host.
**Tags:** nats, llm-proxy, claude-code, k8s, agent-runtime, phase3
