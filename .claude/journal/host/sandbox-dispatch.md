# Sandbox Dispatch

Local and NATS-based sandbox dispatching, lazy sandbox spawning.

## [2026-03-14 12:05] — Create LocalSandboxDispatcher for lazy sandbox spawning

**Task:** Implement LocalSandboxDispatcher that mirrors NATSSandboxDispatcher pattern for local sandbox modes
**What I did:** Created `src/host/local-sandbox-dispatch.ts` with factory function pattern (closure-based, no `this` binding). For container types (apple/docker), lazily spawns sandbox on first `ensureSandbox()` call. For subprocess/seatbelt, `ensureSandbox()` is a no-op. Added `getSandboxProcess()` accessor for later integration. Created comprehensive test suite with 11 tests covering all sandbox types, reuse, release, and close.
**Files touched:** `src/host/local-sandbox-dispatch.ts` (created), `tests/host/local-sandbox-dispatch.test.ts` (created)
**Outcome:** Success — all 11 tests pass
**Notes:** Used closure pattern (not class) to match NATSSandboxDispatcher style. Delete from map before kill() in release() so hasSandbox returns false even on throw. Promise.allSettled in close() so one failure doesn't block others.
