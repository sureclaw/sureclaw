## [2026-03-29 14:00] — Update three skill files for Cowork plugins, HTTP IPC, MCP storage

**Task:** Update ax-security, ax-persistence, and ax-provider-skills skill files to reflect recent code changes (Cowork plugins, HTTP IPC replacing NATS, mcp_servers table, tool-stubs).
**What I did:** (1) ax-security: Replaced "NATS messaging for K8s pods" with "HTTP-based IPC for K8s pods (no NATS)" in sandbox isolation. Added Cowork Plugin Security subsection under Plugin Integrity. Updated invariant from "Unix socket IPC only" to "Unix socket IPC (local) or HTTP IPC (k8s)". (2) ax-persistence: Added McpServerStore/mcp_servers note to architecture diagram, added tool-stubs.ts to key files table, added mcp_servers migration note. (3) ax-provider-skills: Added Cowork Plugin Skills section with key files. Updated skill install lifecycle to note plugin skills from DocumentStore.
**Files touched:** .claude/skills/ax-security/SKILL.md, .claude/skills/ax-persistence/SKILL.md, .claude/skills/ax-provider-skills/SKILL.md
**Outcome:** Success — all three skill files updated.
**Notes:** None.

## [2026-03-29 12:00] — Update three skill files for recent code changes

**Task:** Update ax-ipc, ax-cli, and ax-config skill files to reflect new IPC actions, deleted workspace files, new plugins config field, and mcp command mention.
**What I did:** Added 5 new IPC actions (plugin_install_cowork, plugin_uninstall_cowork, plugin_list_cowork, tool_batch, session_expiring) to the ax-ipc actions table. Simplified workspace operations section (workspace-cli.ts and workspace-release.ts deleted). Added "mcp, provider" to ax-cli description. Added `plugins` (PluginDeclaration[]) config field to ax-config after delegation row.
**Files touched:** .claude/skills/ax-ipc/SKILL.md, .claude/skills/ax-cli/SKILL.md, .claude/skills/ax-config/SKILL.md
**Outcome:** Success — all three skill files updated.
**Notes:** ax-cli commands table already had mcp and provider entries; only the frontmatter description was missing "mcp" and "provider".

## [2026-03-16 16:38] — Create one-page PDF app summary

**Task:** Create a one-page PDF that summarizes AX using repo evidence only.
**What I did:** Read the repo docs and source files needed to ground the summary, generated a landscape one-page PDF under output/pdf, rendered it to PNG with Poppler, and visually checked the layout for clipping and overflow.
**Files touched:** output/pdf/ax-app-summary.pdf, tmp/pdfs/ax-app-summary-1.png, .claude/journal/docs/artifacts.md, .claude/journal/docs/index.md, .claude/journal/index.md
**Outcome:** Success — the PDF fits on a single page and the content explicitly marks the missing persona detail as "Not found in repo."
**Notes:** Evidence came from README, package.json, docs/plans, and the host/agent source files that implement provider loading, routing, IPC, and completion execution.
