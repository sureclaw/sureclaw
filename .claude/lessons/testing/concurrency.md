# Testing Concurrency

### Test concurrent async handlers using the handler factory directly, not the IPC wrapper
**Date:** 2026-02-27
**Context:** Writing tests for concurrent delegation that timed out at 30s
**Lesson:** When testing concurrent handler behavior (concurrency limits, counters), call `createDelegationHandlers()` directly instead of going through `createIPCHandler()`. The IPC handler wraps every call in a 15-minute `Promise.race` timeout, which blocks tests that use blocking promises. Also: when a test fires a blocking delegation and later needs to verify "counter resets to 0", DON'T `await` the verification call directly — fire it without await, push the resolver, THEN await. Otherwise you deadlock: the await waits for the resolver that hasn't been pushed yet.
**Tags:** testing, delegation, concurrency, deadlock, ipc-handler
