---
name: ax-testing
description: Use when writing or debugging tests — test structure, fixtures, mocking patterns, common assertions, and gotchas for the vitest/bun test suite in tests/
---

## Overview

AX uses vitest for Node.js and bun's native test runner as alternatives. Tests mirror the `src/` directory structure exactly. The project's bug fix policy requires that every bug fix includes a regression test. Test isolation is critical -- especially for SQLite databases and process-level state.

## Commands

```bash
npm test              # Run all tests (vitest on Node.js)
bun test              # Run all tests (Bun native runner)
npm run test:fuzz     # Run fuzz tests (vitest --run tests/ipc-fuzz.test.ts)
npm run test:e2e      # Run e2e regression tests (vitest --config tests/e2e/vitest.config.ts)
```

## Directory Structure

Tests mirror `src/` exactly:

```
tests/
  agent/
    prompt/
      modules/         # Per-module tests (identity, security, heartbeat, memory-recall, etc.)
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
    runner-provisioning.test.ts
    ipc-client.test.ts
    ipc-client-reconnect.test.ts  # Reconnection logic
    ipc-transport.test.ts
    ipc-tools.test.ts
    http-ipc-client.test.ts
    mcp-server.test.ts
    tool-catalog.test.ts
    tool-catalog-sync.test.ts
    tool-catalog-credential.test.ts
    identity-loader.test.ts  # Identity loading from stdin payload
    local-sandbox.test.ts    # Local sandbox execution
    session.test.ts
    tcp-bridge.test.ts       # TCP-to-Unix socket bridge
    heartbeat-state.test.ts
    stream-utils.test.ts
    agent-setup.test.ts
    queue-group-work.test.ts
    skill-installer.test.ts
    web-proxy-bridge.test.ts
    workspace-cli.test.ts    # Workspace CLI commands
    workspace-release.test.ts
    workspace-release-hashes.test.ts
    workspace-provision-fixes.test.ts
  host/
    server.test.ts
    server-admin.test.ts         # Admin API endpoints
    server-channels.test.ts
    server-completions-gcs-prefix.test.ts
    server-completions-images.test.ts
    server-credentials-sse.test.ts
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
    proxy-ca.test.ts
    proxy-oauth-refresh.test.ts
    oauth.test.ts
    oauth-skills.test.ts
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
    internal-ipc-route.test.ts
    llm-proxy-route.test.ts
    web-proxy.test.ts
    web-proxy-approvals.test.ts
    workspace-release-screener.test.ts
    collect-skill-env.test.ts
    credential-injection-integration.test.ts
    credential-placeholders.test.ts
    post-agent-credential-detection.test.ts
    orchestration/
      orchestrator.test.ts
      agent-loop.test.ts
      agent-supervisor.test.ts
      agent-directory.test.ts
      event-store.test.ts
      heartbeat-monitor.test.ts
    ipc-handlers/
      image.test.ts              # Image generation handler
      llm-events.test.ts         # LLM streaming events
      orchestration.test.ts      # Agent orchestration
      workspace.test.ts          # Workspace management
      memory.test.ts             # Memory handlers
      governance.test.ts         # Governance proposals
      sandbox-tools.test.ts      # Sandbox tool routing
      identity.test.ts           # Identity IPC handlers
      web.test.ts                # Web IPC handlers
  providers/
    llm/               # Per-provider tests (anthropic, openai, router, traced, context-windows, thinking-chunk)
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
      slack.test.ts
      slack-session.test.ts
      types.test.ts
    web/
      fetch.test.ts
      tavily.test.ts
    browser/
      container.test.ts
    credentials/
      plaintext.test.ts
      keychain.test.ts
      database.test.ts
    skills/
    screener/          # Static screener tests
    audit/
      database.test.ts
    sandbox/
      apple.test.ts          # Apple Container sandbox
      canonical-paths.test.ts # Canonical path resolution
      docker.test.ts         # Docker sandbox
      k8s.test.ts            # Kubernetes sandbox provider
      k8s-warm-pool.test.ts  # K8s warm pool
      k8s-ca-injection.test.ts
      subprocess.test.ts     # Subprocess sandbox
      utils.test.ts          # Sandbox utilities
    scheduler/
      plainjob.test.ts
      utils.test.ts
    storage/
      database.test.ts     # Database-backed StorageProvider
      migrate-to-db.test.ts # Filesystem-to-DocumentStore migration
    workspace/
      gcs.test.ts            # GCS workspace backend
      gcs-transport.test.ts  # GCS transport layer
      gcs-remote-transport.test.ts
      local.test.ts          # Local workspace backend
      none.test.ts           # No-op workspace stub
      shared.test.ts         # Shared workspace utilities
      lifecycle.test.ts
    database/
      postgres.test.ts
      sqlite.test.ts
    eventbus/
      inprocess.test.ts
    router-utils.test.ts
    shared-types.test.ts
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
    utils/
      commands.test.ts
      markdown.test.ts
  onboarding/
    configure.test.ts
    wizard.test.ts
  pool-controller/     # Pool controller tests
    controller.test.ts
    k8s-client.test.ts
    main.test.ts
    metrics.test.ts
  utils/
    safe-path.test.ts
    disabled-provider.test.ts
    circuit-breaker.test.ts
    database.test.ts
    migrator.test.ts
    retry.test.ts
    embedding-client.test.ts
    bin-exists.test.ts
    manifest-generator.test.ts
    skill-format-parser.test.ts
    nats.test.ts
  integration/         # Integration and smoke tests
    smoke.test.ts
    phase1.test.ts
    phase2.test.ts
    cross-component.test.ts
    e2e.test.ts
    history-smoke.test.ts
  e2e/                 # Automated regression tests (run against live AX server)
    regression.test.ts   # Sequential regression test suite
    client.ts            # SSE-aware HTTP client for AX completions endpoint
    global-setup.ts      # kind cluster lifecycle, mock server, port-forward
    vitest.config.ts     # Separate vitest config (npm run test:e2e)
    kind-values.yaml     # Helm overrides for kind cluster
    mock-server/         # Mock external services
      index.ts           # Router combining all mock providers
      openrouter.ts      # Mock OpenRouter with scripted LLM turns
      clawhub.ts         # Mock ClawhHub registry
      gcs.ts             # Mock GCS storage
      gcs.test.ts        # GCS mock unit tests
      linear.ts          # Mock Linear API
    scripts/             # Scripted test scenarios (ScriptedTurn-based)
      index.ts           # Script registry
      types.ts           # ScriptedTurn type definition
      bootstrap.ts       # Bootstrap/introduction scenario
      chat.ts            # Basic chat scenario
      memory.ts          # Memory lifecycle scenario
      scheduler.ts       # Scheduled task scenario
      skills.ts          # Skill creation scenario
  migrations/              # Database migration tests
    jobs.test.ts
  sandbox-isolation.test.ts  # Tool count assertions
  ipc-fuzz.test.ts
  ipc-schemas.test.ts              # IPC schema validation
  ipc-schemas-delivery.test.ts     # Delivery IPC schemas
  ipc-schemas-enterprise.test.ts   # Enterprise IPC schemas
  ipc-schemas-credential.test.ts   # Credential IPC schemas
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

## E2E Regression Tests

The `tests/e2e/` directory contains automated regression tests that run against a live AX server deployed in a kind cluster. These replaced the old manual `tests/acceptance/` approach.

**How it works:**
- `global-setup.ts` creates a kind cluster, builds/loads Docker image, deploys AX via Helm, starts a mock server (OpenRouter, ClawhHub, GCS, Linear), and port-forwards the AX service
- `regression.test.ts` runs sequential tests via `AcceptanceClient` (SSE-aware HTTP client)
- Mock OpenRouter uses `ScriptedTurn` definitions from `scripts/` to return deterministic LLM responses
- `url_rewrites` config redirects the agent's external service calls to the mock server on the host

**Key patterns:**
- Tests are sequential (each may depend on state from previous tests)
- `ScriptedTurn` scripts define `match` patterns and canned `response` objects (content + optional tool_calls)
- `AcceptanceClient` handles SSE streaming, credential events, and response accumulation
- `kind-values.yaml` overrides configure the kind cluster (sandbox: subprocess, mock server URLs)

**Running:**
```bash
npm run test:e2e                               # Full suite (creates/tears down kind cluster)
AX_SERVER_URL=http://localhost:8080 npm run test:e2e  # Against existing server (skips cluster setup)
```

## Test Categories

- **NATS / K8s tests**: `nats-session-protocol.test.ts` -- NATS messaging and K8s pod sandbox
- **IPC handler tests**: `host/ipc-handlers/` -- per-handler tests for sandbox-tools, workspace, identity, governance, memory, orchestration, image, llm-events, web
- **Event bus tests**: `event-bus.test.ts`, `event-bus-sse.test.ts`, `event-console.test.ts` -- streaming observability
- **Plugin tests**: `plugin-host.test.ts`, `plugin-lock.test.ts`, `plugin-manifest.test.ts` -- plugin lifecycle and integrity
- **Delegation tests**: `delegation-hardening.test.ts`, `ipc-delegation.test.ts` -- depth/concurrency limits, zombie prevention
- **Image pipeline tests**: `server-multimodal.test.ts`, `server-completions-images.test.ts`, `ipc-handlers/image.test.ts` -- image handling
- **Cortex memory tests**: `providers/memory/cortex/` -- 12+ tests covering extraction, salience, dedup, embeddings, summary store, items store
- **Provider SDK tests**: `provider-sdk/harness.test.ts`, `interfaces.test.ts`
- **Screener tests**: `providers/screener/` -- static analysis patterns
- **Tool catalog sync tests**: `tool-catalog-sync.test.ts` -- verifies ipc-tools.ts and mcp-server.ts stay in sync
- **IPC schema tests**: `ipc-schemas.test.ts`, `ipc-schemas-delivery.test.ts`, `ipc-schemas-enterprise.test.ts`, `ipc-schemas-credential.test.ts` -- schema validation
- **Orchestration tests**: `host/orchestration/` -- orchestrator, agent-loop, agent-supervisor, agent-directory, event-store, heartbeat-monitor
- **Pool controller tests**: `pool-controller/` -- controller, k8s-client, main, metrics
- **Fault tolerance tests**: `fault-tolerance.test.ts`, `channel-reconnect.test.ts`, `ipc-client-reconnect.test.ts` -- resilience patterns
- **Storage tests**: `providers/storage/database.test.ts`, `migrate-to-db.test.ts` -- database-backed StorageProvider and migration
- **Utils tests**: `utils/` -- safe-path, migrator, circuit-breaker, embedding-client, bin-exists, nats, etc.
- **Workspace provider tests**: `providers/workspace/` -- gcs, local, none, shared, gcs-transport, gcs-remote-transport, lifecycle
- **Sandbox provider tests**: `providers/sandbox/` -- apple, docker, subprocess, k8s, k8s-warm-pool, k8s-ca-injection, canonical-paths, utils
- **CLI tests**: `cli/` -- send, bootstrap, reload, k8s-init, index routing, utils/
- **E2E regression tests**: `e2e/regression.test.ts` -- sequential tests against live AX server with mock providers

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

**Adding a new e2e regression test:**
1. Create a new script in `tests/e2e/scripts/<name>.ts` with `ScriptedTurn[]` definitions
2. Register it in `tests/e2e/scripts/index.ts`
3. Add the corresponding test case in `tests/e2e/regression.test.ts`
4. Add any needed mock endpoints to `tests/e2e/mock-server/`

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
- **E2E tests need kind**: The e2e regression suite requires Docker and kind. Set `AX_SERVER_URL` to skip cluster creation when testing against an existing server.
