# Agent

Agent process lessons: runner implementations, prompt building, image forwarding, and inter-agent messaging.

## Entries

- HttpIPCClient has two token scopes — auth token (pod identity) vs per-turn IPC token — never conflate [entries.md](entries.md)
- pi-coding-agent does NOT re-export pi-agent-core types [entries.md](entries.md)
- claude-code.ts should use shared buildSystemPrompt() like other runners [entries.md](entries.md)
- claude-code runner discards non-text content blocks — must extract and forward via SDKUserMessage [entries.md](entries.md)
- Retry logic must check for valid output before retrying [entries.md](entries.md)
- Agent messages must flow through trusted host — never sandbox-to-sandbox [entries.md](entries.md)
