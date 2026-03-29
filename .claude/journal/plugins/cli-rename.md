# Plugin CLI Rename Journal

## [2026-03-29 12:05] -- Rename `ax plugin` to `ax provider`, create new `ax plugin` for Cowork (Task 8)

**Task:** Rename the existing npm provider plugin CLI (`ax plugin`) to `ax provider` and create a new `ax plugin` for Cowork plugins.
**What I did:**
1. Created `src/cli/provider.ts` -- a copy of the old `plugin.ts` with all user-facing strings renamed from `ax plugin` to `ax provider`, export `runProvider` instead of `runPlugin`, and internal functions renamed (`providerAdd`, `providerRemove`, `providerList`, `providerVerify`).
2. Rewrote `src/cli/plugin.ts` with new Cowork plugin CLI exposing `install/remove/list` subcommands with `--agent` flag support. Uses `src/plugins/install.ts` and `src/plugins/store.ts`.
3. Updated `src/cli/index.ts`: added `provider` to `CommandHandlers`, `routeCommand` switch, `knownCommands` set, help text, and the `main()` handler map.
4. Updated `.claude/skills/ax-cli/SKILL.md` to reflect both command sets.
**Files touched:**
- `src/cli/provider.ts` (created)
- `src/cli/plugin.ts` (rewritten)
- `src/cli/index.ts` (modified)
- `.claude/skills/ax-cli/SKILL.md` (updated)
- `.claude/journal/plugins/cli-rename.md` (created)
- `.claude/journal/plugins/index.md` (updated)
**Outcome:** Success -- full test suite passes (242 files, 2714 tests, 0 failures).
**Notes:** No existing tests targeted the old plugin CLI, so no test updates were needed. The new `plugin.ts` imports from `src/plugins/install.ts`, `src/plugins/store.ts`, and `src/plugins/mcp-manager.ts` which were all created in earlier tasks.
