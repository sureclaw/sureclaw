## [2026-03-20 18:10] — Split monolithic WebProvider into fetch/extract/search

**Task:** Split `WebProvider` (fetch + search) into three independent operations: raw fetch (hardcoded), configurable text extraction, and configurable web search with independent provider selection.
**What I did:**
- Created `WebExtractProvider` and `WebSearchProvider` interfaces in `types.ts`
- Implemented `tavily-extract.ts`, `tavily-search.ts`, `brave-search.ts` providers
- Created `none-extract.ts` and `none-search.ts` disabled stubs
- Updated provider map: `web` → `web_extract` + `web_search` categories
- Updated `Config` type: `web: string` → `web: { extract, search }`
- Updated `ProviderRegistry`: `web` → `webFetch`, `webExtract`, `webSearch`
- Updated config schema, registry loading, IPC handlers, tool catalog (added `extract` variant)
- Added `WebExtractSchema` to IPC schemas
- Updated onboarding defaults, wizard, all YAML fixtures, all test mocks
- Deleted old `tavily.ts`, `none.ts`, and their tests
- Updated `ax-provider-web` skill and provider-sdk interfaces/harness
**Files touched:** 40+ files across src/ and tests/
**Outcome:** Success — clean build, all 2475 tests pass
**Notes:** Massive blast radius due to Config type change. Every test file with a mock Config or mock ProviderRegistry needed updating. YAML fixtures in integration tests, helm values, and flux releases also needed updating.
