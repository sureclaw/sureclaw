# Providers: Sandbox

Sandbox providers, canonical paths, workspace tiers.

## [2026-03-01 15:57] — Rename canonical paths: /agent→/identity, /shared→/agent

**Task:** Fix confusing mismatch between IPC tier name "agent" and mount path "/shared" by aligning the path to the tier name
**What I did:** (1) Renamed identity dir from `CANONICAL.agent` (`/agent`) to `CANONICAL.identity` (`/identity`). (2) Renamed workspace from `CANONICAL.shared` (`/shared`) to `CANONICAL.agent` (`/agent`). Updated canonical-paths.ts (constants, canonicalEnv, createCanonicalSymlinks, symlinkEnv), all 3 sandbox providers (docker, bwrap, nsjail), runtime prompt, and all related tests.
**Files touched:** `src/providers/sandbox/canonical-paths.ts`, `src/providers/sandbox/docker.ts`, `src/providers/sandbox/bwrap.ts`, `src/providers/sandbox/nsjail.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/providers/sandbox/canonical-paths.test.ts`, `tests/agent/prompt/enterprise-runtime.test.ts`
**Outcome:** Success — build clean, all 2005 tests pass, zero stale `/shared` or `CANONICAL.shared` references remain
**Notes:** The existing `CANONICAL.agent` was occupied by the identity directory, so we needed a two-step swap: identity `/agent`→`/identity`, then workspace `/shared`→`/agent`.
