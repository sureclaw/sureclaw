# Lessons Index

## Key Principles

1. **Run the full test suite before committing.** Sync tests (tool-catalog-sync, sandbox-isolation, cross-component) catch cross-module consistency issues that targeted test runs miss. Use `npm test -- --run`.
2. **Zod strict mode rejects unknown fields silently.** Every IPC schema uses `z.strictObject()`. New metadata fields must be stripped before validation, and renamed Config fields require updating all YAML fixtures and inline test configs.
3. **Every ipcAction() needs a handler, and every handler needs sync-test registration.** The checklist: create handler in `src/host/ipc-handlers/`, register in `ipc-server.ts`, add to `knownInternalActions` if not agent-facing.
4. **Clear Promise.race timeouts in finally blocks.** Leaked timers cause OOM under concurrent delegation. Always store the timeout ID and `clearTimeout()` in finally.
5. **Fix layout problems structurally, not with runtime workarounds.** Prefer peer directories over temp-dir copies; merge redundant mount points rather than documenting differences.
6. **Cross-provider imports go through shared-types.ts.** Never import directly from sibling provider directories. Shared router utilities go in `router-utils.ts`.
7. **Use import.meta.resolve() for package name resolution.** Dynamic `import()` resolves from CWD, which attackers can control. `import.meta.resolve()` resolves from the calling module's location.
8. **Set AX_HOME and disable pino in tests.** Any test touching workspace/identity/scratch paths needs `AX_HOME` set to a temp dir and `initLogger({ file: false, level: 'silent' })`.
9. **Orchestrator handle sessionId must match child agent requestId.** Mismatches cause auto-state inference and heartbeat monitoring to silently fail.
10. **Each LLM/image provider has different API shapes.** Never assume OpenAI compatibility. Check provider docs and create separate implementations for distinct API shapes.

## Entries

### infrastructure

- Queue-group work delivery only happens when the host does not preselect a pod [infrastructure/entries.md](infrastructure/entries.md)
- NATS work delivery needs retry — agent subprocess takes seconds to subscribe [infrastructure/entries.md](infrastructure/entries.md)
- server.ts createServer() lacks k8s HTTP IPC infrastructure [infrastructure/entries.md](infrastructure/entries.md)
- Custom PG username requires BOTH AX-level and Bitnami subchart-level auth settings [infrastructure/entries.md](infrastructure/entries.md)
- Helm subchart dependencies should be gitignored [infrastructure/entries.md](infrastructure/entries.md)
- ConfigMap-mounted config reuses loadConfig() via AX_CONFIG_PATH [infrastructure/entries.md](infrastructure/entries.md)
- Security contexts must stay hardcoded in k8s-client.ts [infrastructure/entries.md](infrastructure/entries.md)
- Warm pod exec avoids env var injection problems [infrastructure/entries.md](infrastructure/entries.md)
- Mock warm-pool-client directly in integration tests, not via shared k8s mocks [infrastructure/entries.md](infrastructure/entries.md)
- Host deployment needs API credentials for memory recall and extraction [infrastructure/entries.md](infrastructure/entries.md)
- Bitnami PostgreSQL needs explicit auth.password for custom users [infrastructure/entries.md](infrastructure/entries.md)
- sqlite-vec is available but unused in k8s PostgreSQL mode -- pgvector is the right path [infrastructure/entries.md](infrastructure/entries.md)
- Keyword search LIKE bug: OR-joined terms treated as literal string [infrastructure/entries.md](infrastructure/entries.md)
- Both host and agent-runtime have independent cortex provider instances [infrastructure/entries.md](infrastructure/entries.md)
- Use Helm hook Jobs for PostgreSQL extensions and user setup [infrastructure/entries.md](infrastructure/entries.md)

### testing

- Sandbox providers use source-level test assertions (read source, check patterns) [testing/patterns.md](testing/patterns.md)
- Regex tests on source code are fragile — prefer semantic assertions [testing/patterns.md](testing/patterns.md)
- Retry tests with real backoff delays need careful design [testing/patterns.md](testing/patterns.md)
- Mock LLM provider doesn't echo model names — use provider failures to verify routing [testing/patterns.md](testing/patterns.md)
- Smoke tests use stdout markers to detect server readiness [testing/patterns.md](testing/patterns.md)
- Changing prompt module output breaks tests in multiple locations [testing/patterns.md](testing/patterns.md)
- When adding new prompt modules, update integration test module count [testing/patterns.md](testing/patterns.md)
- Use createHttpServer for isolated SSE endpoint tests instead of full AxServer [testing/patterns.md](testing/patterns.md)
- Agent stdin payload must parse ALL fields — missing fields cause silent feature loss [testing/infrastructure.md](testing/infrastructure.md)
- Tool count tests are scattered across many test files [testing/infrastructure.md](testing/infrastructure.md)
- Tool count is hardcoded in multiple test files — update all of them [testing/infrastructure.md](testing/infrastructure.md)
- Set AX_HOME in tests that use workspace/identity/scratch paths [testing/infrastructure.md](testing/infrastructure.md)
- scratchDir requires valid session ID format [testing/infrastructure.md](testing/infrastructure.md)
- Multiple TestHarness instances need careful dispose ordering [testing/infrastructure.md](testing/infrastructure.md)
- Integration tests that spawn server processes need shared servers and long timeouts [testing/infrastructure.md](testing/infrastructure.md)
- Always run full test suite before committing — targeted runs miss sync tests [testing/infrastructure.md](testing/infrastructure.md)
- Mock provider registries must include all sub-providers accessed at handler construction time [testing/infrastructure.md](testing/infrastructure.md)
- When migrating writes from filesystem to a store, update ALL read-back helpers in tests [testing/infrastructure.md](testing/infrastructure.md)
- Always disable pino file transport in tests that set AX_HOME to a temp dir [testing/infrastructure.md](testing/infrastructure.md)
- Test concurrent async handlers using the handler factory directly, not the IPC wrapper [testing/concurrency.md](testing/concurrency.md)
- :memory: SQLite databases don't work with separate connections [testing/sqlite.md](testing/sqlite.md)
- Separate Kysely + openDatabase connections can't share :memory: databases [testing/sqlite.md](testing/sqlite.md)
- ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite [testing/sqlite.md](testing/sqlite.md)
- Always check runMigrations result.error in store factories [testing/sqlite.md](testing/sqlite.md)
- Creating a MessageQueueStore in tests requires full storage provider setup [testing/sqlite.md](testing/sqlite.md)
- Structured content serialization — use JSON detection on load [testing/sqlite.md](testing/sqlite.md)
- SQLite autoincrement IDs don't respect logical ordering after delete+insert [testing/sqlite.md](testing/sqlite.md)
- Bootstrap lifecycle must be tested end-to-end including server restarts [testing/bootstrap.md](testing/bootstrap.md)
- isAgentBootstrapMode requires BOTH SOUL.md and IDENTITY.md to complete bootstrap [testing/bootstrap.md](testing/bootstrap.md)

### architecture

- In-memory promise maps create hidden session affinity requirements [architecture/entries.md](architecture/entries.md)
- Post-agent credential loop pattern [architecture/entries.md](architecture/entries.md)
- Shared outbound proxies need per-turn auth to preserve session identity [architecture/entries.md](architecture/entries.md)
- K8s filesystem lifecycle must stay inside one pod or use explicit remote handoff [architecture/entries.md](architecture/entries.md)
- marked v17 renderer uses token objects, not positional args [architecture/entries.md](architecture/entries.md)
- pi-agent-core AuthStorage now uses factory methods [architecture/entries.md](architecture/entries.md)
- Prefer structural layout fixes over runtime workarounds [architecture/entries.md](architecture/entries.md)
- Provider contract pattern IS the plugin framework — packaging is the missing piece [architecture/entries.md](architecture/entries.md)
- Cross-provider imports should go through shared-types.ts, not sibling directories [architecture/entries.md](architecture/entries.md)
- Shared utilities between routers go in src/providers/router-utils.ts [architecture/entries.md](architecture/entries.md)
- EventBus should be optional and synchronous to avoid blocking the hot path [architecture/entries.md](architecture/entries.md)
- Extend the EventBus rather than replacing it for orchestration [architecture/entries.md](architecture/entries.md)
- Canonical path names should match their semantic role, not implementation [architecture/entries.md](architecture/entries.md)
- Eliminate redundant mount points rather than documenting differences [architecture/entries.md](architecture/entries.md)
- AX has two workspace directories — session sandbox vs enterprise user [architecture/entries.md](architecture/entries.md)
- Duplicate bootstrap files in both configDir and identity mount for agent visibility [architecture/entries.md](architecture/entries.md)
- OverlayFS for merging skill layers with fallback [architecture/entries.md](architecture/entries.md)

### providers

- Async toAnthropicContent requires Promise.all for message arrays [providers/llm.md](providers/llm.md)
- Anthropic thinking deltas use 'thinking' key, not 'text' [providers/llm.md](providers/llm.md)
- OpenRouter image generation uses /chat/completions, not /images/generations [providers/llm.md](providers/llm.md)
- Configure wizard must set config.model for non-claude-code agents [providers/llm.md](providers/llm.md)
- API key env var naming follows ${PROVIDER.toUpperCase()}_API_KEY convention [providers/llm.md](providers/llm.md)
- Popular OpenClaw skills use clawdbot alias, not openclaw [providers/skills.md](providers/skills.md)
- Many skills have no metadata block — static analysis is essential [providers/skills.md](providers/skills.md)
- OpenClaw's security failures validate AX's zero-trust architecture [providers/skills.md](providers/skills.md)
- Tool filtering must align with prompt module shouldInclude() [providers/skills.md](providers/skills.md)
- child.killed is true after ANY kill() call, not just after the process is dead [providers/sandbox.md](providers/sandbox.md)
- Never use tsx binary as a process wrapper — use node --import tsx/esm instead [providers/sandbox.md](providers/sandbox.md)
- Apple Container --publish-socket requires listener-ready signaling [providers/sandbox.md](providers/sandbox.md)
- Apple Container --tmpfs hides sockets from --publish-socket forwarding [providers/sandbox.md](providers/sandbox.md)
- Slack url_private URLs require Authorization header — plain fetch fails silently [providers/channel.md](providers/channel.md)
- Slack file upload: use SDK's files.uploadV2(), not manual 3-step flow [providers/channel.md](providers/channel.md)
- OS username != channel user ID — admins file seed doesn't help channels [providers/channel.md](providers/channel.md)
- Node.js Buffer -> fetch body: use standalone ArrayBuffer to avoid detached buffer errors [providers/channel.md](providers/channel.md)
- Node.js fetch body does not accept Buffer in strict TypeScript [providers/channel.md](providers/channel.md)
- pi-agent-core only supports text — image blocks must bypass it [providers/memory.md](providers/memory.md)
- Salience formula produces 0 at zero reinforcement — test ratios need nonzero counts [providers/memory.md](providers/memory.md)
- Scheduler must be started in BOTH server.ts AND host-process.ts [providers/scheduler.md](providers/scheduler.md)
- LLM IPC handler must use configModel for actual calls, not just logging [providers/scheduler.md](providers/scheduler.md)
- SQLiteJobStore belongs in types.ts alongside MemoryJobStore [providers/scheduler.md](providers/scheduler.md)
- Pre-existing provider-map path regex failures [providers/scheduler.md](providers/scheduler.md)
- Check dependency chain before implementing plan tasks — missing prereqs block you [providers/memory.md](providers/memory.md)

### host

- IPC defaultCtx.agentId is 'system', not the configured agent name [host/entries.md](host/entries.md)
- Plugin providers use a runtime Map, not the static _PROVIDER_MAP [host/entries.md](host/entries.md)
- Child process IPC for plugins: fork() + process.send(), not worker_threads [host/entries.md](host/entries.md)
- Orchestrator handle sessionId must match child agent event requestId [host/entries.md](host/entries.md)
- enableAutoState() must be called in production code [host/entries.md](host/entries.md)
- Session-to-handle mapping must be 1:N [host/entries.md](host/entries.md)
- resolveCallerHandle OR vs AND bug pattern [host/entries.md](host/entries.md)
- Orchestration handlers now wired into createIPCHandler [host/entries.md](host/entries.md)
- Async fire-and-forget needs a collect mechanism, not polling [host/entries.md](host/entries.md)
- Features in server.ts must also be ported to host-process.ts [host/entries.md](host/entries.md)

### agent

- pi-coding-agent does NOT re-export pi-agent-core types [agent/entries.md](agent/entries.md)
- claude-code.ts should use shared buildSystemPrompt() like other runners [agent/entries.md](agent/entries.md)
- claude-code runner discards non-text content blocks — must extract and forward via SDKUserMessage [agent/entries.md](agent/entries.md)
- Retry logic must check for valid output before retrying [agent/entries.md](agent/entries.md)
- Agent messages must flow through trusted host — never sandbox-to-sandbox [agent/entries.md](agent/entries.md)

### ipc

- IPC schemas use z.strictObject — extra fields cause silent validation failures [ipc/entries.md](ipc/entries.md)
- ipcAction() auto-registers schemas in IPC_SCHEMAS — just call it at module level [ipc/entries.md](ipc/entries.md)
- IPC schema enums must use exact values — check ipc-schemas.ts [ipc/entries.md](ipc/entries.md)
- IPC handler response shapes vary by handler — check the actual handler code [ipc/entries.md](ipc/entries.md)
- Adding IPC schemas without handlers causes ipc-server tests to fail [ipc/entries.md](ipc/entries.md)
- onDelegate callback signature changes require updating all test files + harness [ipc/entries.md](ipc/entries.md)
- Orchestration IPC actions need registration in both sync tests [ipc/entries.md](ipc/entries.md)
- z.record() in Zod v4 requires key and value schemas [ipc/entries.md](ipc/entries.md)
- Promise.race timeouts MUST be cleared in finally blocks [ipc/entries.md](ipc/entries.md)
- Always clean up Map entries in ALL code paths (success AND error) [ipc/entries.md](ipc/entries.md)

### config

- Renaming a Config field has massive blast radius — check YAML fixtures too [config/entries.md](config/entries.md)
- AgentConfig.model is NOT the same as Config.model — check the type before renaming [config/entries.md](config/entries.md)
- Pre-existing tsc errors are expected — project uses tsx runtime [config/entries.md](config/entries.md)
- New path helpers must handle colon-separated session IDs [config/entries.md](config/entries.md)

### security

- import.meta.resolve() is the secure way to resolve package names [security/entries.md](security/entries.md)
- Static allowlist (SC-SEC-002) can point to package names, not just relative paths [security/entries.md](security/entries.md)
- safePath() treats its arguments as individual path segments, not relative paths [security/entries.md](security/entries.md)

### filesystem

- existsSync follows symlinks — use lstatSync for symlink existence checks [filesystem/entries.md](filesystem/entries.md)
- Declare variables before try blocks if they're needed in finally [filesystem/entries.md](filesystem/entries.md)

### workflow

- npm 11.x requires complete lock file entries for ALL declared optional dependencies [workflow/entries.md](workflow/entries.md)
- Explicit permissions in GitHub Actions replaces ALL defaults — always include contents: read [workflow/entries.md](workflow/entries.md)
