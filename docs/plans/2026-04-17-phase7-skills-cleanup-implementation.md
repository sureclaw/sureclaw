# Phase 7 — Skills Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task.

**Goal:** Remove the legacy plugin-manifest install path + ClawHub skill download now that phases 1–6 provide a git-native authoring flow + dashboard approvals.

**Architecture:** This is a deletion/simplification phase — no new features. Skills are now authored as files in `.ax/skills/`, reconciled by git hooks (phase 2), indexed from frontmatter (phase 3), wired into the MCP proxy (phase 4), surfaced on the dashboard (phase 5), and unlocked via OAuth (phase 6). The agent no longer needs `skill_install` / `skill_create` / `skill_update` / `skill_delete` IPC actions — it just edits files and commits. The ClawHub registry client, plugin manifest parser, and plugin-install CLI go with it. We keep the generic MCP connection manager (`src/plugins/mcp-manager.ts`, `src/plugins/mcp-client.ts`) and `loadDatabaseMcpServers` because phase-4 MCP wiring depends on them — a later refactor can rename the directory.

**Tech Stack:** TypeScript, Vitest, Kysely migrations, existing IPC/Zod schemas.

---

## Scope Decisions (read before starting)

### Removed

- **IPC actions:** `skill_install`, `skill_create`, `skill_update`, `skill_delete`. All four go — the git-native flow handles create/update/delete via `.ax/skills/` commits.
  - `skills_index` stays (agent pulls authoritative list from host).
  - `credential_request` stays (ad-hoc credential paste).
- **`skill` tool (agent):** entire tool removed from `src/agent/tool-catalog.ts` — no more `skill({ type: "install" | "create" | "update" | "delete" })`.
- **ClawHub registry:** `src/clawhub/registry-client.ts` + test + e2e mock.
- **Legacy plugin manifests:** `src/plugins/{fetcher,install,parser,store,types}.ts` + corresponding tests. Strip `reloadPluginMcpServers` + `autoInstallDeclaredPlugins` from `src/plugins/startup.ts` (keep `loadDatabaseMcpServers`).
- **Legacy skill storage:** `src/providers/storage/skills.ts` + test (DocumentStore-backed skill writes).
- **CLI commands:** `src/cli/plugin.ts`, `src/cli/mcp.ts` + CLI registration + help text.
- **Admin endpoints:** plugin list / install / uninstall routes in `src/host/server-admin.ts`, admin plugin fields in `AdminDeps`.
- **Prompt guidance:** `detectSkillInstallIntent`, `REGISTRY_REF`, and the "Installing New Skills" block from `src/agent/prompt/modules/skills.ts`. Remove `skillInstallEnabled` from `PromptContext`.
- **Retired DB data:** `documents` rows with `kind IN ('plugins', 'skills')` — cleaned up via a new migration.

### Kept

- `src/plugins/mcp-manager.ts`, `src/plugins/mcp-client.ts` — generic MCP connection machinery. Phase-4 MCP applier, server-init, inprocess, database MCP provider all import these.
- `src/plugins/startup.ts::loadDatabaseMcpServers` — loads MCP servers from the `mcp_servers` DB table (phase-4 wiring).
- `src/host/credential-placeholders.ts`, `src/host/proxy-domain-list.ts`, `src/providers/credentials/*`, `src/host/oauth*.ts` — unchanged.

### Exit Criteria

1. `rg "skill_install|skill_create|skill_update|skill_delete|DocumentStore.*skill|clawhub" src/ tests/` returns zero hits (outside this plan doc + CHANGELOG-style journal entries).
2. `npm run build` clean.
3. `npm test -- --run` returns no NEW failures (pre-existing macOS socket-path failures OK).
4. README.md "Install a skill" section describes the git-native flow + dashboard.
5. `.claude/skills/ax/cli.md` + `host.md` reflect removed commands / handlers.

---

## Task 1 — Remove Skill Tool & IPC Handlers (Install/Create/Update/Delete)

**Files:**
- Modify: `src/ipc-schemas.ts` (remove SkillInstallSchema, SkillCreateSchema, SkillUpdateSchema, SkillDeleteSchema + their registrations)
- Modify: `src/host/ipc-handlers/skills.ts` (remove skill_install/skill_create/skill_update/skill_delete handlers and their imports from `../../clawhub/registry-client.js`, `../../utils/manifest-generator.js`, `../../providers/storage/skills.js`, `../server-admin-helpers.js`, `../../utils/skill-format-parser.js`)
- Modify: `src/agent/tool-catalog.ts` (remove the entire `skill` tool block with `category: 'skill'`)
- Modify: `src/agent/mcp-server.ts` (remove the `skill` tool registration + actionMap)
- Delete: `tests/host/ipc-handlers/skills.test.ts`
- Modify: `tests/host/post-agent-credential-detection.test.ts` (remove `skill_install` schema assertion block near line 41)
- Modify: `tests/agent/tool-catalog.test.ts` (remove tests for skill tool install/create/update/delete variants — keep the file if other tool tests live there)
- Modify: `tests/agent/mcp-server.test.ts` (remove any `skill` tool assertions)
- Modify: `tests/agent/ipc-tools.test.ts` (remove `skill_install` path assertions)

**Step 1: Audit all skill_* and `skill` tool references**

```bash
rg "skill_install|skill_create|skill_update|skill_delete|category: 'skill'" --type ts src tests
```

Expected: entries in the files listed above.

**Step 2: Remove schemas in `src/ipc-schemas.ts`**

Delete the `SkillInstallSchema`, `SkillCreateSchema`, `SkillUpdateSchema`, `SkillDeleteSchema` declarations (around lines 118–138). Remove the same names from the `IPC_SCHEMAS` map / `allSchemas` array further down. Keep `SkillsIndexSchema` and `CredentialRequestSchema`.

**Step 3: Remove handlers in `src/host/ipc-handlers/skills.ts`**

Keep only `skills_index`, `audit_query`, and `credential_request`. Drop imports that were only used by the removed handlers (ClawHub client, manifest generator, storage skills, skill-format-parser if no longer used, isAdmin). Resulting file should be ~80 lines.

Update the `SkillsHandlerOptions` interface — `stateStore` is still needed for `skills_index`; `domainList` becomes optional/unused, `adminCtx` is unused. Remove whatever becomes dead.

**Step 4: Remove the `skill` tool from `src/agent/tool-catalog.ts`**

Delete the entire `skill` tool definition (lines ~167–210). The agent catalogue shrinks by one tool. No shim, no deprecation — this tool is gone.

**Step 5: Update `src/agent/mcp-server.ts`**

Remove the skill tool action-map (around line 147) and the tool registration for the `skill` tool. If there's a handler shim, drop it. Verify MCP server still exports a valid tool list.

**Step 6: Update or delete tests**

- `tests/host/ipc-handlers/skills.test.ts` → **delete entirely** (it's 100% skill_install tests)
- `tests/host/post-agent-credential-detection.test.ts` → remove the `describe('skill_install IPC schema', …)` block near line 41. Keep the rest.
- `tests/agent/tool-catalog.test.ts` → remove the 4 tests for skill tool variants (grep for `skillInstallEnabled=true includes skill tool with install action` and similar). Keep unrelated tests.
- `tests/agent/mcp-server.test.ts` → update any assertion that a `skill` tool is registered.
- `tests/agent/ipc-tools.test.ts` → remove `skill_install` path assertions (lines 107, 129). Keep surrounding tests.

**Step 7: Run build**

```bash
npm run build 2>&1 | tail -20
```

Expected: `tsc` clean. If it complains about unused imports or missing references, fix them by deleting the imports.

**Step 8: Run targeted tests**

```bash
npx vitest run tests/host/ipc-handlers/ tests/agent/tool-catalog.test.ts tests/agent/mcp-server.test.ts tests/agent/ipc-tools.test.ts tests/host/post-agent-credential-detection.test.ts
```

Expected: all pass or clearly show only pre-existing failures unrelated to our changes.

**Step 9: Commit**

```bash
git add -A
git commit -m "refactor(skills): remove skill_install/create/update/delete IPC + agent tool"
```

---

## Task 2 — Delete ClawHub Registry + Legacy Skill DocumentStore

**Files:**
- Delete: `src/clawhub/registry-client.ts`
- Delete: `src/clawhub/` (if empty after)
- Delete: `tests/clawhub/registry-client.test.ts`
- Delete: `tests/clawhub/` (if empty after)
- Delete: `src/providers/storage/skills.ts`
- Delete: `tests/providers/storage/skills.test.ts`
- Modify: `tests/e2e/mock-server/clawhub.ts` — delete file
- Modify: `tests/e2e/mock-server/index.ts` — remove clawhub mock registration
- Modify: `tests/e2e/global-setup.ts` — remove clawhub references

**Step 1: Verify no remaining importers**

```bash
rg "clawhub/registry-client|providers/storage/skills" src tests
```

Expected (after Task 1): no hits in `src/`. Remaining hits are the files we're about to delete + maybe tests that reference these — they should also be deleted or migrated.

**Step 2: Delete files**

```bash
git rm src/clawhub/registry-client.ts
git rm tests/clawhub/registry-client.test.ts
git rm src/providers/storage/skills.ts
git rm tests/providers/storage/skills.test.ts
git rm tests/e2e/mock-server/clawhub.ts
rmdir src/clawhub 2>/dev/null || true
rmdir tests/clawhub 2>/dev/null || true
```

**Step 3: Remove e2e mock wiring**

Open `tests/e2e/mock-server/index.ts` and `tests/e2e/global-setup.ts`. Delete any import of the deleted clawhub mock and any route registration for `/clawhub`. Nothing else should reference it.

```bash
rg "clawhub" tests/e2e
```

Expected: no hits.

**Step 4: Build + grep**

```bash
npm run build 2>&1 | tail -10
rg "clawhub|providers/storage/skills" src tests
```

Expected: build clean; grep returns zero hits.

**Step 5: Run tests affected by e2e setup**

```bash
npx vitest run tests/e2e
```

Expected: passes (or only pre-existing failures).

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor(skills): delete ClawHub registry client + legacy skill DocumentStore"
```

---

## Task 3 — Strip Legacy Plugin Machinery (keep MCP manager)

**Files:**
- Delete: `src/plugins/fetcher.ts`
- Delete: `src/plugins/install.ts`
- Delete: `src/plugins/parser.ts`
- Delete: `src/plugins/store.ts`
- Delete: `src/plugins/types.ts`
- Modify: `src/plugins/startup.ts` — remove `reloadPluginMcpServers` (lines 16–38) and `autoInstallDeclaredPlugins` (lines 43–78). Keep `loadDatabaseMcpServers`.
- Delete: `tests/plugins/fetcher.test.ts`
- Delete: `tests/plugins/install.test.ts`
- Delete: `tests/plugins/parser.test.ts`
- Delete: `tests/plugins/startup.test.ts` (unless it exclusively tests `loadDatabaseMcpServers`; if so, keep those cases)
- Delete: `tests/plugins/store.test.ts`
- Keep: `tests/plugins/mcp-client.test.ts`, `tests/plugins/mcp-manager.test.ts`

**Step 1: Audit imports of the files being deleted**

```bash
rg "plugins/(fetcher|install|parser|store|types)\b" src tests
rg "reloadPluginMcpServers|autoInstallDeclaredPlugins|listPlugins|installPlugin|uninstallPlugin" src tests
```

Expected hits (will be cleaned up in Task 4 + step 2 here):
- `src/host/server-admin.ts` — plugin list/install/uninstall routes
- `src/host/server-init.ts` — call sites for reloadPluginMcpServers / autoInstallDeclaredPlugins
- `src/cli/plugin.ts` — to be deleted in Task 4

**Step 2: Update `src/host/server-init.ts`**

Open the file. Remove the import `import { reloadPluginMcpServers, loadDatabaseMcpServers } from '../plugins/startup.js';` and re-add `import { loadDatabaseMcpServers } from '../plugins/startup.js';`. Remove call sites for `reloadPluginMcpServers(…)` and `autoInstallDeclaredPlugins(…)`. Keep `loadDatabaseMcpServers(…)`.

**Step 3: Edit `src/plugins/startup.ts`**

File should end up as a ~50-line module containing only `loadDatabaseMcpServers` (lines 80–127 today) plus its imports:

```ts
import type { DatabaseProvider } from '../providers/database/types.js';
import type { McpConnectionManager } from './mcp-manager.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'plugin-startup' });

export async function loadDatabaseMcpServers(
  database: DatabaseProvider | undefined,
  mcpManager: McpConnectionManager,
): Promise<void> { /* unchanged body */ }
```

Drop unused imports (`DocumentStore`, `AuditProvider`, `Config`, `listPlugins`, `installPlugin`). The logger component name stays the same for log continuity.

**Step 4: Delete legacy plugin files**

```bash
git rm src/plugins/fetcher.ts src/plugins/install.ts src/plugins/parser.ts src/plugins/store.ts src/plugins/types.ts
git rm tests/plugins/fetcher.test.ts tests/plugins/install.test.ts tests/plugins/parser.test.ts tests/plugins/store.test.ts
```

If `tests/plugins/startup.test.ts` exists, inspect it:

```bash
grep -l "reloadPluginMcpServers\|autoInstallDeclaredPlugins" tests/plugins/startup.test.ts && git rm tests/plugins/startup.test.ts
```

(If it only tests those removed functions, delete it. If it tests `loadDatabaseMcpServers`, keep + adjust imports.)

**Step 5: Build + targeted tests**

```bash
npm run build 2>&1 | tail -10
npx vitest run tests/plugins tests/host/server-init
```

Expected: build clean; mcp-client + mcp-manager tests still pass.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor(plugins): remove plugin manifest/install machinery (keep MCP connection manager)"
```

---

## Task 4 — Remove CLI `plugin` + `mcp` Commands + Admin Plugin Endpoints

**Files:**
- Delete: `src/cli/plugin.ts`
- Delete: `src/cli/mcp.ts`
- Modify: `src/cli/index.ts` — remove `plugin` and `mcp` case in the switch (around lines 42–55), the `plugin` + `mcp` fields on `handlers` interface (lines 16, 19), the dynamic imports (lines 153–165), the entries in `knownCommands` (line 124), and the help text block (lines 69–71). Keep `provider`.
- Modify: `src/host/server-admin.ts` — remove the plugin-list / plugin-install / plugin-uninstall routes around lines 1019–1080 (grep `listPlugins` / `installPlugin` / `uninstallPlugin`). Remove `mcpManager` from AdminDeps if it's unused after this (check carefully — phase-4 MCP reconciliation may still need it). Remove dynamic imports of `../plugins/install.js`, `../plugins/store.js`, `../plugins/mcp-manager.js` where no longer needed.
- Modify: `src/host/server-webhook-admin.ts` — inspect `mcpManager` field at line 69. If only used by plugin routes, drop it. If used by skill MCP applier, keep it.
- Modify: `src/host/inprocess.ts` — imports of `mcp-manager`, `mcp-client` stay. Leave alone.
- Modify: `src/host/server-completions.ts` — `mcp-manager` import stays. Leave alone.
- Modify: `src/providers/mcp/database.ts` — `mcp-client` import stays. Leave alone.
- Modify: `ui/admin/src/**` — find admin UI pages for plugin management (Plugins tab). Remove the tab + route + API calls. If there's no admin UI for plugins, skip.
- Delete relevant admin tests (`tests/host/server-admin*.test.ts` — grep for `plugin` before deleting, keep other admin tests).

**Step 1: Grep current CLI plugin/mcp usage**

```bash
rg "ax plugin|ax mcp\b" README.md docs .claude
rg "runPlugin|runMcp" src tests
```

Note hits — they'll be removed in Step 2/3 and the docs sweep task.

**Step 2: Delete CLI files**

```bash
git rm src/cli/plugin.ts src/cli/mcp.ts
```

**Step 3: Edit `src/cli/index.ts`**

Remove:
- `plugin?: ...` and `mcp?: ...` lines from handler interface
- `'plugin'` + `'mcp'` from `knownCommands` Set
- `case 'plugin'` + `case 'mcp'` blocks in switch
- Dynamic imports that reference `./plugin.js` + `./mcp.js`
- Help text lines for those commands

Run `npm run build` after this edit — tsc will flag any missed reference.

**Step 4: Edit `src/host/server-admin.ts`**

Remove the 3 plugin-related routes + their dynamic imports of `../plugins/install.js`, `../plugins/store.js`. Inspect `mcpManager` on AdminDeps — grep remaining usages inside this file. If no usage, drop the field; otherwise leave it (phase-4 MCP work may still need it).

```bash
rg "mcpManager" src/host/server-admin.ts
```

**Step 5: Edit `src/host/server-webhook-admin.ts`**

```bash
rg "mcpManager" src/host/server-webhook-admin.ts
```

If no internal usages remain, remove the field; otherwise keep.

**Step 6: Check admin UI**

```bash
rg "plugin" ui/admin/src --type tsx --type ts
```

If there's a Plugins tab / page / API call (`/admin/api/plugins`), remove it and the nav entry. If nothing found, skip.

**Step 7: Build + tests**

```bash
npm run build 2>&1 | tail -15
npx vitest run tests/host/server-admin tests/cli 2>&1 | tail -25
```

Expected: build clean; tests pass or only pre-existing failures remain.

**Step 8: Commit**

```bash
git add -A
git commit -m "refactor(cli): drop 'ax plugin' and 'ax mcp' — superseded by git-native skills + dashboard"
```

---

## Task 5 — Clean Up Skills Prompt Module + Tool-Catalog Filter

**Files:**
- Modify: `src/agent/prompt/modules/skills.ts` — remove `INSTALL_ACTIONS`, `SKILL_NOUNS`, `INQUIRY_PATTERNS`, `REGISTRY_REF`, `detectSkillInstallIntent` exports. Keep `SkillsModule`. Remove the `skillInstallEnabled`-gated "Installing New Skills" block (lines 81–102 of current file).
- Modify: `src/agent/prompt/types.ts` — remove `skillInstallEnabled?: boolean` field (line 59).
- Modify: any caller of `detectSkillInstallIntent` or `skillInstallEnabled` — grep them:
  ```bash
  rg "detectSkillInstallIntent|skillInstallEnabled" src tests
  ```
  Touch every call site (filterTools in tool-catalog, prompt context builders).
- Modify: `src/agent/tool-catalog.ts` — remove the `skillInstallEnabled` filter logic from `filterTools` (now a no-op with skill tool gone).
- Modify: `tests/agent/prompt/modules/skills.test.ts` — remove tests asserting the "Installing New Skills" block renders. Keep "Available skills" + "No skills installed" cases.
- Modify: `tests/agent/tool-catalog.test.ts` — remove the 4 tests that filter on `skillInstallEnabled` (identified in Task 1).

**Step 1: Remove detection helpers + install block**

Edit `src/agent/prompt/modules/skills.ts`:

```ts
// src/agent/prompt/modules/skills.ts
import { BasePromptModule } from '../base-module.js';
import type { PromptContext } from '../types.js';

/**
 * Skills module: summarises available skills for the agent. Skills live in
 * `.ax/skills/<name>/SKILL.md`; the agent reads them on demand.
 * Priority 70 — late in prompt, after context.
 */
export class SkillsModule extends BasePromptModule {
  readonly name = 'skills';
  readonly priority = 70;
  readonly optional = true;

  shouldInclude(_ctx: PromptContext): boolean {
    return true;
  }

  render(ctx: PromptContext): string[] {
    const lines: string[] = [];

    if (ctx.skills.length > 0) {
      lines.push('## Available skills', '');
      for (const s of ctx.skills) {
        const kind = s.kind ?? 'enabled';
        let prefix = '';
        if (kind === 'pending') {
          prefix = s.pendingReasons?.length
            ? `(setup pending: ${s.pendingReasons.join(', ')}) `
            : '(setup pending) ';
        } else if (kind === 'invalid') {
          prefix = '(invalid) ';
        }
        if (s.warnings?.length) {
          prefix = `${prefix}(missing: ${s.warnings.join(', ')}) `;
        }
        const desc = s.description ?? '';
        const tail = prefix || desc ? ` — ${prefix}${desc}`.trimEnd() : '';
        lines.push(`- **${s.name}**${tail}`);
      }
      lines.push('', 'To use a skill, read `.ax/skills/<name>/SKILL.md` and follow its instructions.');
    } else {
      lines.push('## Skills', '', 'No skills are currently installed.');
    }

    if (ctx.hasWorkspace) {
      lines.push(
        '',
        '### Creating Skills',
        '',
        'Skills are git-native: write `SKILL.md` to `.ax/skills/<name>/SKILL.md` using your file-edit tools, then commit and push.',
        'The host reconciler picks up the push and enables the skill once any required credentials and domain approvals are in place.',
      );
    }

    return lines;
  }

  renderMinimal(ctx: PromptContext): string[] {
    return [
      '## Skills',
      ctx.skills.length > 0
        ? `${ctx.skills.length} skills available. Read \`.ax/skills/<name>/SKILL.md\` to load one.`
        : 'No skills installed.',
    ];
  }
}
```

**Step 2: Remove `skillInstallEnabled` from `PromptContext`**

Edit `src/agent/prompt/types.ts` — delete line 59 (`skillInstallEnabled?: boolean;`).

**Step 3: Clean up every caller**

```bash
rg "skillInstallEnabled" src tests
```

For each hit, remove the property from the object being constructed. In `src/agent/tool-catalog.ts::filterTools`, simplify — since the `skill` tool is gone, there's no longer a need to filter on this flag.

**Step 4: Update tests**

- `tests/agent/prompt/modules/skills.test.ts` — delete tests asserting the `Installing New Skills` block rendering (lines ~96–118). Keep tests for "Available skills" rendering + "No skills installed" fallback.
- `tests/agent/tool-catalog.test.ts` — remove the 4 `skillInstallEnabled` tests (deleted in Task 1 if not done already).
- `tests/agent/mcp-server.test.ts` — grep for `skillInstallEnabled` at lines 171, 187; delete the property from the filter objects.
- `tests/agent/ipc-tools.test.ts` — same at lines 107, 129.

**Step 5: Build + run tests**

```bash
npm run build 2>&1 | tail -10
npx vitest run tests/agent/prompt tests/agent/tool-catalog tests/agent/mcp-server tests/agent/ipc-tools
```

Expected: build clean; tests pass.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor(prompt): drop skillInstallEnabled + detectSkillInstallIntent"
```

---

## Task 6 — Drop Retired DB Data via Migration

**Files:**
- Create: `src/migrations/drop-legacy-skills-and-plugins.ts`
- Modify: wherever migrations are registered (likely `src/providers/storage/migrations.ts` or a central migration array) — add the new migration.

**Step 1: Find the migration registry**

```bash
rg "storageMigrations|skillsMigrations|migrations\s*:" src/migrations src/providers/storage --type ts
```

Determine whether documents storage migrations are registered in one array. Identify the next available migration ID / name.

**Step 2: Write the migration**

The `documents` table holds rows with `kind IN ('plugins', 'skills')`. Delete those rows.

```ts
// src/migrations/drop-legacy-skills-and-plugins.ts
import type { Migration } from '../utils/migrator.js';

/**
 * Phase 7 cleanup: remove document rows for legacy plugin manifests and
 * the pre-phase-3 DocumentStore-backed skills. Reads moved to
 * host/skills/state-store.ts; plugin-install path was retired.
 */
export const dropLegacySkillsAndPlugins: Migration = {
  name: '2026_04_17_drop_legacy_skills_and_plugins',
  async up(db) {
    await db.deleteFrom('documents').where('kind', 'in', ['plugins', 'skills']).execute();
  },
  async down(_db) {
    // No-op — this is a cleanup, we do not restore retired data.
  },
};
```

Signature of `Migration` may differ — mirror the shape used by existing migrations (`src/migrations/admin-oauth-providers.ts` as reference).

**Step 3: Register the migration**

Append to the migrations array in the appropriate module (follow the pattern of other migrations — phase-6 added admin-oauth-providers the same way).

**Step 4: Build + run storage tests**

```bash
npm run build 2>&1 | tail -10
npx vitest run tests/providers/storage tests/migrations 2>&1 | tail -20
```

Expected: build clean; tests pass. If a test checks the migration list length, update it.

**Step 5: Commit**

```bash
git add -A
git commit -m "chore(db): drop retired 'plugins'/'skills' documents via phase-7 migration"
```

---

## Task 7 — Docs Sweep + Final Verification

**Files:**
- Modify: `README.md` — update "Install a skill" / "Skills" section to describe the git-native flow (write `.ax/skills/<name>/SKILL.md`, commit, dashboard approves).
- Modify: `docs/web/index.html`, `docs/web/script.js`, `docs/web/styles.css` — remove any mentions of `ax plugin`, `ax mcp`, ClawHub install, `skill({ type: "install" })`.
- Modify: `.claude/skills/ax/cli.md` — remove `plugin` + `mcp` command docs.
- Modify: `.claude/skills/ax/host.md` — remove references to skill_install / ClawHub / plugin install in the IPC / architecture sections.
- Modify: `.claude/skills/ax/agent.md` — remove the `skill` tool block if documented there.
- Modify: `.claude/skills/ax/ipc.md` — remove skill_install/skill_create schemas from the list.

**Step 1: Grep every retired symbol in docs**

```bash
rg "ax plugin|ax mcp\b|skill_install|skill_create|clawhub|ClawHub|plugin install|plugin manifest" README.md docs/ .claude/skills/ax/
```

**Step 2: Edit README.md**

Rewrite the skills section. Short + warm per CLAUDE.md voice. Example (illustrative):

```markdown
## Using Skills

Skills live in your agent's workspace at `.ax/skills/<name>/SKILL.md`. To add one, just write the file and commit.

1. `cd` into the agent's workspace (or ask the agent to do it).
2. Create `.ax/skills/my-skill/SKILL.md` with YAML frontmatter declaring domains, MCP servers, and required credentials.
3. `git commit -am "add my-skill"` — the host reconciler picks it up.
4. Open the AX dashboard → Skills → any pending card for review. Paste credentials, approve domains, click Approve.

No CLI install commands. No registry downloads. Just files.
```

**Step 3: Edit docs/web/***

```bash
rg "plugin|clawhub|skill_install" docs/web/
```

Fix each hit. If `script.js` has a static list of commands for a terminal demo, update the output to reflect the new flow.

**Step 4: Edit `.claude/skills/ax/*.md`**

- `cli.md`: Drop sections for `ax plugin` and `ax mcp`. Keep `ax provider`, `ax serve`, etc.
- `host.md`: In the IPC handlers list, remove skill_install/skill_create/skill_update/skill_delete. Note that skills_index is the only skills-related IPC action.
- `agent.md`: Remove any mention of the `skill` tool; agents use file-edit tools on `.ax/skills/`.
- `ipc.md`: Remove the skill_install/skill_create schema entries.

**Step 5: Run exit-criteria grep**

```bash
rg "skill_install|skill_create|skill_update|skill_delete" src tests
rg "DocumentStore.*skill" src tests
rg "ax plugin\b|ax mcp\b" README.md docs .claude
```

Expected: all three return zero hits (outside this plan document itself).

**Step 6: Full build + test suite**

```bash
npm run build
npm test -- --run 2>&1 | tail -20
```

Expected: build clean. Test count lower than baseline (because we deleted test files), but no NEW failures beyond the pre-existing macOS socket-path failures noted before Task 1.

**Step 7: Update journal + lessons**

Append journal entry under `.claude/journal/refactoring/` describing the phase-7 cleanup. If any non-obvious lesson came up (e.g. a subsystem that turned out to depend on a "retired" module), capture it in `.claude/lessons/`.

**Step 8: Commit**

```bash
git add -A
git commit -m "docs(skills): update README + ax/* skills + web docs for git-native flow"
```

---

## Final Commit List (expected)

1. `refactor(skills): remove skill_install/create/update/delete IPC + agent tool`
2. `refactor(skills): delete ClawHub registry client + legacy skill DocumentStore`
3. `refactor(plugins): remove plugin manifest/install machinery (keep MCP connection manager)`
4. `refactor(cli): drop 'ax plugin' and 'ax mcp' — superseded by git-native skills + dashboard`
5. `refactor(prompt): drop skillInstallEnabled + detectSkillInstallIntent`
6. `chore(db): drop retired 'plugins'/'skills' documents via phase-7 migration`
7. `docs(skills): update README + ax/* skills + web docs for git-native flow`

---

## Notes for the implementer

- **Each task ends with a commit.** Don't batch.
- **Pre-existing test failures** (macOS Unix socket path `EINVAL`) are expected in `tests/integration/smoke.test.ts`, `tests/integration/history-smoke.test.ts`, `tests/host/server.test.ts`, `tests/host/server-history.test.ts`, `tests/host/server-multimodal.test.ts`. If these are the ONLY failures after a task, proceed.
- **Do not rename `src/plugins/` → `src/host/mcp/`.** That's attractive but out of scope for phase 7 — would balloon the diff. A follow-up refactor can do it.
- **Do not delete `src/plugins/mcp-manager.ts` or `mcp-client.ts`.** Phase-4 MCP applier + server-init depend on these.
- **If the skills-index IPC handler depends on anything imported by one of the deleted handlers** (e.g. SkillStateStore), keep those imports and opts — only remove what's now unreachable.
- **Keep the bug-fix-requires-test policy in mind:** if any behavioral change surfaces a pre-existing bug, add a regression test before the fix.
