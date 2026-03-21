# Scanner Provider Journal

## [2026-03-20 23:10] — Fix scanner false-positive blocking SOUL.md identity writes

**Task:** Debug why identity/soul changes are not persisting in the kind k8s cluster — agent keeps re-bootstrapping every session.
**What I did:**
- Traced the identity persistence flow: DocumentStore → stdin payload → agent prompt
- Found SOUL.md missing from PostgreSQL documents table while IDENTITY.md existed
- Checked audit_log: every SOUL.md write had `decision: scanner_blocked, verdict: BLOCK`
- Root cause: Guardian scanner's injection-detection regex patterns (`override your safety`, `bypass the restrictions`) false-positive on SOUL.md content, which naturally uses behavioral boundary language
- Fix: Made scanner source-aware — `identity_mutation` and `user_mutation` sources skip injection regex but still run credential/PII checks (OUTPUT_PATTERNS)
- Added 4 tests: identity_mutation passes clean SOUL.md, identity_mutation blocks credentials, user_mutation skips injection regex, non-identity source still blocks injection
- Cleaned up stale BOOTSTRAP.md from PostgreSQL so agent runs normally
- Built new Docker image, loaded into kind cluster, restarted host + sandbox pods
**Files touched:**
- Modified: `src/providers/scanner/guardian.ts`, `tests/providers/scanner/guardian.test.ts`
**Outcome:** Success — all 2507 tests pass, scanner now correctly allows identity writes while maintaining credential/PII protection
**Notes:** The taint budget already blocks identity writes in tainted sessions (injection-through-manipulation). The scanner adding injection regex on top was defense-in-depth that backfired — SOUL.md content is semantically identical to injection patterns ("never override your safety", "never bypass restrictions").

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
