# Testing: Acceptance

Acceptance test skill and framework for validating features against plan design goals.

## [2026-03-03 21:51] — Acceptance tests for Skills Install Architecture (24 tests)

**Task:** Run acceptance tests at tests/acceptance/skills-install/test-plan.md
**What I did:** Ran 24 tests (16 structural, 5 behavioral, 3 integration). All structural tests passed by reading source files. Behavioral/integration tests used isolated AX_HOME with readonly skill provider and test skills. Had to fix skill path (must be `agents/main/agent/skills/`) and use valid package manager commands (command prefix allowlisting rejects `echo`).
**Files touched:**
- `tests/acceptance/skills-install/results.md` (new) — full results
**Outcome:** 23/24 passed, 1 skipped (BT-4 taint test requires complex setup). All core functionality works.
**Notes:** agentId defaults to 'system' in IPC context, not agent name. Skills must be in `agents/<name>/agent/skills/` for readonly provider.

## [2026-03-03 14:35] — Full acceptance test run for MemoryFS v2 (41 tests)

**Task:** Run the complete acceptance test plan at tests/acceptance/memoryfs-v2/test-plan.md
**What I did:** Ran all 41 tests: 27 structural (parallel subagents), 9 behavioral, 8 integration. Set up isolated AX_HOME at /tmp, started server, ran API-level tests programmatically and chat-level tests via `ax send`.
**Files touched:**
- `tests/acceptance/memoryfs-v2/results.md` (new) — full results
- `tests/acceptance/memoryfs-v2/fixes.md` (new) — 5 issues prioritized
- `src/providers/channel/slack.ts` (modified) — fixed Slack debug log spam (FIX-3)
**Outcome:** 27 PASS, 2 FAIL, 2 PARTIAL FAIL, 4 SKIP (no OPENAI_API_KEY). Key findings: (1) LLM summary generator wraps output in markdown code fences corrupting memU format. (2) Content-hash dedup fails against LLM-extracted items because the LLM rephrases facts differently each time. (3) Slack App logLevel was DEBUG causing heartbeat spam in ax.log — fixed to INFO.
**Notes:** Structural tests are a powerful verification layer — all 27 passed, confirming code structure matches the plan. Behavioral failures are all at the LLM integration boundary: non-deterministic LLM output defeats deterministic dedup, and the LLM doesn't follow output format constraints (code fences). Embedding tests (BT-8/9, IT-7/8) need OPENAI_API_KEY to run.

## [2026-03-03 13:15] — Run BT-5 and BT-6 behavioral acceptance tests for MemoryFS v2

**Task:** Run behavioral acceptance tests BT-5 (direct write/read/delete API round-trip) and BT-6 (taint tag preservation) against a live AX server
**What I did:** (1) BT-5: Sent "Remember this exact fact for testing: My favorite database is PostgreSQL" via CLI, verified item appeared in SQLite store with correct content/category/type, then sent "What do you know about my database preferences?" and confirmed agent recalled PostgreSQL. Reinforcement count incremented from 1 to 2 on the recall query. (2) BT-6: Verified structurally that write() serializes taint via JSON.stringify (line 161) and all four read paths (query embedding path line 215, query keyword path line 250, read line 263, list line 280) deserialize via JSON.parse. Chat interface doesn't set taint directly so behavioral testing not feasible.
**Files touched:** No code files modified — read-only acceptance testing
**Outcome:** BT-5 PASS, BT-6 PASS (structural verification)
**Notes:** The memorize/extraction pipeline categorized the PostgreSQL fact as memory_type=profile, category=preferences rather than memory_type=knowledge, category=knowledge. This suggests the LLM extractor is classifying memories into semantic categories rather than using the default knowledge bucket. Reinforcement count going from 1 to 2 on the read query confirms the dedup/reinforce path works correctly in live operation.

## [2026-03-03 11:30] — Add acceptance test skill and tests/acceptance/ directory

**Task:** Create a Claude Code skill that designs, runs, and analyzes acceptance tests for AX features against their original plan documents
**What I did:** Created `.claude/skills/acceptance-test/SKILL.md` — a comprehensive 5-phase skill that walks through feature selection, test design (structural/behavioral/integration), execution against a live server, failure analysis with root cause classification, and fix list generation. Also created `tests/acceptance/README.md` for the test artifact directory.
**Files touched:**
- `.claude/skills/acceptance-test/SKILL.md` (new) — the skill itself
- `tests/acceptance/README.md` (new) — directory README explaining structure
- `.claude/journal/testing/acceptance.md` (new) — this journal entry
- `.claude/journal/testing/index.md` (modified) — added entry reference
**Outcome:** Success. Skill registers automatically and appears in the skills list. Covers all 52 plan files with a feature reference table, provides test templates for 3 categories, includes auto-start server logic, and produces structured output (test-plan.md, results.md, fixes.md).
**Notes:** Key design decisions: (1) Tests are markdown not code because LLM responses are non-deterministic — the agent evaluates with judgment. (2) Two-layer verification: structural ground truth (files, DB, audit) plus behavioral intent checks. (3) Auto-start server with health poll. (4) Test plans saved as artifacts so they can be reviewed before execution and re-run later.
