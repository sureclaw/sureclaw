## [2026-03-26 08:37] — Add scheduler sandbox timeout override

**Task:** Sandboxes started by the scheduler should use a shorter timeout whether or not they access the filesystem
**What I did:** Added `scheduler.timeout_sec` optional config field. When set, scheduler-initiated sandbox runs use this value instead of `sandbox.timeout_sec`. The override follows the same pattern as webhooks — a new config object with the overridden timeout is created (no mutation of shared state). Applied in both `server-local.ts` and `server-k8s.ts` scheduler callback wiring. In k8s, also added `baseDeps` parameter to `processCompletionForSession` so the agent response timeout timer respects the override.
**Files touched:** `src/types.ts`, `src/config.ts`, `src/host/server-local.ts`, `src/host/server-k8s.ts`, `tests/host/scheduler-timeout.test.ts` (new)
**Outcome:** Success — compiles clean, all existing tests pass, new test covers the override logic
**Notes:** The k8s path needed extra care: mutating the shared `config` object would race with concurrent requests. Used an immutable override via `baseDeps` parameter instead.
