# Config

### Renaming a Config field has massive blast radius — check YAML fixtures too
**Date:** 2026-02-26
**Context:** Renamed `config.model` + `config.model_fallbacks` to `config.models` array. First test run after updating source had 8 test file failures because 6 YAML test fixtures and 2 inline test configs still used the old `model:` field. Zod strict mode rejected the unrecognized key.
**Lesson:** When renaming a Config field: (1) grep all `.yaml` files under tests/ for the old field name, (2) grep all `.test.ts` files for inline config objects using the old name, (3) remember that Zod `.strict()` mode means any unrecognized key causes a hard failure — there's no graceful fallback. The YAML fixtures are especially easy to miss because they're data files, not code.
**Tags:** config, testing, yaml, zod, strict-mode, rename-blast-radius

### AgentConfig.model is NOT the same as Config.model — check the type before renaming
**Date:** 2026-02-26
**Context:** When renaming `Config.model` to `Config.models`, initially thought ALL `config.model` references needed updating. But `AgentConfig` in runner.ts has its own `model` field (agent-side model from CLI args) that is a completely different type.
**Lesson:** Before bulk-renaming a field across the codebase, verify which TYPE each `config.model` reference belongs to. `Config` (from ax.yaml, host-side) and `AgentConfig` (from CLI args, agent-side) are different types with different `model` fields. Use TypeScript's type system or grep for the import to disambiguate.
**Tags:** config, types, rename, agent-config, disambiguation

### Pre-existing tsc errors are expected — project uses tsx runtime
**Date:** 2026-02-22
**Context:** `npm run build` (tsc) shows 400+ errors from missing @types/node
**Lesson:** The AX project runs via tsx, not compiled tsc output. The 400+ tsc errors from missing @types/node are pre-existing and expected. Don't try to fix them — focus on vitest test results instead.
**Tags:** build, typescript, tsx, tsc

### New path helpers must handle colon-separated session IDs
**Date:** 2026-02-22
**Context:** `scratchDir()` used `validatePathSegment()` (alphanumeric/dash/underscore only), but channel session IDs like `test:thread:C02:2000.0001` contain colons and dots
**Lesson:** When adding new path functions that accept session IDs, use `isValidSessionId()` for validation and split colons into nested directories (same pattern as `workspaceDir()`). Don't use `validatePathSegment()` for session IDs — it's only for single-segment identifiers like agent names or user IDs.
**Tags:** paths, session-id, scratchDir, workspaceDir, validation
