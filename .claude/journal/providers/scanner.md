# Scanner Provider Journal

## [2026-03-05 21:00] — Rename promptfoo scanner to guardian + add LLM-based injection detection

**Task:** Replace the misleadingly-named `promptfoo` scanner (which used hand-crafted heuristics, not the promptfoo library) with `guardian` — a two-layer scanner using regex + real LLM classification.

**What I did:**
- Created `src/providers/scanner/guardian.ts` with two-layer architecture: regex first pass, LLM second pass for inputs that pass regex
- Deleted `src/providers/scanner/promptfoo.ts` and its fake ML code (extractFeatures, computeMLScore, OVERRIDE_KEYWORDS, etc.)
- Updated `src/host/provider-map.ts`: `promptfoo` → `guardian`
- Updated `src/host/registry.ts`: scanner now uses manual import pattern (like memory/skills) to pass LLM provider
- Created `tests/providers/scanner/guardian.test.ts` with regex tests, LLM escalation tests, fallback tests, and canary tests
- Updated all config refs: `tests/integration/phase2.test.ts`, `tests/integration/ax-test-power.yaml`
- Updated skills: `.claude/skills/ax/provider-scanner/SKILL.md`, `.claude/skills/acceptance-test/SKILL.md`

**Files touched:**
- Created: `src/providers/scanner/guardian.ts`, `tests/providers/scanner/guardian.test.ts`, `.claude/journal/providers/scanner.md`
- Deleted: `src/providers/scanner/promptfoo.ts`, `tests/providers/scanner/promptfoo.test.ts`
- Modified: `src/host/provider-map.ts`, `src/host/registry.ts`, `tests/integration/phase2.test.ts`, `tests/integration/ax-test-power.yaml`, `.claude/skills/ax/provider-scanner/SKILL.md`, `.claude/skills/acceptance-test/SKILL.md`, `.claude/journal/providers/index.md`

**Outcome:** Success — build passes, all 2325 tests pass, zero remaining `promptfoo` references in src/tests/yaml/skills.

**Notes:** The guardian scanner accepts `CreateOptions { llm?: LLMProvider }` via the same manual-import pattern used by memory and skills providers. The `loadScanner()` helper in registry.ts passes the traced LLM. The `patterns` scanner's `create(config)` signature ignores the extra args, so both scanners work through the same code path.
