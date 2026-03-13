---
name: testing
description: Use when writing or debugging tests — test structure, fixtures, mocking patterns, common assertions, and gotchas for the vitest/bun test suite in tests/
---

## Overview

AX uses vitest for Node.js and bun's native test runner as alternatives. Tests mirror the `src/` directory structure exactly. The project's bug fix policy requires that every bug fix includes a regression test. Test isolation is critical -- especially for SQLite databases and process-level state.

## Commands

```bash
npm test              # Run all tests (vitest on Node.js)
bun test              # Run all tests (Bun native runner)
npm run test:fuzz     # Run fuzz tests (vitest --run tests/ipc-fuzz.test.ts)
```

## Directory Structure

Tests mirror `src/` exactly:

```
tests/
  agent/
    prompt/
      modules/         # Per-module tests (identity, security, delegation, etc.)
      builder.test.ts  # PromptBuilder integration
      budget.test.ts   # Token budget allocation
      base-module.test.ts
      integration.test.ts
      types.test.ts
      enterprise-runtime.test.ts
    runners/           # Runner-specific tests
      claude-code.test.ts
      pi-session.test.ts
      dispatch.test.ts       # Runner dispatch logic
    runner.test.ts
    runner-history.test.ts   # History compaction
    runner-images.test.ts    # Image block handling
    ipc-client.test.ts
    ipc-client-reconnect.test.ts  # Reconnection logic
    ipc-transport.test.ts
    ipc-tools.test.ts
    mcp-server.test.ts
    tool-catalog.test.ts
    tool-catalog-sync.test.ts
    identity-loader.test.ts  # Identity loading from stdin payload
    session.test.ts
    tcp-bridge.test.ts       # TCP-to-Unix socket bridge
    heartbeat-state.test.ts
    stream-utils.test.ts
    nats-bridge.test.ts      # NATS bridge for K8s
  host/
    server.test.ts
    server-admin.test.ts         # Admin API endpoints
    server-channels.test.ts
    server-completions-db.test.ts # DB-backed completions
    server-completions-images.test.ts
    server-files.test.ts         # File upload/download
    server-history.test.ts       # History API
    server-multimodal.test.ts    # Image pipeline
    server-userid.test.ts
    server-webhooks.test.ts
    streaming-completions.test.ts
    router.test.ts
    ipc-server.test.ts
    ipc-delegation.test.ts
    taint-budget.test.ts
    proxy.test.ts
    proxy-oauth-refresh.test.ts
    oauth.test.ts
    registry.test.ts
    agent-registry.test.ts      # Database-backed agent registry
    admin-gate.test.ts
    provider-map.test.ts
    delivery.test.ts
    memory-recall.test.ts
    history-summarizer.test.ts
    file-store.test.ts
    channel-reconnect.test.ts
    fault-tolerance.test.ts      # Circuit breaker / retry
    webhook-transform.test.ts
    event-bus.test.ts            # Streaming event bus
    event-bus-sse.test.ts        # SSE event streaming
    event-console.test.ts        # Event console UI
    plugin-host.test.ts          # Plugin lifecycle
    plugin-lock.test.ts          # Plugin integrity
    plugin-manifest.test.ts      # Plugin capability schema
    plugin-provider-map.test.ts  # Plugin provider registration
    delegation-hardening.test.ts # Subagent delegation edge cases
    nats-session-protocol.test.ts  # NATS session protocol
    nats-sandbox-dispatch.test.ts  # NATS sandbox dispatch
    nats-llm-proxy.test.ts        # NATS LLM proxy
    ipc-handlers/
      image.test.ts              # Image generation handler
      llm-events.test.ts         # LLM streaming events
      orchestration.test.ts      # Agent orchestration
      workspace.test.ts          # Workspace management
      workspace-file.test.ts     # Workspace file ops
      memory.test.ts             # Memory handlers
      governance.test.ts         # Governance proposals
      sandbox-tools.test.ts      # Sandbox tool routing
      identity.test.ts           # Identity IPC handlers
      skills-install.test.ts     # Skills installation
  providers/
    llm/               # Per-provider tests (anthropic, openai, router, traced)
    image/             # Image provider tests (router, openrouter)
    memory/
      cortex/          # Cortex memory provider tests
        provider.test.ts
        extractor.test.ts
        types.test.ts
        prompts.test.ts
        llm-helpers.test.ts
        content-hash.test.ts
        salience.test.ts
        embedding-store.test.ts
        semantic-dedup.test.ts
        integration.test.ts
        summary-store.test.ts
        items-store.test.ts
    scanner/
      guardian.test.ts  # Two-layer scanner (regex + LLM)
      patterns.test.ts  # Pattern matching
    channel/
    web/
    browser/
    credentials/
    skills/
      git.test.ts       # Git-based skills provider
      readonly.test.ts  # Read-only skills provider
    screener/          # Static screener tests
    audit/
    sandbox/
      k8s.test.ts      # Kubernetes sandbox provider
    scheduler/
    storage/
      database.test.ts     # Database-backed StorageProvider
      migrate-to-db.test.ts # Filesystem-to-DocumentStore migration
  sandbox-worker/        # NATS-based sandbox worker tests
    tool-handlers.test.ts
    worker.test.ts
    workspace.test.ts
  provider-sdk/        # Provider SDK harness and interface tests
    harness.test.ts
    interfaces.test.ts
  clawhub/             # Registry client tests
    registry-client.test.ts
  cli/
    index.test.ts
    send.test.ts
    bootstrap.test.ts
    reload.test.ts
    k8s-init.test.ts     # K8s deployment wizard
  onboarding/
    configure.test.ts
    wizard.test.ts
  utils/
    safe-path.test.ts
    disabled-provider.test.ts
    circuit-breaker.test.ts
    database.test.ts
    migrator.test.ts
    retry.test.ts
    embedding-client.test.ts
    bin-exists.test.ts
    install-validator.test.ts
    manifest-generator.test.ts
    skill-format-parser.test.ts
  integration/         # End-to-end and smoke tests
    smoke.test.ts
    phase1.test.ts
    phase2.test.ts
    cross-component.test.ts
    e2e.test.ts
    history-smoke.test.ts
  e2e/
    scenarios/
      delegation-stress.test.ts    # Delegation depth/concurrency stress
      agent-delegation.test.ts
      browser-interaction.test.ts
      error-handling.test.ts
      full-pipeline.test.ts
      governance-proposals.test.ts
      identity-update.test.ts
      memory-lifecycle.test.ts
      multi-turn-tool-use.test.ts
      scheduled-task.test.ts
      skill-creation.test.ts
      slack-message.test.ts
      web-search.test.ts
      workspace-ops.test.ts
  migrations/              # Database migration tests
    jobs.test.ts
  sandbox-isolation.test.ts  # Tool count assertions
  ipc-fuzz.test.ts
  ipc-schemas.test.ts              # IPC schema validation
  ipc-schemas-delivery.test.ts     # Delivery IPC schemas
  ipc-schemas-enterprise.test.ts   # Enterprise IPC schemas
  config.test.ts
  config-history.test.ts           # History config validation
  job-store.test.ts                # Scheduler job persistence
  errors.test.ts                   # Error types
  logger.test.ts                   # Logging
  dotenv.test.ts                   # .env loading
  paths.test.ts                    # Path utilities
```

## Test Patterns

### Factory Helpers

Create `makeXxx()` helpers for commonly-used test objects:

```typescript
function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-coding-agent',
    workspace: '/tmp/test-ws',
    sandboxType: 'subprocess',
    profile: 'balanced',
    taintRatio: 0,
    taintThreshold: 0.3,
    identityFiles: { agents: '', soul: 'Test soul', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },
    contextContent: '',
    skills: [],
    maxTokens: 200000,
    historyTokens: 0,
    ...overrides,
  };
}
```

### SQLite Test Isolation

**Critical**: Each test must use an isolated `AX_HOME` directory:

```typescript
let tmpDir: string;
beforeEach(() => {
  tmpDir = join(tmpdir(), `ax-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  process.env.AX_HOME = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.AX_HOME;
});
```

### Mock Providers

Use stub/mock providers for tests:
```typescript
import { disabledProvider } from '../../src/utils/disabled-provider.js';
const mockWeb = disabledProvider<WebProvider>();
```

For LLM tests, use the `mock` provider that returns fixed responses.

## Tool Count Assertion

`tests/sandbox-isolation.test.ts` asserts the exact number of tools registered for each runner. **Security invariant** -- catches accidentally exposed tools. Update the expected count when adding new IPC tools.

## Test Categories

- **NATS / K8s tests**: `nats-session-protocol.test.ts`, `nats-sandbox-dispatch.test.ts`, `nats-llm-proxy.test.ts`, `sandbox-worker/` -- NATS messaging and K8s pod sandbox
- **IPC handler tests**: `host/ipc-handlers/` -- per-handler tests for sandbox-tools, workspace, identity, governance, memory, orchestration, skills-install
- **Event bus tests**: `event-bus.test.ts`, `event-bus-sse.test.ts`, `event-console.test.ts` -- streaming observability
- **Plugin tests**: `plugin-host.test.ts`, `plugin-lock.test.ts`, `plugin-manifest.test.ts` -- plugin lifecycle and integrity
- **Delegation tests**: `delegation-hardening.test.ts`, `delegation-stress.test.ts`, `ipc-delegation.test.ts` -- depth/concurrency limits, zombie prevention
- **Image pipeline tests**: `server-multimodal.test.ts`, `server-completions-images.test.ts`, `ipc-handlers/image.test.ts` -- image handling
- **Cortex memory tests**: `providers/memory/cortex/` -- 12+ tests covering extraction, salience, dedup, embeddings, summary store, items store
- **Provider SDK tests**: `provider-sdk/harness.test.ts`, `interfaces.test.ts`
- **Screener tests**: `providers/screener/` -- static analysis patterns
- **Tool catalog sync tests**: `tool-catalog-sync.test.ts` -- verifies ipc-tools.ts and mcp-server.ts stay in sync
- **IPC schema tests**: `ipc-schemas.test.ts`, `ipc-schemas-delivery.test.ts`, `ipc-schemas-enterprise.test.ts` -- schema validation
- **E2E scenario tests**: `e2e/scenarios/` -- 14 scenario tests covering delegation, governance, workspace ops, memory lifecycle, etc.
- **Fault tolerance tests**: `fault-tolerance.test.ts`, `channel-reconnect.test.ts`, `ipc-client-reconnect.test.ts` -- resilience patterns
- **Storage tests**: `providers/storage/database.test.ts`, `migrate-to-db.test.ts` -- database-backed StorageProvider and migration
- **Utils tests**: `utils/` -- 11 test files covering safe-path, migrator, circuit-breaker, embedding-client, bin-exists, install-validator, etc.
- **CLI tests**: `cli/` -- send, bootstrap, reload, k8s-init, index routing

## Common Tasks

**Writing a test for a bug fix:**
1. Create test file matching the source path
2. Write the test FIRST -- reproduce the bug with a failing assertion
3. Fix the bug
4. Verify the test passes

**Testing a new prompt module:**
1. Create `tests/agent/prompt/modules/<name>.test.ts`
2. Test `shouldInclude()` with various contexts (bootstrap mode, empty content, etc.)
3. Test `render()` output contains expected sections
4. Test `renderMinimal()` if implemented

**Testing a new provider:**
1. Create `tests/providers/<category>/<name>.test.ts`
2. Test `create(config)` returns a valid provider instance
3. Test each interface method
4. Test error handling and security constraints

## Gotchas

- **SQLite lock contention**: Tests sharing `AX_HOME` will deadlock. Always isolate. #1 source of flaky tests.
- **Tool count assertion**: Adding a tool without updating `sandbox-isolation.test.ts` fails CI.
- **Cleanup afterEach**: Always clean up temp dirs and reset env vars.
- **Vitest and Bun differences**: Both supported. Test with `npm test` as primary.
- **Don't mock what you don't own**: Prefer `mock` provider implementations over mocking interfaces.
- **Integration tests are slow**: Tests in `tests/integration/` spawn real processes. Use `--bail` to fail fast.
- **StorageProvider tests need cleanup**: Tests using StorageProvider should close the database and clean up `AX_HOME` in afterEach.
- **Parallel CI robustness**: Integration smoke tests must handle timing variations. Use retry loops and generous timeouts for process spawning.
- **Cortex tests need DB isolation**: Each cortex test needs its own temp database. Use the `AX_HOME` isolation pattern.
- **IPC schema tests are strict**: Adding an IPC action requires updating the corresponding `ipc-schemas.test.ts` file or tests fail.
- **Tool catalog sync test**: Validates that ipc-tools.ts and mcp-server.ts expose the same tools. Fails if you add a tool to one but not the other.
