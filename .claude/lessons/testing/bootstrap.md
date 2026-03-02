# Testing Bootstrap

### Bootstrap lifecycle must be tested end-to-end including server restarts
**Date:** 2026-02-22
**Context:** Two bootstrap bugs went undetected: `.bootstrap-admin-claimed` never deleted, and BOOTSTRAP.md recreated on restart. Tests only covered individual helper functions and single-server-lifecycle scenarios.
**Lesson:** Any time server startup has initialization logic that depends on persisted state (like "copy file if not exists"), there MUST be a test that verifies the behavior across server restarts. Unit tests for helpers are not enough — the interaction between server startup copying and bootstrap completion deletion is where bugs hide.
**Tags:** bootstrap, lifecycle, integration-testing, server-restart

### isAgentBootstrapMode requires BOTH SOUL.md and IDENTITY.md to complete bootstrap
**Date:** 2026-02-22
**Context:** A test assumed writing just SOUL.md would trigger bootstrap completion and delete BOOTSTRAP.md. It was wrong — `isAgentBootstrapMode` returns true until BOTH files exist.
**Lesson:** When writing tests for multi-step completion logic (like bootstrap), always trace through the actual condition. `isAgentBootstrapMode` checks `!existsSync(SOUL.md) || !existsSync(IDENTITY.md)` — both must exist for it to return false. Tests must create both files before asserting completion behavior.
**Tags:** bootstrap, testing, conditions, identity
