# Agent

Agent process lessons: runner implementations, prompt building, image forwarding, and inter-agent messaging.

## Entries

- Integration tests of the Runtime prompt module need non-empty identity [entries.md](entries.md)
- ALL LLM providers must handle image_data and file_data ContentBlocks — not just Anthropic [entries.md](entries.md)
- Both runners must handle ALL ContentBlock types from server — not just text [entries.md](entries.md)
- New ContentBlock types MUST be added to ipc-schemas.ts contentBlock union [entries.md](entries.md)
- Prompt instructions must specify exact tool names and paths — vague "read from" causes LLM tool-guessing spirals [entries.md](entries.md)
- request_credential returns immediately — tool description must use imperative "MUST stop" language [entries.md](entries.md)
- web_fetch IPC bypasses MITM proxy — no credential placeholder replacement possible [entries.md](entries.md)
- kubectl exec shows pod-level env, not runner's process.env — don't diagnose from it [entries.md](entries.md)
- HttpIPCClient has two token scopes — auth token (pod identity) vs per-turn IPC token — never conflate [entries.md](entries.md)
- pi-coding-agent does NOT re-export pi-agent-core types [entries.md](entries.md)
- claude-code.ts should use shared buildSystemPrompt() like other runners [entries.md](entries.md)
- claude-code runner discards non-text content blocks — must extract and forward via SDKUserMessage [entries.md](entries.md)
- Retry logic must check for valid output before retrying [entries.md](entries.md)
- Agent messages must flow through trusted host — never sandbox-to-sandbox [entries.md](entries.md)
