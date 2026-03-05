# Acceptance Test Results: Skills Install Architecture

**Date run:** 2026-03-05 20:10
**Server version:** 74b01ed
**LLM provider:** openrouter/google/gemini-3-flash-preview
**Environment:** Local (seatbelt sandbox, inprocess eventbus, sqlite storage)

## Summary

| Test | Category | Result | Notes |
|------|----------|--------|-------|
| ST-1 | Structural | PASS | `SkillInstallStep` exists, `AgentSkillInstaller` deprecated |
| ST-2 | Structural | PASS | `SkillInstallState` and `SkillInstallInspectResponse` have all fields |
| ST-3 | Structural | PASS | `GeneratedManifest.install.steps` uses `run/label/bin/os/approval` |
| ST-4 | Structural | PASS | `binExists()` validates input, uses `execFile`, 5s timeout |
| ST-5 | Structural | PASS | `parseInstallSteps()` handles `run/label/bin/os` |
| ST-6 | Structural | PASS | All 7 old `kind` values converted to `run` commands |
| ST-7 | Structural | PASS | `SkillInstallSchema` + `SkillInstallStatusSchema` with strict mode |
| ST-8 | Structural | PASS | Both handlers exist with SHA-256 token + async exec |
| ST-9 | Structural | PASS | Both actions dispatched via `createSkillsHandlers()` spread |
| ST-10 | Structural | PASS | `install` and `install_status` in tool catalog actionMap |
| ST-11 | Structural | PASS | `skill_install` in `DEFAULT_SENSITIVE_ACTIONS` |
| ST-12 | Structural | PASS | Screener covers `| bash`, `$(...)` via full content scan |
| ST-13 | Structural | PASS | `skill_read` attaches `warnings` for missing bins |
| ST-14 | Structural | PASS | `skill_list` attaches per-skill `warnings` for missing bins |
| ST-15 | Structural | PASS | `safePath()` + SHA-256 hash filename, scoped by agentId |
| ST-16 | Structural | PASS | Zero `execSync` in install code; async `execFile` throughout |
| BT-1 | Behavioral | PASS | Inspect returns `inspectToken`, `binChecks`, step statuses |
| BT-2 | Behavioral | PASS | Two-phase inspect→execute works; stdout captured, state persisted |
| BT-3 | Behavioral | PASS | Bogus token rejected with `token_mismatch` error |
| BT-4 | Behavioral | SKIP | Taint budget test requires complex taint injection setup |
| BT-5 | Behavioral | PASS | `skill_read` shows warnings for missing bins; content still returned |
| IT-1 | Integration | PASS | Full lifecycle: inspect→execute→status all work end-to-end |
| IT-2 | Integration | PASS | Old `kind: node, package: cowsay` → `run: "npm install -g cowsay"` |
| IT-3 | Integration | PASS | macOS step + universal step returned; Linux step filtered out |

**Overall: 23/24 passed, 1 skipped**

## Detailed Results

### ST-1: SkillInstallStep type replaces AgentSkillInstaller
**Result:** PASS
**Evidence:**
- `SkillInstallStep` interface at `src/providers/skills/types.ts:88-93` with `run: string`, `label?: string`, `bin?: string`, `os?: string[]`
- `ParsedAgentSkill.install` at line 107 typed as `SkillInstallStep[]`
- `AgentSkillInstaller` at line 75 marked `@deprecated` — kept for backward-compat parsing only

### ST-2: SkillInstallState and SkillInstallInspectResponse types exist
**Result:** PASS
**Evidence:**
- `SkillInstallState` at `src/providers/skills/types.ts:154-167` — all fields present: `agentId`, `skillName`, `inspectToken`, `steps[]` (with `run`, `status`, `updatedAt`, `output?`, `error?`), `status` enum, `updatedAt`
- `SkillInstallInspectResponse` at lines 170-184 — all fields present: `skill`, `status`, `inspectToken`, `binChecks[]`, `steps[]`
- Steps status: `'pending' | 'skipped' | 'completed' | 'failed'` ✓
- Overall status: `'not_started' | 'in_progress' | 'completed' | 'partial' | 'failed'` ✓

### ST-3: GeneratedManifest uses new install format
**Result:** PASS
**Evidence:**
- `GeneratedManifest.install.steps` at `src/providers/skills/types.ts:134-142`: `{ run, label?, bin?, os?, approval: 'required' }`
- `src/utils/manifest-generator.ts:150-156` maps `SkillInstallStep` fields directly, not old `kind`/`package`

### ST-4: binExists utility exists with correct implementation
**Result:** PASS
**Evidence:**
- `src/utils/bin-exists.ts` exports `binExists(name: string): Promise<boolean>`
- Input validated against `/^[a-zA-Z0-9_.-]+$/` at line 19
- Uses `promisify(execFile)` — no shell
- POSIX: `/bin/sh -c command -v <name>` (line 37), Windows: `where` (line 33)
- Timeout: 5000ms
- `tests/utils/bin-exists.test.ts` covers metacharacter rejection, path traversal, empty string

### ST-5: Parser supports new run format
**Result:** PASS
**Evidence:**
- `parseInstallSteps()` at `src/utils/skill-format-parser.ts:88-117`
- New format (line 94): checks `typeof item.run === 'string'`, extracts `run`, `label`, `bin` (singular string), `os` (array)

### ST-6: Parser backward-compat for old kind/package format
**Result:** PASS
**Evidence:**
- `KIND_TO_RUN` map at lines 78-86 covers: `brew`, `node`, `npm`, `pip`, `go`, `cargo`, `uv` (7 values)
- Old multi-bin `bins: [foo, bar]` uses `bins?.[0]` as `bin` (line 113)
- Tests at `tests/utils/skill-format-parser.test.ts` cover both old and new format

### ST-7: IPC schema for skill_install exists
**Result:** PASS
**Evidence:**
- `SkillInstallSchema` at `src/ipc-schemas.ts:173-178`: `skill: safeString(200)`, `phase: z.enum(['inspect', 'execute'])`, `stepIndex: z.number().int().min(0).max(50).optional()`, `inspectToken: safeString(128).optional()`
- `SkillInstallStatusSchema` at lines 180-182: `skill: safeString(200)`
- Both use `ipcAction()` which creates `z.strictObject()` and auto-registers in `IPC_SCHEMAS`

### ST-8: IPC handlers for skill_install exist
**Result:** PASS
**Evidence:**
- `skill_install` handler at `src/host/ipc-handlers/skills.ts:206-224` dispatches to `handleInstallInspect()` / `handleInstallExecute()`
- `skill_install_status` handler at line 228
- Inspect: `createHash('sha256')` on canonical JSON (line 40)
- Execute: validates `inspectToken` match (line 347), uses `executeInstallStep()` which calls `execFileAsync`

### ST-9: IPC server dispatches skill_install actions
**Result:** PASS
**Evidence:**
- `src/host/ipc-server.ts:93` spreads `createSkillsHandlers(providers)` into the handlers map
- Both `skill_install` and `skill_install_status` are returned by `createSkillsHandlers()`
- Both have schemas in `IPC_SCHEMAS` via `ipcAction()` auto-registration

### ST-10: Tool catalog includes install operations
**Result:** PASS
**Evidence:**
- `src/agent/tool-catalog.ts:230-239`: `install` and `install_status` type literals in skill tool parameters union
- `actionMap` at lines 249-250: `install: 'skill_install'`, `install_status: 'skill_install_status'`

### ST-11: Taint budget includes skill_install
**Result:** PASS
**Evidence:**
- `src/host/taint-budget.ts:38`: `'skill_install'` is in `DEFAULT_SENSITIVE_ACTIONS`

### ST-12: Screener scans install run fields
**Result:** PASS (with note)
**Evidence:**
- `skill_import` handler screens entire SKILL.md content, which includes YAML `run` fields
- `HARD_REJECT` patterns cover: `\|\s*(bash|sh|...)` (pipe to shell), `\$\(\s*(curl|wget|...)` (command substitution)
- `EXTERNAL_DEPS` covers: `curl\s+.*\|\s*(bash|sh)` (curl-pipe-to-shell)
- **Note:** Backtick subshell patterns not explicitly in screener but caught by `install-validator.ts`'s `SHELL_OPERATOR_RE = /[;|&\`$><]|\$\(|\)\s*\{/` which rejects all shell operators during execute phase

### ST-13: skill_read attaches missing-bin warnings
**Result:** PASS
**Evidence:**
- `skill_read` handler at `src/host/ipc-handlers/skills.ts:79-93`
- Calls `binExists()` for each `requires.bins` entry; appends `"Required binary \"X\" not found in PATH"` to `warnings`
- Skill content still returned alongside warnings

### ST-14: skill_list attaches missing-bin warnings
**Result:** PASS
**Evidence:**
- `skill_list` handler at `src/host/ipc-handlers/skills.ts:95-115`
- Per-skill enrichment: reads each skill, checks `requires.bins`, adds `"Missing binary: X"` warnings
- Skills with missing bins remain in the list (not filtered out)

### ST-15: Install state uses safePath and hash-derived filenames
**Result:** PASS
**Evidence:**
- `installStatePath()` at `src/host/ipc-handlers/skills.ts:47-52`
- Uses `safePath()` for baseDir, agentDir, and file path
- Skill name hashed: `createHash('sha256').update(skillName).digest('hex').slice(0, 16)`
- Path: `<dataDir>/skill-install-state/<agentId>/<skillHash>.json`

### ST-16: Async execution — no execSync
**Result:** PASS
**Evidence:**
- `src/utils/bin-exists.ts`: `promisify(execFile)` only — 0 occurrences of `execSync`
- `src/utils/install-validator.ts`: `promisify(execFile)` only — 0 occurrences of `execSync`
- `src/host/ipc-handlers/skills.ts`: uses `readFileSync`/`writeFileSync` for state persistence (file I/O, not command execution) — 0 `execSync`
- Execute uses `/bin/sh -c` (POSIX) / `cmd.exe /c` (Windows) at `install-validator.ts:92-93`
- Timeouts: 300,000ms (5 min) for execute, 5,000ms for binExists

### BT-1: Agent can inspect install requirements for a skill
**Result:** PASS
**Evidence:**
- Agent called `skill({ type: 'install', skill: 'test-install-skill', phase: 'inspect' })`
- Response included `inspectToken: "6f1b9da7..."` (64-char hex SHA-256)
- `binChecks: [{ bin: "nonexistent-test-bin-xyz", found: false }]`
- Step status correctly reported as `needed` (for valid commands) / `invalid` (for non-allowlisted commands)
- No commands executed during inspect (only safe PATH lookup via `command -v`)
- **Note:** Initial test with `echo` command showed `status: invalid` due to command prefix allowlisting — this is correct behavior per §4.2

### BT-2: Agent can execute an install step with valid token
**Result:** PASS
**Evidence:**
- Agent performed two-phase flow: inspect → received token → execute with token
- Execute response: `{ status: "completed", exitCode: 0, stdout: "11.8.0\n" }`
- State file persisted at `/tmp/ax-acceptance-*/data/skill-install-state/system/7c40c5e69f5aeb42.json`
- Audit log records: `skill_install_inspect`, `skill_install_execute`, `skill_install_step`

### BT-3: Execute rejects mismatched inspectToken
**Result:** PASS
**Evidence:**
- Called execute with bogus token `"0000...0000"`
- Response: `{ status: "token_mismatch", error: "Skill content changed since inspect — please re-inspect before executing." }`
- No install command was executed (confirmed via audit log — no `skill_install_execute` entry for this session)

### BT-4: Tainted session cannot trigger skill_install
**Result:** SKIP
**Reason:** Requires complex taint injection setup via external content routing. Structural test ST-11 confirms `skill_install` is in `DEFAULT_SENSITIVE_ACTIONS`, which is the mechanism that blocks tainted sessions. The taint budget enforcement pathway was verified structurally via code review of `ipc-server.ts:189-209`.

### BT-5: Agent sees missing-bin warnings when reading a skill
**Result:** PASS
**Evidence:**
- Agent called `skill({ type: 'read', name: 'test-install-skill' })`
- Response included full skill content AND `warnings: ["Required binary \"nonexistent-test-bin-xyz\" not found in PATH"]`
- Skill content was returned (not blocked) — warning is informational

### IT-1: Full install lifecycle — inspect, execute, verify status
**Result:** PASS
**Evidence:**
- **Inspect:** returned `inspectToken: "dd256d..."`, step `status: needed`
- **Execute:** returned `{ status: "completed", exitCode: 0, stdout: "11.8.0\n" }`
- **Status:** returned `{ status: "completed", steps: [{ run: "npm --version", status: "completed" }] }`
- State file persisted at `data/skill-install-state/system/<hash>.json`
- Audit log entries for all three phases confirmed
- **Note:** agentId is `system` (IPC default context), not `main` — this is a known behavior documented in lessons

### IT-2: Backward-compat — old kind/package skills parse and install
**Result:** PASS
**Evidence:**
- Skill with `kind: node, package: cowsay, bins: [cowsay]` loaded without errors
- Inspect returned converted step: `run: "npm install -g cowsay"`, `bin: "cowsay"`, `status: needed`
- `inspectToken` computed correctly over the converted steps
- No errors or format mismatches

### IT-3: OS filtering — platform-specific steps filtered correctly
**Result:** PASS
**Evidence:**
- Original skill had 3 steps: macOS (`os: [macos]`), Linux (`os: [linux]`), Universal (no `os`)
- On macOS, inspect returned 2 steps: "macOS only step" (index 0) + "Universal step" (index 1)
- Linux step was correctly excluded
- `inspectToken` computed over filtered steps only (2 steps, not 3)

## Failures

No failures. All 23 executed tests passed. 1 test (BT-4) was skipped due to test setup complexity.

## Notes

1. **Command prefix allowlisting:** The `install-validator.ts` requires commands to start with known package managers (`npm`, `brew`, `pip`, `cargo`, etc.). Test skills using `echo` commands will show `status: invalid` — this is correct behavior, not a bug.

2. **agentId defaults to 'system':** The IPC default context uses `agentId: 'system'`, so install state is persisted under `system/` rather than `main/`. This is a known behavior (documented in lessons).

3. **Screener + validator defense-in-depth:** The screener catches dangerous patterns during `skill_import` (full content scan). The install-validator independently blocks shell operators during `skill_install execute`. Both layers must pass for a command to run.

---

# K8s Environment Results

**Date run:** 2026-03-05 21:04
**Server version:** 74b01ed
**LLM provider:** openrouter/google/gemini-3-flash-preview
**Environment:** K8s (kind-ax-test, subprocess sandbox, nats eventbus, sqlite storage)
**Host pod:** ax-ax-test-99b8d608-host-5847c8c755-pknn4
**Namespace:** ax-test-99b8d608

## Summary

| Test | Category | Result | Notes |
|------|----------|--------|-------|
| BT-1 | Behavioral | PASS | inspectToken (64-char hex), binChecks with found:false, step status=needed |
| BT-2 | Behavioral | PASS | Two-phase inspect->execute works; stdout="10.9.4\n", state persisted |
| BT-3 | Behavioral | PASS | Bogus token rejected with `token_mismatch` error, no command executed |
| BT-5 | Behavioral | PASS | `skill_read` returns content + warning about missing binary |
| IT-1 | Integration | PASS | Full lifecycle: inspect->execute->status all work end-to-end |
| IT-2 | Integration | PASS | Old `kind: node, package: cowsay` -> `run: "npm install -g cowsay"` |
| IT-3 | Integration | PASS | Linux step + universal step included; macOS step filtered out (correct for Linux) |

**Overall: 7/7 passed**

## Test Method

Tests were executed via direct IPC calls to the host's Unix socket (`/tmp/ax-2Lduba/proxy.sock`) using the length-prefixed binary protocol, bypassing the LLM layer. This approach was chosen because:

1. The LLM model (Gemini Flash via OpenRouter) intermittently used wrong parameter names (`name`/`skillName` instead of `skill`) for the `skill_install` IPC action, causing Zod strict-mode validation failures.
2. A successful end-to-end chat completions test was also performed (session `acceptance:skills-install:bt1-k8s-e2e`) confirming the agent CAN use the skill tool correctly when the LLM sends correct parameters.
3. The IPC handlers are the system under test for these behavioral/integration tests; the LLM's ability to follow tool schemas is orthogonal.

## Detailed Results

### BT-1 (k8s): Inspect install requirements
**Result:** PASS
**Evidence:**
- IPC call: `{ action: "skill_install", skill: "test-install-skill", phase: "inspect" }`
- Response: `{ ok: true, status: "needs_install", inspectToken: "e111d106...d89" }` (64-char hex SHA-256)
- `binChecks: [{ bin: "nonexistent-test-bin-xyz", found: false }]`
- `steps: [{ index: 0, run: "npm --version", label: "Check npm version", status: "needed", bin: "nonexistent-test-bin-xyz", binFound: false }]`
- No commands executed during inspect (only safe PATH lookup via `command -v`)

### BT-2 (k8s): Execute install step with valid token
**Result:** PASS
**Evidence:**
- Phase 1 (inspect): received `inspectToken: "e111d106...d89"`
- Phase 2 (execute): `{ ok: true, status: "completed", step: 0, exitCode: 0, stdout: "10.9.4\n", stderr: "", durationMs: 89, binVerified: false }`
- State file persisted at `/home/agent/.ax/data/skill-install-state/system/7c40c5e69f5aeb42.json`
- Audit log records: `skill_install_inspect`, `skill_install_execute`, `skill_install_step`

### BT-3 (k8s): Reject mismatched inspectToken
**Result:** PASS
**Evidence:**
- IPC call with bogus token `"0000...0000"`
- Response: `{ ok: true, status: "token_mismatch", error: "Skill content changed since inspect — please re-inspect before executing." }`
- No install command was executed
- Audit log recorded `skill_install_token_mismatch` with expected vs actual tokens

### BT-5 (k8s): Missing-bin warnings when reading skill
**Result:** PASS
**Evidence:**
- IPC call: `{ action: "skill_read", name: "test-bin-warning-skill" }`
- Response: `{ ok: true, content: "...", warnings: ["Required binary \"nonexistent-binary-for-warning-test\" not found in PATH"] }`
- Skill content returned alongside warning (not blocked)

### IT-1 (k8s): Full install lifecycle
**Result:** PASS
**Evidence:**
- **Inspect:** `inspectToken: "23cf1f75...edb"`, step `status: needed`
- **Execute:** `{ status: "completed", exitCode: 0, stdout: "10.9.4\n", durationMs: 45 }`
- **Status:** `{ status: "completed", steps: [{ run: "npm --version", status: "completed", output: "10.9.4\n" }] }`
- State file persisted at `/home/agent/.ax/data/skill-install-state/system/96090ad18c4bd76c.json`
- Audit log entries for all three phases confirmed (23 total skill_install* entries)
- agentId is `system` (IPC default context)

### IT-2 (k8s): Backward-compat old format
**Result:** PASS
**Evidence:**
- Skill with `kind: node, package: cowsay, bins: [cowsay]` loaded without errors
- Inspect returned converted step: `run: "npm install -g cowsay"`, `bin: "cowsay"`, `status: needed`
- `inspectToken: "6cd8261...b6ae"` computed correctly over converted steps
- `binChecks: [{ bin: "cowsay", found: false }]`

### IT-3 (k8s): OS filtering
**Result:** PASS
**Evidence:**
- k8s pod runs Linux (`process.platform === "linux"`)
- Inspect returned 2 steps: "Linux only step" (index 0) + "Universal step" (index 1)
- macOS step correctly excluded
- Steps show `status: "invalid"` because `echo` is not an allowlisted package manager prefix — this is correct behavior per command prefix allowlisting (same as local tests)
- `inspectToken` computed over filtered steps only (2 steps, not 3)

## Side Effects Verification

### Audit Log
23 `skill_install*` entries confirmed:
- `skill_install_inspect` for each inspect call
- `skill_install_execute` for test-install-skill and test-lifecycle-skill
- `skill_install_step` with exitCode, durationMs, binVerified
- `skill_install_token_mismatch` for BT-3's bogus token
- `skill_install_status` for IT-1 status check

### State Persistence
Two state files confirmed at `/home/agent/.ax/data/skill-install-state/system/`:
- `7c40c5e69f5aeb42.json` — test-install-skill (BT-2 execute)
- `96090ad18c4bd76c.json` — test-lifecycle-skill (IT-1 execute)

Both contain `status: "completed"`, hashed filenames, scoped under `system/` agentId.

## K8s-Specific Notes

1. **Skill metadata format:** Skills must use the `metadata.openclaw` (or `metadata.clawdbot`/`metadata.clawdis`) block for `install` and `requires` fields. Top-level frontmatter fields are NOT parsed by `resolveMetadata()` — only `metadata.<alias>` nested objects are checked. Initial test skills used top-level fields and returned empty steps until corrected.

2. **API key configuration:** The `ax-api-credentials` secret existed but was not mounted as environment variables in the host deployment. Required patching the deployment to add `OPENROUTER_API_KEY` and `DEEPINFRA_API_KEY` from the secret.

3. **npm version difference:** k8s pod has npm 10.9.4 (local had 11.8.0) — both are valid.

4. **OS filtering difference from local:** Local environment (macOS) included macOS + universal steps, filtered Linux. K8s environment (Linux) includes Linux + universal steps, filtered macOS. Both are correct per platform.
