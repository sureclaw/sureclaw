# Sureclaw Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Progress Tracker

### Phase 0: Paranoid Profile MVP
- [x] Task 0.1: GitHub Repo Content + Directory Structure
- [x] Task 0.2: Build Tooling + Dependencies
- [x] Task 0.3: Provider Type Definitions
- [ ] Task 0.4: Security Utilities (SC-SEC-002 + SC-SEC-004)
- [ ] Task 0.5: Config Parser
- [ ] Task 0.6: Leaf Providers
- [ ] Task 0.7: Provider Registry
- [ ] Task 0.8: Core Providers
- [ ] Task 0.9: IPC Schema Validation (SC-SEC-001)
- [ ] Task 0.10: SQLite Message Queue
- [ ] Task 0.11: IPC Proxy + Unix Socket Server
- [ ] Task 0.12: Message Router
- [ ] Task 0.13: Sandbox Providers
- [ ] Task 0.14: Container-Side Components
- [ ] Task 0.15: Scheduler Provider (Cron)
- [ ] Task 0.16: Host Process (Main Loop)
- [ ] Task 0.17: End-to-End Integration Test

### Phase 1: Standard Profile
- [ ] Task 1.1: Taint Budget Core (SC-SEC-003)
- [ ] Task 1.2: Taint Budget IPC + Router Integration
- [ ] Task 1.3: SQLite Providers (Memory + Audit)
- [ ] Task 1.4: Encrypted Credentials
- [ ] Task 1.5: Expanded Scanner Patterns
- [ ] Task 1.6: Proxied Web Fetch with DNS Pinning
- [ ] Task 1.7: OpenAI-Compatible LLM Provider
- [ ] Task 1.8: Cron Scheduler + ProactiveHint Bridge
- [ ] Task 1.9: Slack Channel
- [ ] Task 1.10: Completions Gateway
- [ ] Task 1.11: Git-Backed Skills
- [ ] Task 1.12: Linux Sandbox Providers
- [ ] Task 1.13: Phase 1 Integration Tests + Profile Config

### Phase 2: Power User
- [ ] Task 2.1: Multi-LLM Model Router
- [ ] Task 2.2: Messaging Channels (WhatsApp + Telegram + Discord)
- [ ] Task 2.3: Web Search API
- [ ] Task 2.4: Sandboxed Playwright Browser
- [ ] Task 2.5: memU Memory Integration
- [ ] Task 2.6: Promptfoo ML Scanner
- [ ] Task 2.7: OS Keychain Credentials
- [ ] Task 2.8: Docker + gVisor Sandbox
- [ ] Task 2.9: Multi-Agent Delegation
- [ ] Task 2.10: Power User Profile + Integration Tests

### Notes
- All packages updated to latest versions (zod 4.x, vitest 4.x, etc.)
- Node engine requirement: >=24.0.0
- Zod v4 uses `z.strictObject()` instead of `z.object().strict()` — adapt IPC schemas accordingly

---

**Goal:** Build Sureclaw, a security-first personal AI agent (~4,150 LOC) that runs in a kernel-level sandbox, supports multiple channels and LLM providers, and is small enough to audit in a day.

**Architecture:** Provider contract pattern — every subsystem is a TypeScript interface with a stub and one or more real implementations. Host process (trusted) communicates with agent containers (untrusted) via IPC over Unix sockets. Credentials never enter containers. All external content is taint-tagged. Everything is audited.

**Tech Stack:** TypeScript, Node.js, Zod (schema validation), better-sqlite3, yaml, @anthropic-ai/sdk, vitest, fast-check

**Reference Documents:**
- `docs/plans/sureclaw-prp.md` — Project requirements, design philosophy, architectural invariants
- `docs/plans/sureclaw-architecture-doc.md` — Provider contracts, file structure, data flow, sandbox configs
- `docs/plans/sureclaw-security-hardening-spec.md` — SC-SEC-001/002/003/004 specifications with full code

---

## File Naming Convention

Flat provider naming: `src/providers/llm-anthropic.ts` (not subdirectories). This is mandated by SC-SEC-002 — the provider-map static allowlist uses these exact paths.

---

## Security Profiles

Each phase implements the next profile level. Architectural invariants (no network in containers, credentials never in containers, all content taint-tagged, everything audited) hold at **all** levels.

| Dimension | Paranoid (Default) — Phase 0 | Standard — Phase 1 | Power User — Phase 2 |
|-----------|------------------------------|---------------------|----------------------|
| Browser | Disabled | Blocklist egress | Unrestricted egress |
| Web fetch | Allowlist (empty) | Blocklist | Unrestricted |
| OAuth scopes | None | Read-only | Read-write |
| Skill modification | Read-only | Proposal-review-commit | Relaxed auto-approve |
| Proactive behavior | Disabled | Cron + heartbeats | Full triggers + memory |
| Memory | File-based | SQLite + FTS | memU + proactive bridge |
| Browser sessions | N/A | Ephemeral | Named per-domain |

---

## Phase 0: Paranoid Profile MVP

**Goal:** End-to-end loop — type a message in CLI, agent runs in a seatbelt sandbox, get a response.

**Security:** SC-SEC-001 (IPC schema validation), SC-SEC-002 (provider allowlist), SC-SEC-004 (path traversal protection). SC-SEC-003 (taint budget) deferred to Phase 1.

**Providers:** anthropic LLM, file memory, basic scanner, CLI channel, env credentials, file audit, readonly skills, seatbelt + subprocess sandboxes, cron scheduler, none stubs for web/browser.

### Task 0.1: GitHub Repo Content + Directory Structure

**Files:**
- Copy: `sureclaw-logo.svg` → `docs/sureclaw-logo.svg`
- Create: `README.md` — logo at top (`docs/sureclaw-logo.svg`), tagline: "Like OpenClaw but with trust issues 🦀🫣", project description, architecture overview (provider contract pattern, trust zones, sandbox tiers), security model summary (architectural invariants), quick start, contributing guidelines
- Create: `CLAUDE.md` — build/test/lint commands (`npm run build`, `npm test`, `npm start`), architecture overview, key patterns (flat provider naming, safePath for all file ops, IPC schema validation), reference to spec docs in `docs/plans/`
- Create: `LICENSE` (MIT)
- Create: `.gitignore` — `node_modules/`, `dist/`, `data/` (runtime data), `.env`, `*.sb.compiled`
- Create: `.editorconfig` — 2-space indent, UTF-8, LF line endings
- Create: `sureclaw.yaml` (default Phase 0 config)
- Create: `policies/agent.sb` (macOS seatbelt profile from architecture doc Section 9.2)
- Create: `agents/assistant/AGENT.md` (agent personality)
- Create: `agents/assistant/capabilities.yaml` (allowed tools/scopes)
- Create: `skills/default.md` (base safety rules)

**Directory structure (create with placeholder `.gitkeep` where empty):**
```
src/
src/providers/
src/container/
src/utils/
tests/
tests/providers/
tests/container/
tests/utils/
tests/integration/
policies/
agents/assistant/
skills/
data/          (in .gitignore)
```

**Config (`sureclaw.yaml`):**
```yaml
profile: paranoid
providers:
  llm: anthropic
  memory: file
  scanner: basic
  channels: [cli]
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: seatbelt
  scheduler: cron
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "America/New_York" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
```

**Commit:** "chore: initial repo structure, README, CLAUDE.md, configs, and policies"

---

### Task 0.2: Build Tooling + Dependencies

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.github/workflows/ci.yml` (lint + test)

**Dependencies:** `zod`, `better-sqlite3`, `yaml`, `@anthropic-ai/sdk`
**Dev deps:** `vitest`, `fast-check`, `typescript`, `@types/better-sqlite3`, `@types/node`, `tsx`

**tsconfig.json:** Target ES2022+, strict mode, `outDir: "dist"`, `moduleResolution: "node16"`.

**Scripts:** `npm run build` (tsc), `npm test` (vitest), `npm start` (tsx src/host.ts), `npm run test:fuzz` (vitest --run tests/ipc-fuzz.test.ts)

Run: `npm install`

**Commit:** "chore: build tooling, dependencies, and CI"

---

### Task 0.3: Provider Type Definitions

**Files:**
- Create: `src/providers/types.ts` (~200 LOC)

All 12 provider interfaces from architecture doc Section 2 + all shared types from Section 11. Exact interfaces:

`LLMProvider`, `MemoryProvider`, `ScannerProvider`, `ChannelProvider`, `WebProvider`, `BrowserProvider`, `CredentialProvider`, `SkillStoreProvider`, `AuditProvider`, `SandboxProvider`, `SchedulerProvider`

Plus shared types: `ChatRequest`, `ChatChunk`, `MemoryEntry`, `MemoryQuery`, `ScanTarget`, `ScanResult`, `TaintTag`, `SandboxConfig`, `SandboxProcess`, `InboundMessage`, `OutboundMessage`, `AuditEntry`, `CronJobDef`, `ProactiveHint`, `Config`, `ProviderRegistry`

Export `Config` as an interface here. `config.ts` will implement the Zod schema matching it.

**Test:** `tsc --noEmit` passes.

**Commit:** "feat: define all provider interfaces and shared types"

---

### Task 0.4: Security Utilities (SC-SEC-002 + SC-SEC-004)

**Files:**
- Create: `src/provider-map.ts` (~60 LOC) — from security spec Section 1
- Create: `src/utils/safe-path.ts` (~45 LOC) — from security spec Section 2
- Create: `tests/provider-map.test.ts` (~50 LOC)
- Create: `tests/utils/safe-path.test.ts` (~80 LOC)

**provider-map.ts:** Static `PROVIDER_MAP` + `resolveProviderPath(kind, name)`. Must include `sandbox` kind (not `container`) with entries for `seatbelt`, `subprocess`, `nsjail`, `docker`. All paths use flat naming: `./providers/llm-anthropic`.

**safe-path.ts:** `safePath(baseDir, ...segments)` and `assertWithinBase(baseDir, targetPath)`. Sanitizes path separators, null bytes, `..` sequences, colons. Containment check against resolved base.

**Tests:** Path traversal vectors, empty segments, long segments, prototype pollution-style paths. Provider-map: valid lookups, unknown kinds/names, traversal payloads.

Run: `npx vitest run tests/provider-map.test.ts tests/utils/safe-path.test.ts`

**Commit:** "feat: SC-SEC-002 provider allowlist + SC-SEC-004 path traversal protection"

---

### Task 0.5: Config Parser

**Files:**
- Create: `src/config.ts` (~60 LOC)
- Create: `tests/config.test.ts` (~40 LOC)

Parse `sureclaw.yaml` with `yaml` package, validate with Zod schema. Schema enforces: provider names are strings, `channels` is non-empty string array, `profile` is `'paranoid' | 'standard' | 'power_user'`, numeric bounds on sandbox/scheduler settings.

Export: `loadConfig(path?: string): Config`

**Commit:** "feat: YAML config parser with Zod validation"

---

### Task 0.6: Leaf Providers (no inter-provider dependencies)

**Files:**
- Create: `src/providers/creds-env.ts` (~30 LOC)
- Create: `src/providers/audit-file.ts` (~35 LOC)
- Create: `src/providers/web-none.ts` (~10 LOC)
- Create: `src/providers/browser-none.ts` (~10 LOC)
- Create: `tests/providers/creds-env.test.ts`
- Create: `tests/providers/audit-file.test.ts`

**creds-env.ts:** `get(service)` returns `process.env[service.toUpperCase()]`. `set`/`delete` throw (read-only). `list()` returns filtered env keys.

**audit-file.ts:** JSONL append to `data/audit/audit.jsonl`. `log(entry)` serializes + appends. `query(filter)` reads line-by-line, filters by action/date/limit.

**web-none.ts / browser-none.ts:** Every method throws `Error('Provider disabled (provider: none)')`.

**Commit:** "feat: credential, audit, and stub providers"

---

### Task 0.7: Provider Registry

**Files:**
- Create: `src/registry.ts` (~80 LOC)
- Create: `tests/registry.test.ts` (~40 LOC)

`loadProviders(config: Config): Promise<ProviderRegistry>` using `resolveProviderPath()` from provider-map. Verify `typeof mod.create === 'function'` before calling.

**Commit:** "feat: provider registry with static allowlist loading"

---

### Task 0.8: Core Providers

**Files:**
- Create: `src/providers/scanner-basic.ts` (~70 LOC)
- Create: `src/providers/memory-file.ts` (~100 LOC) — uses `safePath`
- Create: `src/providers/channel-cli.ts` (~45 LOC)
- Create: `src/providers/skills-readonly.ts` (~35 LOC) — uses `safePath`
- Create: `src/providers/llm-anthropic.ts` (~80 LOC)
- Create: `tests/providers/scanner-basic.test.ts`
- Create: `tests/providers/memory-file.test.ts`
- Create: `tests/providers/skills-readonly.test.ts`

**scanner-basic.ts:** `canaryToken()` generates random hex. `checkCanary()` checks for token in output. `scanInput()` regex-checks for ~10-15 prompt injection patterns. `scanOutput()` checks PII patterns + canary leakage.

**memory-file.ts:** Storage at `data/memory/{scope}/{id}.json`. ALL path construction uses `safePath()`. Memory IDs validated as UUIDs before path use. `query()` is grep-based substring search.

**channel-cli.ts:** readline interface on stdin/stdout. Prompt: `you> `. Agent responses prefixed `agent> `.

**skills-readonly.ts:** `read(name)` uses `safePath(skillsDir, name)`. `list()` reads skills/ directory. Mutation methods throw.

**llm-anthropic.ts:** `@anthropic-ai/sdk` streaming. `chat()` is an `async *` generator yielding `ChatChunk`. Maps Anthropic content blocks to ChatChunk types (text, tool_use, done).

**Commit:** "feat: scanner, memory, CLI channel, skills, and Anthropic LLM providers"

---

### Task 0.9: IPC Schema Validation (SC-SEC-001)

**Files:**
- Create: `src/ipc-schemas.ts` (~200 LOC) — from security spec Section 3
- Create: `tests/ipc-schemas.test.ts` (~120 LOC)
- Create: `tests/ipc-fuzz.test.ts` (~60 LOC)

Zod schemas for every IPC action with `.strict()` mode. Shared validators: `safeString` (no null bytes, length limits), `scopeName` (alphanumeric start, safe chars), `uuid` format.

Phase 0 active schemas: `llm_call`, `memory_*` (5 actions), `skill_read`, `skill_list`, `audit_query`.
Stub schemas (reject with "not available"): `web_*`, `browser_*`, `skill_propose`, `oauth_call`.

`IPCEnvelopeSchema` validates action field. `IPC_SCHEMAS` registry maps action names to schemas.

Fuzz tests: 10,000+ `fast-check` iterations. Random objects, random strings through JSON.parse + validate, deep nesting. Verify no uncaught exceptions.

Run: `npx vitest run tests/ipc-schemas.test.ts tests/ipc-fuzz.test.ts`

**Commit:** "feat: SC-SEC-001 IPC schema validation with Zod + fuzz tests"

---

### Task 0.10: SQLite Message Queue

**Files:**
- Create: `src/db.ts` (~80 LOC)
- Create: `tests/db.test.ts` (~50 LOC)

Schema: `messages(id, session_id, channel, sender, content, status, created_at, processed_at)`. Status: pending -> processing -> done | error.

API: `enqueue()`, `dequeue()`, `complete()`, `fail()`, `pending()`.

Use better-sqlite3 synchronous API. Test with `:memory:` database.

**Commit:** "feat: SQLite message queue"

---

### Task 0.11: IPC Proxy + Unix Socket Server

**Files:**
- Create: `src/ipc.ts` (~200 LOC)
- Create: `tests/ipc.test.ts` (~100 LOC)

`createIPCHandler(providers: ProviderRegistry)` returns `handleIPC(raw: string, ctx: IPCContext): Promise<string>`.

Four-step dispatch: JSON.parse -> envelope validate -> action-specific validate -> dispatch to handler. Every step audit-logged on failure.

Unix socket server using `net.createServer()`. Message framing: 4-byte big-endian length prefix + JSON payload.

Handler implementations for each Phase 0 IPC action (llm_call, memory_*, skill_read, skill_list, audit_query).

**Note:** SC-SEC-003 (taint budget check) NOT integrated in Phase 0.

**Commit:** "feat: IPC proxy with validated dispatch + Unix socket server"

---

### Task 0.12: Message Router

**Files:**
- Create: `src/router.ts` (~150 LOC)
- Create: `tests/router.test.ts` (~80 LOC)

`createRouter(providers, db)` returns router with:
- `processInbound(msg)` — assign session, inject canary token, taint-tag external content, scan input (BLOCK/FLAG/PASS), enqueue
- `processOutbound(response, sessionId, canaryToken)` — scan output, check canary, return processed response

Taint tagging wraps external content in: `<external_content trust="external" source="...">`

**Commit:** "feat: taint-aware message router with canary injection"

---

### Task 0.13: Sandbox Providers

**Files:**
- Create: `src/providers/sandbox-seatbelt.ts` (~80 LOC)
- Create: `src/providers/sandbox-subprocess.ts` (~50 LOC)
- Create: `tests/providers/sandbox-subprocess.test.ts`

**seatbelt:** `spawn()` runs `sandbox-exec -f policies/agent.sb node container/agent-runner.js` as child process. `isAvailable()` checks `which sandbox-exec`. Workspace and IPC socket paths passed as CLI args (NOT env vars).

**subprocess:** Dev-only fallback, no isolation. `isAvailable()` always true. Logs warning on startup. Passes config via env vars.

**Commit:** "feat: seatbelt (macOS) and subprocess (dev) sandbox providers"

---

### Task 0.14: Container-Side Components

**Files:**
- Create: `src/container/ipc-client.ts` (~100 LOC)
- Create: `src/container/agent-runner.ts` (~250 LOC)
- Create: `tests/container/ipc-client.test.ts`

**ipc-client.ts:** Connects to host Unix socket. Length-prefixed JSON framing. `call(request)` sends and awaits response. 30s timeout. Reconnection on errors.

**agent-runner.ts:** Main agent loop:
1. Read IPC socket path + workspace from CLI args
2. Connect via IPCClient
3. Read /workspace/CONTEXT.md for system prompt
4. Read /skills/*.md for skill definitions
5. Receive message via stdin
6. Build prompt (system + context + skills + taint-tagged message)
7. Call LLM via IPC (`llm_call`)
8. If tool_use → dispatch tool calls via IPC → feed results back → loop
9. Final text response → stdout
10. Disconnect and exit

**Commit:** "feat: container-side IPC client and agent runner"

---

### Task 0.15: Scheduler Provider (Cron)

**Files:**
- Create: `src/providers/scheduler-cron.ts` (~120 LOC)
- Create: `tests/providers/scheduler-cron.test.ts` (~60 LOC)

Basic cron + heartbeat. `start()` begins interval-based job checking (every 60s). `addCron()`, `removeCron()`, `listJobs()`. Heartbeat fires at configurable interval. Active hours enforcement. Budget caps per invocation.

Fired jobs create `InboundMessage` with `channel: 'scheduler'` and route through the standard pipeline (architectural invariant: proactive actions use same pipeline as user actions).

**Commit:** "feat: cron scheduler with heartbeat and active hours"

---

### Task 0.16: Host Process (Main Loop)

**Files:**
- Create: `src/host.ts` (~200 LOC)

Wires everything together:
1. Parse CLI args, load config
2. Load providers via registry
3. Initialize DB, router, IPC handler
4. Start IPC Unix socket server
5. Connect channels, register message handlers
6. Main loop: dequeue -> create workspace -> spawn sandbox -> pipe message -> read response -> processOutbound -> channel.send -> cleanup
7. Start scheduler
8. Graceful shutdown on SIGINT/SIGTERM

**Commit:** "feat: host process main loop"

---

### Task 0.17: End-to-End Integration Test

**Files:**
- Create: `tests/integration/e2e.test.ts` (~80 LOC)
- Modify: `CLAUDE.md` — update with final build/test commands and architecture notes from implementation

**E2E test:** Uses subprocess sandbox (no seatbelt needed for CI). Mock Anthropic API with canned response. Tests:
1. Simple greeting flow
2. Memory write/read via agent tool use
3. Scanner blocks injection attempt
4. Canary not leaked in response
5. Audit trail written to JSONL

**Commit:** "feat: e2e integration test"

---

## Phase 0 Summary

| Task | Key Files | Est. LOC | Cumulative |
|------|-----------|----------|------------|
| 0.1 GitHub Content + Dirs | README, CLAUDE.md, LICENSE, .gitignore, configs, policies, agents, skills | ~60 | 60 |
| 0.2 Build Tooling | package.json, tsconfig, vitest, CI | ~40 | 100 |
| 0.3 Types | src/providers/types.ts | ~200 | 300 |
| 0.4 Security Utils | provider-map.ts, safe-path.ts | ~105 | 405 |
| 0.5 Config | src/config.ts | ~60 | 465 |
| 0.6 Leaf Providers | creds-env, audit-file, stubs | ~85 | 550 |
| 0.7 Registry | src/registry.ts | ~80 | 630 |
| 0.8 Core Providers | scanner, memory, cli, skills, llm | ~330 | 960 |
| 0.9 IPC Schemas | src/ipc-schemas.ts | ~200 | 1,160 |
| 0.10 Message Queue | src/db.ts | ~80 | 1,240 |
| 0.11 IPC Proxy | src/ipc.ts | ~200 | 1,440 |
| 0.12 Router | src/router.ts | ~150 | 1,590 |
| 0.13 Sandboxes | seatbelt, subprocess | ~130 | 1,720 |
| 0.14 Container | ipc-client, agent-runner | ~350 | 2,070 |
| 0.15 Scheduler | scheduler-cron.ts | ~120 | 2,190 |
| 0.16 Host | src/host.ts | ~200 | 2,390 |
| 0.17 E2E Test | tests/integration/e2e.test.ts | ~80 | 2,470 |
| **Tests** | All test files | **~700** | |

**Phase 0 Total: ~2,470 source + ~700 tests = ~3,170 LOC**

---

## Phase 1: Standard Profile

**Goal:** Add taint budget enforcement, real messaging (Slack), web access, completions API, SQLite storage, expanded security scanning, git-backed skills, and Linux sandbox support.

**Security:** SC-SEC-003 (taint budget enforcement).

### Task 1.1: Taint Budget Core (SC-SEC-003)

**Files:**
- Create: `src/taint-budget.ts` (~100 LOC) — from security spec Section 4
- Create: `tests/taint-budget.test.ts` (~120 LOC)

`TaintBudget` class tracks per-session taint ratio. `recordContent()`, `checkAction()`, `addUserOverride()`, `endSession()`. Profile thresholds: paranoid=0.10, standard=0.30, power_user=0.60. `DEFAULT_SENSITIVE_ACTIONS`: oauth_call, skill_propose, browser_navigate, scheduler_add_cron.

**Commit:** "feat: SC-SEC-003 taint budget tracking"

---

### Task 1.2: Taint Budget IPC + Router Integration

**Files:**
- Modify: `src/ipc.ts` — add taint check between validation and dispatch
- Modify: `src/router.ts` — add `taintBudget.recordContent()` on inbound
- Modify: `src/host.ts` — wire TaintBudget with profile threshold
- Modify: `sureclaw.yaml` — add `securityProfile` option

User confirmation flow: agent receives `taintBlocked: true` -> asks user -> router calls `addUserOverride()` -> agent retries.

**Commit:** "feat: wire taint budget into IPC dispatch and router"

---

### Task 1.3: SQLite Providers (Memory + Audit)

**Files:**
- Create: `src/providers/memory-sqlite.ts` (~150 LOC)
- Create: `src/providers/audit-sqlite.ts` (~80 LOC)
- Create: `tests/providers/memory-sqlite.test.ts`
- Create: `tests/providers/audit-sqlite.test.ts`

**memory-sqlite:** FTS5 full-text search. Schema: entries table + entries_fts virtual table. `query()` uses FTS5 MATCH with BM25 ranking. `onProactiveHint()` stub for scheduler integration.

**audit-sqlite:** Queryable audit log. Indexes on (session_id, timestamp) and (action, timestamp). Append-only (no UPDATE/DELETE).

**Parallelizable with:** Tasks 1.4-1.7 (all depend only on 1.2)

**Commit:** "feat: SQLite memory with FTS5 + queryable audit"

---

### Task 1.4: Encrypted Credentials

**Files:**
- Create: `src/providers/creds-encrypted.ts` (~80 LOC)
- Create: `tests/providers/creds-encrypted.test.ts`

AES-256-GCM encrypted JSON file. Key derived from passphrase via PBKDF2. File format: salt + IV + auth tag + ciphertext. Cache derived key in memory for session.

**Commit:** "feat: AES-256 encrypted credential storage"

---

### Task 1.5: Expanded Scanner Patterns

**Files:**
- Create: `src/providers/scanner-patterns.ts` (~150 LOC)
- Create: `tests/providers/scanner-patterns.test.ts`

Comprehensive pattern library: prompt injection, exfiltration, PII, credentials, shell injection. Each pattern has severity (INFO/FLAG/BLOCK). Patterns loadable from YAML config.

**Commit:** "feat: expanded scanner pattern library"

---

### Task 1.6: Proxied Web Fetch with DNS Pinning

**Files:**
- Create: `src/providers/web-fetch.ts` (~100 LOC)
- Create: `tests/providers/web-fetch.test.ts`

DNS resolution host-side before connecting (SSRF protection). Blocklist/allowlist modes from config. Response bodies taint-tagged. Timeout + size limits. DNS pinning prevents TOCTOU rebinding. Integrates with taint budget.

**Commit:** "feat: proxied web fetch with DNS pinning and taint tagging"

---

### Task 1.7: OpenAI-Compatible LLM Provider

**Files:**
- Create: `src/providers/llm-openai.ts` (~80 LOC)
- Create: `tests/providers/llm-openai.test.ts`

Configurable base URL (local models, Azure, etc.). SSE streaming. Tool use (function calling). `models()` calls /v1/models. Credential injection via credential provider.

**Commit:** "feat: OpenAI-compatible LLM provider"

---

### Task 1.8: Cron Scheduler + ProactiveHint Bridge

**Files:**
- Modify: `src/providers/scheduler-cron.ts` — add persistence, full cron parser
- Create: `src/providers/scheduler-full.ts` (~250 LOC)
- Create: `tests/providers/scheduler-full.test.ts`

Wire `MemoryProvider.onProactiveHint()` to scheduler. Confidence thresholds, cooldown dedup, active hours, token budgets. All hints flow through standard pipeline. Log all fired/suppressed hints.

**Depends on:** Tasks 1.3 (SQLite memory for onProactiveHint)

**Commit:** "feat: full scheduler with ProactiveHint bridge"

---

### Task 1.9: Slack Channel

**Files:**
- Create: `src/providers/channel-slack.ts` (~100 LOC)
- Create: `tests/providers/channel-slack.test.ts`

Slack Bolt SDK with Socket Mode (no inbound HTTP — aligns with "no listening ports"). Handle DMs and mentions. Threading support. Session mapping from Slack user/channel IDs.

**Commit:** "feat: Slack channel provider"

---

### Task 1.10: Completions Gateway

**Files:**
- Create: `src/completions.ts` (~200 LOC)
- Create: `tests/completions.test.ts`

OpenAI-compatible `/v1/chat/completions`. Default: Unix socket. Optional: localhost TCP with mandatory bearer token (opt-in). Streaming SSE + non-streaming. Requests flow through router -> sandbox pipeline.

**Commit:** "feat: OpenAI-compatible completions gateway"

---

### Task 1.11: Git-Backed Skills

**Files:**
- Create: `src/providers/skills-git.ts` (~500 LOC)
- Create: `tests/providers/skills-git.test.ts`

Proposal-review-commit with isomorphic-git. `propose()` writes to staging, validates (scanner + capability check). Verdicts: AUTO_APPROVE / NEEDS_REVIEW / REJECT. Hard-reject patterns (shell, base64, eval) not overridable. `approve()` commits. `revert()` reverts. Cumulative drift detection. Uses `safePath()`.

**Depends on:** Task 1.5 (expanded scanner for validation)

**Commit:** "feat: git-backed proposal-review-commit skills"

---

### Task 1.12: Linux Sandbox Providers

**Files:**
- Create: `src/providers/sandbox-nsjail.ts` (~100 LOC)
- Create: `src/providers/sandbox-docker.ts` (~150 LOC)
- Create: `policies/agent.kafel` (nsjail seccomp-bpf policy)
- Create: `container/Dockerfile` (~30 LOC)

**nsjail:** Linux namespaces + seccomp-bpf. clone_newnet=true (NO NETWORK). Bind-mount workspace(rw), skills(ro), IPC socket.

**docker:** Docker + gVisor runtime. No network. Resource limits.

Escalation logic in host.ts: start in nsjail, escalate to Docker for heavy workloads. Platform detection (nsjail=Linux, seatbelt=macOS, Docker=cross-platform).

**Commit:** "feat: nsjail and Docker sandbox providers"

---

### Task 1.13: Phase 1 Integration Tests + Profile Config

**Files:**
- Create: `tests/integration/phase1.test.ts`
- Modify: `src/host.ts` — profile-based capability switching
- Modify: `CLAUDE.md` — update with Phase 1 commands
- Modify: `provider-map.ts` — register all new providers

Wire `standard` profile: web fetch (blocklist mode), cron scheduler, proposal-review-commit skills, encrypted creds. Integration tests: taint budget enforcement end-to-end, scheduler pipeline, Slack message flow.

**Commit:** "feat: standard profile configuration + Phase 1 integration tests"

---

### Phase 1 Summary

| Task | Est. LOC | Parallel Group |
|------|----------|----------------|
| 1.1 Taint Budget Core | 220 | A (sequential) |
| 1.2 Taint Budget Integration | 140 | B (sequential) |
| 1.3 SQLite Memory + Audit | 230 | C (parallel) |
| 1.4 Encrypted Credentials | 80 | C |
| 1.5 Expanded Scanner | 150 | C |
| 1.6 Web Fetch + DNS Pinning | 100 | C |
| 1.7 OpenAI LLM | 80 | C |
| 1.8 Full Scheduler | 250 | D (needs 1.3) |
| 1.9 Slack Channel | 100 | C |
| 1.10 Completions Gateway | 200 | D (needs 1.7) |
| 1.11 Git-Backed Skills | 500 | D (needs 1.5) |
| 1.12 Linux Sandboxes | 280 | C |
| 1.13 Integration + Profile | 300 | E (capstone) |
| **Total** | **~2,630** | |

---

## Phase 2: Power User

**Goal:** Full provider set — multi-channel (WhatsApp, Telegram, Discord), browser automation, memU knowledge graph, ML-based scanning, OS keychain, multi-LLM routing, Docker + gVisor sandbox, multi-agent delegation.

### Task 2.1: Multi-LLM Model Router

**Files:**
- Create: `src/providers/llm-multi.ts` (~120 LOC)

Routes requests across Anthropic + OpenAI providers. Model-to-provider mapping in config. Fallback chains. Cost/latency tracking. `models()` aggregates from all sub-providers.

---

### Task 2.2: Messaging Channels (WhatsApp + Telegram + Discord)

**Files:**
- Create: `src/providers/channel-whatsapp.ts` (~80 LOC) — Baileys, QR pairing
- Create: `src/providers/channel-telegram.ts` (~80 LOC) — long-polling (no webhook)
- Create: `src/providers/channel-discord.ts` (~80 LOC) — Gateway WebSocket

All three: no inbound HTTP ports. Session mapping. Group handling. Rate limiting.

---

### Task 2.3: Web Search API

**Files:**
- Create: `src/providers/web-search.ts` (~50 LOC)

Search API integration (Brave/SerpAPI/Google Custom Search). Returns taint-tagged `SearchResult[]`. Extends web-fetch.

---

### Task 2.4: Sandboxed Playwright Browser

**Files:**
- Create: `src/providers/browser-container.ts` (~250 LOC)
- Create: `container/browser/Dockerfile`

Playwright in Docker + gVisor. Filtered egress (domain allowlist). Structured commands only (no raw JS). All content taint-tagged. Session management (tabs, cleanup).

---

### Task 2.5: memU Memory Integration

**Files:**
- Create: `src/providers/memory-memu.ts` (~200 LOC)

Knowledge graph storage via memU. Semantic search (embedding-based). `onProactiveHint()` wires to scheduler for pending_task, temporal_pattern, follow_up, anomaly hints. Runs in semi-trusted container (localhost PostgreSQL, LLM via host proxy).

---

### Task 2.6: Promptfoo ML Scanner

**Files:**
- Create: `src/providers/scanner-promptfoo.ts` (~200 LOC)

ML-based prompt injection detection alongside regex patterns. Local ML model (no external API). Configurable confidence threshold. Fallback to regex-only if ML unavailable.

---

### Task 2.7: OS Keychain Credentials

**Files:**
- Create: `src/providers/creds-keychain.ts` (~100 LOC)

macOS Keychain, Linux libsecret, Windows Credential Locker via `keytar`. Fallback to encrypted file.

---

### Task 2.8: Docker + gVisor Sandbox

**Files:**
- Create: `src/providers/sandbox-docker.ts` (~150 LOC)

Docker container with gVisor runtime for strong isolation. Escalation target for heavy workloads (package installation, complex file ops). OCI-compatible, works on Linux and macOS (Docker Desktop).

---

### Task 2.9: Multi-Agent Delegation

**Files:**
- Modify: `src/host.ts`, `src/ipc.ts`, `src/ipc-schemas.ts` (~200 LOC total)

Primary agent delegates subtasks to secondary agents. Each in its own sandbox with own taint budget. New IPC action: `agent_delegate`. Configurable max concurrent agents and delegation depth.

---

### Task 2.10: Power User Profile + Integration Tests

**Files:**
- Create: `tests/integration/phase2.test.ts`
- Modify: `CLAUDE.md`, `README.md`
- Modify: `provider-map.ts` — register all Phase 2 providers

Power user profile enables: unrestricted web, read-write OAuth, relaxed skill auto-approve, full triggers, browser, multi-agent delegation. Taint budget threshold at 0.60.

Verify architectural invariants still hold: no network in containers, credentials never in containers, everything taint-tagged and audited.

---

### Phase 2 Summary

| Task | Est. LOC |
|------|----------|
| 2.1 Multi-LLM Router | 120 |
| 2.2 WhatsApp + Telegram + Discord | 240 |
| 2.3 Web Search | 50 |
| 2.4 Sandboxed Playwright | 250 |
| 2.5 memU Memory | 200 |
| 2.6 Promptfoo Scanner | 200 |
| 2.7 OS Keychain | 100 |
| 2.8 Docker + gVisor | 150 |
| 2.9 Multi-Agent Delegation | 200 |
| 2.10 Integration + Profile | 350 |
| **Total** | **~1,810** |

---

## Grand Total Across All Phases

| Phase | Source LOC | Test LOC | Combined |
|-------|-----------|----------|----------|
| Phase 0 (Paranoid MVP) | ~2,470 | ~700 | ~3,170 |
| Phase 1 (Standard) | ~2,630 | ~1,000 | ~3,630 |
| Phase 2 (Power User) | ~1,810 | ~770 | ~2,580 |
| **Total** | **~6,910** | **~2,470** | **~9,380** |

---

## Verification

After each phase, verify:

1. **Unit tests pass:** `npm test`
2. **Fuzz tests pass:** `npm run test:fuzz`
3. **Type check:** `npx tsc --noEmit`
4. **E2E test:** `npx vitest run tests/integration/`
5. **No dynamic imports:** `grep -rn 'import(\`' src/` returns nothing
6. **No unsafe path joins:** `grep -rn 'join(.*Dir' src/providers/` returns nothing (should only use safePath)
7. **Architectural invariants:** Containers have no network, no env vars with credentials, all IPC calls validated, all actions audited
