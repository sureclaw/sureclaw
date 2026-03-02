# Providers

Provider implementations: image, channel, skills, sandbox, memory, LLM.

## Entries

- 2026-03-02 14:30 — Refactor credential providers: keychain default, plaintext fallback [credentials.md](credentials.md)
- 2026-03-01 19:30 — Create MemoryFS implementation plan [memory.md](memory.md)
- 2026-03-01 15:57 — Rename canonical paths: /agent->/identity, /shared->/agent [sandbox.md](sandbox.md)
- 2026-02-27 14:30 — Create exploring-reference-repos skill [skills.md](skills.md)
- 2026-02-27 12:00 — Analyze pi-package-strategy vs latest MRs [llm.md](llm.md)
- 2026-02-26 11:30 — Fix image resolver using wrong agentId and add defensive fallbacks [image.md](image.md)
- 2026-02-26 10:35 — Migrate file storage from session workspace to enterprise user workspace [image.md](image.md)
- 2026-02-26 09:30 — Investigate missing generated images + add diagnostic logging [image.md](image.md)
- 2026-02-26 08:33 — Persist generated images to workspace for durable URLs [image.md](image.md)
- 2026-02-26 08:17 — HTTP API multimodal image response [image.md](image.md)
- 2026-02-26 06:24 — Switch Slack file upload to files.uploadV2 SDK method [channel.md](channel.md)
- 2026-02-26 05:52 — Strip markdown image references from Slack messages [channel.md](channel.md)
- 2026-02-26 03:51 — Eliminate disk round-trip for generated images [image.md](image.md)
- 2026-02-26 03:42 — Fix OpenRouter image generation: create dedicated provider [image.md](image.md)
- 2026-02-26 03:20 — Expose image_generate tool to agents [image.md](image.md)
- 2026-02-26 02:45 — Fix claude-code runner dropping image blocks [image.md](image.md)
- 2026-02-26 02:33 — Simplify image pipeline: inline image_data instead of disk round-trip [channel.md](channel.md)
- 2026-02-26 02:14 — Fix Slack image attachments not reaching the LLM [channel.md](channel.md)
- 2026-02-26 01:02 — Implement AgentSkills import, screener, manifest generator, and ClawHub client [skills.md](skills.md)
- 2026-02-26 00:00 — Unified image generation: config simplification + image provider category [image.md](image.md)
- 2026-02-25 23:21 — Fix Slack file upload "detached ArrayBuffer" error [channel.md](channel.md)
- 2026-02-25 21:53 — Fix Slack image download missing auth header [channel.md](channel.md)
- 2026-02-25 20:45 — OpenClaw vs AX skills architecture comparison [skills.md](skills.md)
- 2026-02-25 18:06 — Complete image_data pipeline: Anthropic, persistence guard, tests [image.md](image.md)
- 2026-02-25 17:00 — Add image_data transient block type and in-memory image pipeline (WIP) [image.md](image.md)
- 2026-02-25 05:00 — Add image support in chat (both directions) [image.md](image.md)
- 2026-02-22 20:50 — OpenTelemetry LLM tracing [llm.md](llm.md)
