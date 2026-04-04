# Multi-Agent Slack UX Plan

**Goal:** Build a Slack UX layer on top of the existing multi-agent infrastructure so multiple agents (personal + shared) coexist cleanly in Slack channels, DMs, and threads.

## Tasks

1. Add `display_name` and `agent_kind` to AgentRegistryEntry
2. Add `shared_agents` config section to config.ts
3. Refactor Slack provider to accept injected tokens
4. Per-message agent routing in server-channels.ts (replace hardcoded agentName)
5. Thread ownership via Slack API (fetchThreadOwner)
6. Response prefix `[Display Name]` for personal agents in channels
7. Shared agent startup in server-local.ts
8. Agent-scoped webhook routing `/webhooks/{agentId}/{name}`
9. Update skills docs
10. Update journal/lessons
11. Final verification (build + tests)
