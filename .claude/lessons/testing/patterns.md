# Testing Patterns

### Playwright route overrides need "last wins" ordering
**Date:** 2026-04-17
**Context:** Writing `ui/admin/tests/skills.spec.ts`. An empty-state test called `mockSkillsSetup(page, { agents: [] })` before `gotoAuthenticated`, but `gotoAuthenticated` internally runs `mockAllAPIs` which re-registers the default non-empty route. The page fetched the defaults, not the empty override.
**Lesson:** Playwright applies the most-recently-registered matching route first. If a default mock is installed via a helper (e.g. `mockAllAPIs`), any per-test override must be registered AFTER the helper runs — and if the fetch already fired before the override, `page.reload()` to re-trigger with the new routing. Equivalently: restructure helpers to skip the default route when you know a test overrides it. For the skills page I used the reload pattern because it's cheap and local.
**Tags:** playwright, route-mocking, test-ordering, ui-admin

### Seed a bare git repo in tests via sidecar work-tree + push
**Date:** 2026-04-16
**Context:** Writing `tests/host/skills/snapshot.test.ts` — needed real commits/refs in a bare repo so `git ls-tree`/`git show` against `refs/heads/main` work. You can't just `git init --bare` and point at files; bare repos have no index.
**Lesson:** To seed a bare repo in a test, create a temp work-tree, run `git init -b main`, set `user.name`/`user.email`, `git remote add origin <bareRepoPath>`, write files, `add`/`commit`/`push -u origin main`. Use `execFileSync('git', [...], { stdio: 'pipe' })` with array args (no shell). Clean up both dirs in `afterEach`/`finally`. This mirrors the http-server.js init-repo flow and is the only reliable way to get a real ref into a bare repo from a test.
**Tags:** git, bare-repo, testing, fixtures, execFile

### SSE streaming tests are fragile when new named events are added
**Date:** 2026-03-24
**Context:** Adding status named SSE events broke server.test.ts because it filtered all `data:` lines by index, not by content type.
**Lesson:** When testing SSE streams that may contain named events alongside OpenAI-format chunks, filter data lines by content (e.g. `l.includes('"chat.completion.chunk"')`) rather than positional index. Named events add extra `data:` lines that shift indices.
**Tags:** sse, testing, named-events, server

### vi.mock constructor mocks must use regular functions, not arrow functions or vi.fn()
**Date:** 2026-03-15
**Context:** Mocking EmbeddingStore class for cortex provider parallel search tests. `vi.fn().mockImplementation(() => inst)` fails with "not a constructor" when the mock is called with `new`.
**Lesson:** When mocking a class in `vi.mock` that's instantiated with `new`, use a named regular function: `EmbeddingStore: function EmbeddingStore() { return mockInst; }`. Arrow functions can't be constructors, and `vi.fn()` inside `vi.mock` factories doesn't properly support `new` in vitest v4. The regular function returning an object works because `new` uses the returned object.
**Tags:** vitest, vi.mock, constructor, class mock, EmbeddingStore

### Sandbox providers use source-level test assertions (read source, check patterns)
**Date:** 2026-03-01
**Context:** Updating sandbox-isolation.test.ts after changing seatbelt/subprocess env construction
**Lesson:** Many sandbox tests verify behavior by reading the provider's TypeScript source and checking for string patterns (e.g. `expect(source).toContain('...process.env')`). When changing provider implementation patterns, check sandbox-isolation.test.ts for source-level assertions that will break. These tests are in tests/sandbox-isolation.test.ts, not in tests/providers/sandbox/.
**Tags:** testing, sandbox, source-level-tests, sandbox-isolation

### Regex tests on source code are fragile — prefer semantic assertions
**Date:** 2026-02-22
**Context:** sandbox-isolation.test.ts used `expect(source).toMatch(/sandbox\.spawn\(\{[^}]*agentDir/s)` which broke when the spawn config was extracted into a variable.
**Lesson:** Tests that regex-match source code break whenever the code is refactored (extract variable, reorder params, etc.). Prefer simpler checks: `toContain('agentDir')` + `toMatch(/sandbox\.spawn/)` is more resilient. Even better, test behavior rather than code structure.
**Tags:** testing, regex, source-code-tests, refactoring

### Retry tests with real backoff delays need careful design
**Date:** 2026-02-22
**Context:** Channel reconnect test was timing out because it used the production retry config (2s initial delay, 5 retries) with 100 failures = 60+ seconds
**Lesson:** When testing code that uses `withRetry()` with production delay constants, either: (1) keep failure counts below max retries to avoid real timeout accumulation, (2) test the retry logic separately (already covered by retry.test.ts), or (3) make the retry options configurable and pass fast options in tests. Permanent error tests (auth errors that skip retry) are always fast and safe.
**Tags:** testing, retry, timeout, vitest, backoff

### Mock LLM provider doesn't echo model names — use provider failures to verify routing
**Date:** 2026-02-26
**Context:** Writing tests for task-type model routing in the LLM router. Tried to verify which model chain was used by checking the mock provider's response text, but it returns static "Hello from mock LLM." regardless of model name.
**Lesson:** To test that the router selects the correct model chain for a task type, set the "wrong" chain to a provider that will fail (e.g., `openai/gpt-4` without API key) and the "right" chain to mock. If routing is correct, the call succeeds; if wrong, it throws. This is more robust than trying to inspect response content.
**Tags:** testing, llm-router, mock-provider, task-type-routing

### Smoke tests use stdout markers to detect server readiness
**Date:** 2026-02-28
**Context:** Downgrading server_listening log to debug broke smoke tests that searched for it as a readiness marker
**Lesson:** Integration/smoke tests in tests/integration/ spawn the server as a subprocess and watch stdout for a specific string to detect readiness. When changing log levels or replacing log messages with event bus events, always search for the old log message across ALL test files (not just unit tests) — smoke tests are easily missed. The smoke tests (smoke.test.ts, history-smoke.test.ts) both had independent copies of `waitForReady()` matching on `server_listening`.
**Tags:** testing, smoke, integration, log-levels, readiness

### Changing prompt module output breaks tests in multiple locations
**Date:** 2026-02-23
**Context:** Changing the skills module from full content to progressive disclosure broke tests in skills.test.ts, sandbox-isolation.test.ts, integration.test.ts, and stream-utils.test.ts
**Lesson:** When modifying a prompt module's `render()` output, search for all tests that assert on that text: `grep -r "the old text" tests/`. Also check sandbox-isolation.test.ts (it reads source files), integration.test.ts (full builder test with hardcoded module counts and ordering), and stream-utils.test.ts (tests for helper functions that feed the module).
**Tags:** testing, prompt-modules, integration-tests, sandbox-isolation

### When adding new prompt modules, update integration test module count
**Date:** 2026-02-23
**Context:** Adding memory-recall and tool-style modules changed the module count from 5 to 7 in the full prompt integration test
**Lesson:** `tests/agent/prompt/integration.test.ts` has a hardcoded `moduleCount` assertion and per-module token breakdown check. When adding new modules: (1) update the count, (2) add the new module's token check, (3) verify ordering assertions include the new module.
**Tags:** testing, prompt-modules, integration-test, builder

### Use createHttpServer for isolated SSE endpoint tests instead of full AxServer
**Date:** 2026-02-28
**Context:** Needed to test the SSE /v1/events endpoint without the full server stack (providers, sandbox, IPC)
**Lesson:** For testing SSE endpoints, create a minimal HTTP server that implements just the endpoint logic with the real EventBus. This avoids the 5+ second startup cost of the full AxServer (provider loading, DB init, IPC server, template copying) and makes tests fast and isolated. The SSE endpoint only depends on the EventBus — no providers needed.
**Tags:** testing, sse, isolation, performance, event-bus

### Strengthen assertions — use exact values not just range checks
**Date:** 2026-03-21
**Context:** Reviewing coderabbitai comments on session title truncation test — `toBeLessThanOrEqual(50)` doesn't catch truncation bugs (off-by-one, wrong substring).
**Lesson:** Assert the exact expected value when it's deterministic. `expect(title).toBe(msg.substring(0, 47) + '...')` is far better than `expect(title.length).toBeLessThanOrEqual(50)`. Range checks let bugs through; exact assertions don't.
**Tags:** assertions, test quality, truncation, coderabbitai
