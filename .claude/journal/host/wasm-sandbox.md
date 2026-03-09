# WASM Sandbox

Journal entries for the unified WASM sandbox architecture (sandbox-tools subsystem).

## [2026-03-08 22:56] — Implement Phase 2: Restricted bash fast path

**Task:** Implement Phase 2 of the unified WASM sandbox plan — move the safe, repetitive subset of `sandbox_bash` into Tier 1 with native handlers.

**What I did:**
- Created `src/host/sandbox-tools/bash-handlers.ts` with native implementations for 11 commands: pwd, echo, basename, dirname, cat, head, tail, wc, ls, stat, realpath
- Pure handlers (pwd, echo, basename, dirname) eliminate process spawning entirely
- FS-based handlers (cat, head, tail, wc, ls) go through hostcall API for validation, quotas, and audit
- Binary-delegated commands (rg, grep, find, git, file, tree, du, df) use validated execSync with workspace containment
- Updated wasm-executor.ts to route classified bash commands through native handlers
- Fixed `.` path handling in `validatePath()` — safePath sanitizes `.` to `_empty_`
- Created 56 handler unit tests in `tests/host/sandbox-tools/bash-handlers.test.ts`
- Added 100 golden tests to bash-classifier (55 Tier 1 command shapes, 45 Tier 2 rejection patterns)
- Added 9 Phase 2 bash parity tests comparing local vs WASM executor
- Fixed macOS `/private` symlink prefix issue in `handlePwd` using `realpathSync`

**Files touched:**
- Created: `src/host/sandbox-tools/bash-handlers.ts`
- Modified: `src/host/sandbox-tools/wasm-executor.ts` (route bash through handlers, fix `.` path)
- Modified: `src/host/sandbox-tools/index.ts` (export new module)
- Created: `tests/host/sandbox-tools/bash-handlers.test.ts`
- Modified: `tests/host/sandbox-tools/bash-classifier.test.ts` (100 golden tests)
- Modified: `tests/host/sandbox-tools/contract-parity.test.ts` (9 bash parity tests)

**Outcome:** Success — all 2671 tests pass (+100 new tests). Phase 2 exit criteria met:
- Meaningful slice of bash traffic served by Tier 1 with native handlers
- Auditable classifier rules with golden tests for every allowlisted shape
- No surprise escalations — conservative routing, everything ambiguous stays Tier 2

**Notes:**
- macOS `/var` is a symlink to `/private/var` — `realpathSync` needed for pwd output parity
- safePath sanitizes `.` segments by trimming leading/trailing dots → empty string → `_empty_`. Must filter `.` before calling safePath.
- `echo -n` behavior differs between `/bin/sh` (prints `-n` literally) and bash (suppresses newline). Parity tests should use `toContain` not strict equality for shell-dependent output.

## [2026-03-08 21:00] — Implement Phase 0+1: Unified WASM sandbox architecture

**Task:** Implement Phase 0 (execution seam + shadow router) and Phase 1 (structured file ops via WASM) of the unified WASM sandbox plan.

**What I did:**
- Extracted execution seam behind shared `SandboxToolRequest`/`SandboxToolResponse` contract
- Built intent router with shadow mode, compare mode, and kill switch
- Built strict bash classifier with 18 allowlisted read-only commands
- Implemented WASM executor with hostcall API (ax.fs.read, ax.fs.write, ax.fs.list, ax.log.emit)
- Implemented local executor for Tier 2 fallback
- Wired into IPC handler with fallback semantics (HostcallError fails closed, runtime errors fall back)
- Added comprehensive tests: parity tests, security tests, classifier tests, concurrency tests

**Files touched:**
- Created: `src/host/sandbox-tools/types.ts`, `router.ts`, `bash-classifier.ts`, `wasm-executor.ts`, `local-executor.ts`, `nats-executor.ts`, `index.ts`
- Created: 5 test files under `tests/host/sandbox-tools/`
- Modified: `src/host/ipc-handlers/sandbox-tools.ts` (dispatch through router)

**Outcome:** Success
**Notes:** Phase 0 native mode — file ops go through hostcall validation layer but execute natively (not via WASM modules yet)
