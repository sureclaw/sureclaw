# Config: Plugins

Plugin declarations and auth config in ax.yaml configuration.

## [2026-04-05] — Add auth config defaults to ConfigSchema

**Task:** Add Zod schema fields for auth providers and auth config block so strict mode doesn't reject them
**What I did:** Added `providers.auth` as `z.array(providerEnum('auth')).optional()` and top-level `auth` as optional strictObject with `better_auth` sub-config (google OAuth + allowed_domains)
**Files touched:** `src/config.ts`
**Outcome:** Success — tsc compiles clean, all 2885 tests pass
**Notes:** Auth is opt-in: both fields default to undefined. No behavior change for existing configs without auth fields.

## [2026-03-29 11:50] — Add per-agent plugins config field to ax.yaml

**Task:** Implement Task 9 from the Cowork plugin integration plan: add `plugins` config field
**What I did:** Added `PluginDeclaration` interface to `src/types.ts` and `plugins` optional field to the `Config` interface. Added corresponding Zod validation schema in `src/config.ts` with `z.strictObject` for each entry (source: string 1-1000 chars, agents: array of strings 1-100 chars, min 1 agent).
**Files touched:** `src/types.ts`, `src/config.ts`
**Outcome:** Success — all 2667 tests pass, no regressions
**Notes:** Field is optional so no existing configs or tests break. Uses `z.strictObject` for plugin entries consistent with the rest of the schema.
