# Providers

Provider-specific lessons covering LLM, skills, sandbox, channel (Slack), and memory.

## Entries

- Async toAnthropicContent requires Promise.all for message arrays [llm.md](llm.md)
- Anthropic thinking deltas use 'thinking' key, not 'text' [llm.md](llm.md)
- OpenRouter image generation uses /chat/completions, not /images/generations [llm.md](llm.md)
- Configure wizard must set config.model for non-claude-code agents [llm.md](llm.md)
- API key env var naming follows ${PROVIDER.toUpperCase()}_API_KEY convention [llm.md](llm.md)
- Popular OpenClaw skills use clawdbot alias, not openclaw [skills.md](skills.md)
- Many skills have no metadata block — static analysis is essential [skills.md](skills.md)
- OpenClaw's security failures validate AX's zero-trust architecture [skills.md](skills.md)
- Tool filtering must align with prompt module shouldInclude() [skills.md](skills.md)
- child.killed is true after ANY kill() call, not just after the process is dead [sandbox.md](sandbox.md)
- Never use tsx binary as a process wrapper — use node --import tsx/esm instead [sandbox.md](sandbox.md)
- Slack url_private URLs require Authorization header — plain fetch fails silently [channel.md](channel.md)
- Slack file upload: use SDK's files.uploadV2(), not manual 3-step flow [channel.md](channel.md)
- OS username != channel user ID — admins file seed doesn't help channels [channel.md](channel.md)
- Node.js Buffer -> fetch body: use standalone ArrayBuffer to avoid detached buffer errors [channel.md](channel.md)
- Node.js fetch body does not accept Buffer in strict TypeScript [channel.md](channel.md)
- pi-agent-core only supports text — image blocks must bypass it [memory.md](memory.md)
- All credential providers must fall back to process.env on get() [credentials.md](credentials.md)
- Use AX_CREDS_YAML_PATH env var override for testing credential providers [credentials.md](credentials.md)
- Zod transform for backward-compatible config migration [credentials.md](credentials.md)
