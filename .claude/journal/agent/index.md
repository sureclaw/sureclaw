# Agent

Agent process: runner, tools, prompt builder, MCP server, tool catalog.

## Entries

- 2026-04-17 06:26 — Phase 3 Task 7: runner fetches skills_index before prompt build [prompt.md](prompt.md)
- 2026-04-17 06:20 — Phase 3 Tasks 5+6: SkillSummary extension + SkillsModule bullet format [prompt.md](prompt.md)
- 2026-04-01 01:20 — Fix multipart message display in chat history [runner.md](runner.md)
- 2026-04-01 01:10 — Fix image attachments dropped by pi-session runner and proxy-stream [runner.md](runner.md)
- 2026-03-31 18:31 — Fix PDF file attachments not reaching LLM in pi-session/claude-code runners [runner.md](runner.md)
- 2026-03-26 05:55 — Fix skill reading and credential request prompt guidance [prompt.md](prompt.md)
- 2026-03-22 07:18 — Conditionally show skill install instructions based on user message intent [prompt.md](prompt.md)
- 2026-03-19 09:24 — Review PR 106 skill auto-install runner changes [runner.md](runner.md)
- 2026-03-19 08:20 — Add skill dependency installer [runner.md](runner.md)
- 2026-03-16 15:00 — Runner NATS work subscription mode (replace stdin) [runner.md](runner.md)
- 2026-03-16 10:00 — Add NATS IPC transport support in runner.ts [runner.md](runner.md)
- 2026-03-15 15:30 — Implement local sandbox execution (Tasks 1-11) [tools.md](tools.md)
- 2026-03-04 19:05 — Move bash/file tools from local to IPC (Phase 1, Task 3) [tools.md](tools.md)
- 2026-02-28 22:48 — Update all tests for consolidated tool names (Task 6) [tools.md](tools.md)
- 2026-02-28 22:30 — Consolidate MCP server tools (28 -> 10) [tools.md](tools.md)
- 2026-02-28 22:30 — Update prompt modules with consolidated tool names [tools.md](tools.md)
- 2026-02-28 22:00 — Consolidate tool-catalog.ts from 28 tools to 10 [tools.md](tools.md)
- 2026-02-28 21:30 — Update pi-session.ts tool definition generation (Task 4) [tools.md](tools.md)
- 2026-02-27 12:30 — Remove pi-agent-core as a user-facing agent type [runner.md](runner.md)
- 2026-02-27 09:35 — Dev/production mode split for agent runner [runner.md](runner.md)
- 2026-02-27 09:00 — Fix agent delegation EPERM crash / retry loop [runner.md](runner.md)
- 2026-02-26 14:00 — LLM tool call optimization: context-aware filtering [tools.md](tools.md)
- 2026-02-25 16:33 — Add minimal-context guidance to DelegationModule [prompt.md](prompt.md)
- 2026-02-25 16:28 — Add DelegationModule system prompt for agent_delegate [prompt.md](prompt.md)
- 2026-02-25 19:00 — Research OpenClaw/Claude Code skills architecture [prompt.md](prompt.md)
- 2026-02-23 11:00 — Copy OpenClaw prompt optimizations into AX [prompt.md](prompt.md)
- 2026-02-22 19:20 — Fix bootstrap: include tool guidance and user context [prompt.md](prompt.md)
