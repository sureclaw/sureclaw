# Provider Lessons: Scanner

### Identity content and injection patterns are semantically identical
**Date:** 2026-03-20
**Context:** SOUL.md writes were silently blocked by the guardian scanner's injection-detection regex. Patterns like `override your safety` and `bypass the restrictions` triggered on behavioral boundary language that SOUL.md naturally contains. This caused bootstrap to never complete — the agent could write IDENTITY.md but never SOUL.md, resulting in infinite re-bootstrapping.
**Lesson:** Never run injection-detection regex patterns on identity mutation content (source: `identity_mutation` or `user_mutation`). Identity files define the agent's behavioral constraints and naturally use the same vocabulary as injection attacks. Use the taint budget (upstream) for injection-through-manipulation protection, and limit scanner scanning to credential/PII checks (OUTPUT_PATTERNS) for identity content.
**Tags:** scanner, guardian, identity, bootstrap, false-positive, regex, SOUL.md

### Check the audit_log table when identity persistence fails
**Date:** 2026-03-20
**Context:** Debugging identity not persisting across sessions in k8s. The host logs showed no identity_write IPC calls. The real story was in the audit_log table: every SOUL.md write had `decision: scanner_blocked`.
**Lesson:** When identity writes appear to not persist, check the `audit_log` PostgreSQL table (`SELECT action, args, timestamp FROM audit_log WHERE action LIKE '%identity%'`). The identity_write handler logs all decisions (applied, queued, scanner_blocked) to audit before returning to the agent. The host process log doesn't log individual IPC actions by default.
**Tags:** debugging, identity, audit-log, k8s, persistence
