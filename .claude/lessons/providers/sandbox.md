# Provider Lessons: Sandbox

### child.killed is true after ANY kill() call, not just after the process is dead
**Date:** 2026-02-22
**Context:** `enforceTimeout` was checking `child.killed` to skip SIGKILL after SIGTERM, but `child.killed` is set to `true` the moment `kill()` is called, regardless of whether the process actually exited.
**Lesson:** Use a custom `exited` flag set via `child.on('exit', ...)` to track whether the process has actually terminated. Don't rely on `child.killed` to mean "the process is dead" — it only means "we've called kill() on it".
**Tags:** child_process, node.js, signals, SIGTERM, SIGKILL, sandbox

### Never use tsx binary as a process wrapper — use `node --import tsx/esm` instead
**Date:** 2026-02-27
**Context:** Diagnosing agent delegation failures — tsx wrapper caused EPERM, orphaned processes, and corrupted exit codes
**Lesson:** The tsx binary (`node_modules/.bin/tsx`) spawns a child Node.js process and relays signals via `relaySignalToChild`. On macOS, this relay fails with EPERM, and tsx has no error handling for it. Always use `node --import <absolute-path-to-tsx/dist/esm/index.mjs>` instead — single process, no signal relay issues. The absolute path is mandatory because agents run with cwd=workspace (temp dir with no node_modules).
**Tags:** tsx, process management, macOS, signal handling, EPERM, sandbox
