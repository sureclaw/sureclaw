# Provider Lessons: Web

## Splitting a provider category has massive blast radius
**Date:** 2026-03-20
**Context:** Splitting `web` into `web_extract` + `web_search` categories, changing Config.providers.web from string to nested object
**Lesson:** When splitting a provider category (changing Config type from `web: string` to `web: { extract, search }`), expect to update: (1) all YAML config fixtures in tests/ and charts/, (2) all mock ProviderRegistry objects in integration tests, (3) all mock Config objects in unit tests, (4) provider-sdk interfaces and test harness, (5) onboarding wizard and its tests. Use `grep -r` to find ALL references before starting — the config.test.ts file alone had 10+ inline YAML blocks to update.
**Tags:** provider-split, config-change, blast-radius, testing

## disabledProvider() proxy throws synchronously, not as rejected promise
**Date:** 2026-03-20
**Context:** Writing none-extract and none-search stubs using disabledProvider()
**Lesson:** `disabledProvider()` returns a Proxy that throws synchronously from the method call, not as a rejected promise. Test with `expect(() => provider.method()).toThrow()`, not `await expect(provider.method()).rejects.toThrow()`.
**Tags:** disabled-provider, proxy, testing, async
