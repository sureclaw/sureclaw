# IPC

### "catalog" grep matches both tool-catalog and catalog-store — different systems
**Date:** 2026-04-06
**Context:** Removing the catalog-store IPC system (catalog_publish/get/list/unpublish/set_required). Grepping for "catalog" returned many matches from src/agent/tool-catalog.ts which is the agent-side tool metadata registry — a completely different system.
**Lesson:** When removing the catalog-store system, only touch files that reference catalog-store.ts, catalog IPC schemas (catalog_publish etc.), or ipc-handlers/catalog.ts. Leave all tool-catalog.ts references alone — that's the agent tool metadata system (TOOL_CATALOG, filterTools, etc.) which has nothing to do with the catalog-store.
**Tags:** ipc, catalog, refactoring, naming-collision

### Removing IPC schemas requires updating tool-catalog, mcp-server, prompt modules, and 4+ test files
**Date:** 2026-03-22
**Context:** Replaced `skill_search` + `skill_download` IPC schemas with `skill_install`. The sync test (`tool-catalog-sync.test.ts`) enforces bidirectional consistency: every IPC schema must map to a catalog tool or be in `knownInternalActions`, and every catalog action must have an IPC schema. The skills prompt module and its test also reference the old action names.
**Lesson:** Renaming or removing an IPC action has blast radius across: (1) `ipc-schemas.ts`, (2) the handler in `ipc-handlers/*.ts`, (3) `tool-catalog.ts` actionMap, (4) `mcp-server.ts` action dispatch, (5) the prompt module referencing the tool, (6) `tool-catalog-sync.test.ts`, (7) `tool-catalog-credential.test.ts`, (8) `tool-catalog.test.ts`, and (9) the prompt module test. Always search for the old action name across the entire codebase before committing.
**Tags:** ipc, schema, blast-radius, refactoring, sync-tests

### IPC schema enums are the real gatekeeper, not the handler
**Date:** 2026-03-17
**Context:** workspace_write with tier='session' silently failed in K8s e2e tests. Debug logs in the handler never fired. The Zod strict schema in ipc-schemas.ts rejected the request before the handler was called, returning a generic validation error to the agent.
**Lesson:** When an IPC action silently fails (handler never called), check the Zod schema enum in ipc-schemas.ts FIRST. The strict-mode validation runs before handler dispatch (ipc-server.ts step 3, line ~206) and returns a generic error that the agent may swallow. Compare the schema enum values against the tool catalog's description and the MCP server's Zod types — mismatches are the most common cause.
**Tags:** ipc, zod, schema, workspace, debugging, silent-failure

### Always await server.listen() before accepting connections
**Date:** 2026-03-15
**Context:** `createIPCServer` called `server.listen(socketPath)` without awaiting — the socket file isn't created until the event loop processes the bind. First Slack message after server restart raced ahead and spawned an agent before the socket existed. Subsequent messages worked because the socket was created by then.
**Lesson:** `net.Server.listen()` is async even for Unix sockets. Always await the `listening` callback (or wrap in a Promise) before proceeding with any code that depends on the socket being ready. Make `createIPCServer`-style factories return `Promise<Server>` so callers can't accidentally skip the wait. Also keep sandbox-managed files (bridge sockets) in a separate subdirectory from host IPC sockets.
**Tags:** ipc, server-listen, race-condition, unix-socket, async, startup

### IPC client cannot handle concurrent calls without message ID correlation
**Date:** 2026-03-15
**Context:** Debugging empty response in web UI. The pi-coding-agent's second LLM call got an identity_read response instead of the actual LLM response because 3 concurrent tool IPC calls all registered separate `data` handlers on the same socket.
**Lesson:** Never use per-call socket `data` handlers when concurrent calls share the same socket. Use a single shared data handler with a pending-calls map keyed by message ID. Every new IPC metadata field (`_msgId`, like `_sessionId`) must be: (1) stripped in `handleIPC` before Zod validation, (2) echoed by the socket/bridge layer, and (3) echoed in ALL test mock servers — there are 6+ scattered mock IPC servers across the test suite.
**Tags:** ipc, concurrency, socket, data-handler, response-correlation, mock-servers

### IPC schemas use z.strictObject — extra fields cause silent validation failures
**Date:** 2026-02-25
**Context:** Adding `_sessionId` to IPC requests for session-scoped image generation. All server/integration tests started failing with empty responses.
**Lesson:** All IPC schemas in `src/ipc-schemas.ts` use `z.strictObject()` which rejects any unknown fields. When adding metadata fields to IPC requests (like `_sessionId`), you MUST strip them from the parsed object BEFORE passing it to schema validation. The pattern is: extract the field, delete it from parsed, then validate. This is easy to miss because the validation failure is caught and returns a generic error, making the agent produce empty output with exit code 0.
**Tags:** ipc, zod, strictObject, validation, image-generation, session-id

### ipcAction() auto-registers schemas in IPC_SCHEMAS — just call it at module level
**Date:** 2026-02-22
**Context:** Adding enterprise IPC schemas to ipc-schemas.ts
**Lesson:** The `ipcAction()` builder function both creates and registers Zod schemas in the `IPC_SCHEMAS` map as a side effect. Just call it at module level — no separate registration step needed. All schemas use `.strict()` mode for safety.
**Tags:** ipc, schemas, zod, ipc-schemas

### IPC schema enums must use exact values — check ipc-schemas.ts
**Date:** 2026-02-22
**Context:** `identity_propose` tests failed with "Validation failed" because `origin: 'agent'` doesn't match the Zod enum `['user_request', 'agent_initiated']`
**Lesson:** Always check the Zod schema in `src/ipc-schemas.ts` before writing IPC test assertions. Schema fields like `origin`, `decision`, `status`, and `file` use strict enums. Common gotcha: `IDENTITY_ORIGINS = ['user_request', 'agent_initiated']`, not `'agent'` or `'user'`. Similarly, `proposalId` and `memory_read.id` must be valid UUIDs.
**Tags:** ipc, schemas, zod, testing, validation, governance

### IPC handler response shapes vary by handler — check the actual handler code
**Date:** 2026-02-22
**Context:** Writing E2E tests, expected `result.results` for web_search but it was `result[0]`
**Lesson:** IPC handlers return arbitrary objects/arrays that get spread into `{ ok: true, ...result }`. Some handlers return arrays (web_search -> SearchResult[]), which become indexed keys (result[0], result[1]). Others return flat objects (web_fetch -> { status, headers, body, taint }). Always read the handler source to know the response shape — don't assume wrapping like `result.response.status`.
**Tags:** ipc, testing, web, handlers, response-shape

### Adding IPC schemas without handlers causes ipc-server tests to fail
**Date:** 2026-02-27
**Context:** Added `plugin_list` and `plugin_status` IPC schemas in ipc-schemas.ts but forgot to create corresponding handlers. The ipc-server.test.ts has a sync test that verifies every schema has a handler.
**Lesson:** Every call to `ipcAction()` in ipc-schemas.ts MUST have a corresponding handler registered in ipc-server.ts. The sync test `every IPC_SCHEMAS action has a handler` catches this. Additionally, new internal-only IPC actions (not in tool catalog) must be added to `knownInternalActions` in tool-catalog-sync.test.ts. Checklist when adding new IPC schemas: (1) create handler in src/host/ipc-handlers/, (2) register in ipc-server.ts, (3) add to knownInternalActions if not agent-facing.
**Tags:** ipc, schemas, handlers, testing, sync-tests, plugins

### onDelegate callback signature changes require updating all test files + harness
**Date:** 2026-02-25
**Context:** Changed onDelegate from `(task, context, ctx)` to `(req: DelegateRequest, ctx)` — tests broke in 4 locations
**Lesson:** When changing an IPC handler callback signature, update: (1) ipc-server.ts (type definition), (2) delegation.ts (handler implementation), (3) harness.ts (HarnessOptions type), (4) all test files that pass the callback: unit tests, e2e tests, and integration tests. Grep for the old function name across all test directories.
**Tags:** ipc, delegation, testing, callback-signatures, refactoring

### Orchestration IPC actions need registration in both sync tests
**Date:** 2026-03-01
**Context:** Adding orchestration IPC schemas caused two test failures: `tool-catalog-sync.test.ts` and `cross-component.test.ts`
**Lesson:** When adding new IPC schema actions, update two test files: (1) `tests/agent/tool-catalog-sync.test.ts` — add to `knownInternalActions` if the action is host-internal (not in TOOL_CATALOG), and (2) `tests/integration/cross-component.test.ts` — add to the skip set for "every IPC_SCHEMAS action has a handler" test if the handler is wired outside `createIPCHandler`. These two tests ensure schema/handler/catalog completeness.
**Tags:** testing, ipc-schemas, tool-catalog, cross-component, orchestration

### z.record() in Zod v4 requires key and value schemas
**Date:** 2026-03-01
**Context:** TypeScript build failed on `z.record(z.unknown())` in IPC schemas (from base orchestration branch)
**Lesson:** In Zod v4 (`zod@^4.x`), `z.record()` requires two arguments: `z.record(keySchema, valueSchema)`. The Zod v3 pattern `z.record(z.unknown())` (single arg) no longer compiles. Use `z.record(z.string(), z.unknown())` instead. Check existing usage patterns in the file (e.g., `z.record(safeString(200), safeString(4096))`) for the correct v4 signature.
**Tags:** zod, zod-v4, ipc-schemas, typescript, breaking-change

### Promise.race timeouts MUST be cleared in finally blocks
**Date:** 2026-02-27
**Context:** Diagnosing server crashes under 3 concurrent delegation agents
**Lesson:** Every `Promise.race([handler, timeout])` pattern MUST store the timeout ID and call `clearTimeout()` in a finally block. Without this, each call leaks a long-lived timer (15 min in our case). Under concurrent agent delegations, hundreds of leaked timers accumulate, causing memory pressure and eventual OOM. The pattern: `let timeoutId; try { timeoutId = setTimeout(...); await Promise.race(...); } finally { clearTimeout(timeoutId); }`
**Tags:** ipc, timer-leak, promise-race, memory-leak, delegation

### Always clean up Map entries in ALL code paths (success AND error)
**Date:** 2026-02-27
**Context:** Found sessionCanaries map leak causing OOM on repeated delegation failures
**Lesson:** When a Map entry is set before a try block (like `sessionCanaries.set(id, token)`), ensure the corresponding `.delete()` is in BOTH the success path AND the catch block. Using try/finally for cleanup is ideal but may conflict if the success path needs to delete before returning. At minimum, add the cleanup to the catch block alongside `db.fail()`.
**Tags:** memory-leak, map-cleanup, error-handling, sessionCanaries
