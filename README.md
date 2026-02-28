<p align="center">
  <img src="docs/web/ax-logo.svg" alt="Project AX" width="128">
</p>

<p align="center"><em>Like OpenClaw but with trust issues</em></p>
<p align="center"><strong>Always-on AI agents that act autonomously</strong></p>

---

AX is a **personal AI agent** that lets you message an AI assistant (via CLI, Slack, WhatsApp, Telegram, etc.) and have it take actions on your behalf — read emails, fetch web pages, control a browser, generate images, manage your calendar, remember your preferences.

Sound familiar? It should. **OpenClaw** proved that AI agents can be genuinely useful. The problem is that OpenClaw also proved what happens when you don't think about security until it's too late: ~173k lines of code nobody can audit, 42,665 exposed instances on Shodan, a remote code execution CVE, and 341 malicious skills in its marketplace.

We love what OpenClaw does. We just couldn't sleep at night running it.

AX gives you the same power — **multi-channel messaging, web access, browser automation, image generation, long-term memory, extensible skills, plugin ecosystem** — but with security guardrails that are actually enforced by the architecture, not just by good intentions. And at ~10,700 lines of TypeScript across 13 provider categories, it's still small enough to audit in a weekend.

The best part? **You decide where you sit on the spectrum.** Lock everything down, open everything up, or land somewhere in the middle. We give you the dial. We just make sure the safety net is always there, even when you crank it to 11.

## Architecture

We use a **provider contract pattern** — every subsystem (LLM, memory, scanner, channels, etc.) is a TypeScript interface with pluggable implementations. The host process is trusted. Agent containers are not. That's not rude, it's just good security.

### Trust Zones

| Zone | Trust Level | Isolation |
|------|-------------|-----------|
| **Host Process** | Fully trusted | Runs on your machine |
| **Agent Container** | Untrusted | No network, no credentials, no host filesystem |
| **Browser Container** | Untrusted | Filtered egress only |
| **Plugin Processes** | Semi-trusted | Separate processes, integrity-verified, no raw credentials |

### Architectural Invariants

A few things are non-negotiable regardless of which profile you choose. These are **enforced by the architecture** and can't be weakened by configuration:

- Agent containers have **no network access**. All external communication goes through the host's IPC proxy.
- Credentials **never** enter containers. API keys are injected server-side. The agent can use them, but it can never see them.
- All external content is **taint-tagged**. Emails, web pages, anything from outside gets labeled and tracked.
- Every action is **audited**. Containers cannot modify the audit log.
- The agent **cannot modify its own sandbox**.
- Provider loading uses a **static allowlist** — no dynamic imports from config values. Ever.
- **No web UI**. OpenClaw's dashboard was its #1 attack vector, so we solved that problem by not having one.

### Sandbox Tiers

| Platform | Default | Escalation |
|----------|---------|------------|
| Linux | nsjail (~5ms start) | bwrap / Docker + gVisor |
| macOS | Seatbelt (sandbox-exec) | Docker Desktop |

We start with the lightest sandbox that does the job. If the agent needs heavier tools, we escalate mid-session. Most invocations never need more than nsjail — it starts in 5 milliseconds and uses about 1MB of memory.

## Security Profiles

This is the dial. You pick where you want to be:

| Profile | What it's for | Taint Threshold |
|---------|---------------|-----------------|
| **Paranoid** (default) | Maximum safety. Web disabled, no OAuth, read-only skills. | 10% |
| **Standard** | The sweet spot for most people. Web access with blocklists, scheduled tasks, skill proposals with review. | 30% |
| **Power User** | Full capability. Unrestricted web, read-write OAuth, browser automation, multi-agent delegation. You know the risks. | 60% |

The taint threshold controls when we pause to ask before doing something sensitive (like sending an email) based on how much external content is in the conversation. Higher threshold = more autonomy. All three profiles keep the architectural invariants intact — the agent never gets network access or raw credentials, no matter what.

We default to Paranoid not because we think you need it, but because we think defaults should be safe. Upgrading to Standard or Power User is one line in `ax.yaml`.

## What's In the Box

### Multi-Provider LLM Support

AX isn't locked to one AI provider. Configure any combination of Anthropic, OpenAI, Groq, OpenRouter, or any OpenAI-compatible API using compound model IDs. Models are organized by task type — each type gets its own fallback chain:

```yaml
models:
  default:                                      # main agent loop (required)
    - anthropic/claude-sonnet-4-20250514
    - groq/llama-3.3-70b-versatile
    - openrouter/google/gemini-2.0-flash-001
  fast:                                         # summarization, screening (optional)
    - anthropic/claude-haiku-4-5-20251001
  thinking:                                     # complex reasoning, planning (optional)
    - anthropic/claude-opus-4-20250514
  coding:                                       # code generation, review (optional)
    - anthropic/claude-sonnet-4-20250514
  image:                                        # image generation (optional)
    - openai/gpt-image-1.5
    - openrouter/seedream-5-0
```

Only `default` is required — all other task types fall back to it when not configured. The **LLM router** handles failover automatically within each chain — if your primary model hits a rate limit or goes down, AX falls back to the next candidate with exponential backoff and circuit breakers. The **image router** works the same way for image generation. You set the preference order; we handle the rest.

Extended thinking models (Anthropic's `thinking` blocks, OpenAI's `reasoning_content`, DeepSeek R1) are supported natively — reasoning steps stream in real time alongside regular content.

### Image Generation

Full image generation pipeline with multi-provider routing. Generate images via OpenAI, OpenRouter, or Gemini, with automatic fallback between providers. Generated images are persisted to your workspace and accessible via `/v1/files/` endpoints — no ephemeral URLs that expire when you're not looking.

Images flow through channels too — generate in Slack and the result gets uploaded right back to the thread via `uploadV2`.

### Streaming Event Bus

Real-time observability into everything your agent does. The event bus emits typed events — `llm.start`, `llm.chunk`, `llm.thinking`, `tool.call`, `scan.inbound`, `scan.outbound`, `completion.done` — and you can subscribe globally or per-request. Connect via the `/v1/events` SSE endpoint to watch your agent think in real time.

### Plugin Framework

Extend AX with third-party providers without touching core code. The plugin system includes:

- **Provider SDK** (`@ax/provider-sdk`) — TypeScript interfaces, contract test harness, and safe path utilities for provider authors
- **CLI management** — `ax plugin add/remove/list/verify`
- **Integrity verification** — SHA-based hash checking on startup. If a plugin's been tampered with, we notice.
- **Process isolation** — Plugins run in separate processes. Credentials are injected server-side, never passed to plugin code.
- **Lockfile** (`plugins.lock`) — Reproducible plugin installs, because "works on my machine" isn't a security strategy.

### OpenTelemetry Tracing

Plug AX into your existing observability stack. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and every LLM call, tool invocation, and completion gets traced with spans and attributes. First-class Langfuse integration too — just set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.

Zero cost when disabled. The heavy OTel SDK packages are lazy-loaded only when tracing is actually configured.

### Conversation History

AX remembers. A SQLite-backed conversation store persists turns across restarts, so your agent picks up where it left off. Database schema is managed through Kysely migrations — SQLite by default, PostgreSQL-ready when you need it. Configure how much context to carry:

```yaml
history:
  max_turns: 100
  thread_context_turns: 20
```

### Scheduling

Your agent can act on its own schedule, not just when you message it:

- **Cron jobs** — recurring tasks with standard 5-field cron syntax ("check my email every morning at 9am")
- **One-shot scheduling** — "remind me about this in 2 hours" via `scheduler_run_at`
- **Heartbeat** — periodic check-ins where the agent reviews overdue items and takes action
- **Active hours** — configure when the agent is allowed to act autonomously, so it doesn't start reorganizing your inbox at 3am

Scheduled responses route back through the outbound delivery pipeline to the right channel — Slack, CLI, wherever you're listening.

### Slack Integration

Full Slack support via Socket Mode:

- **Thread-aware sessions** — conversations stay in-thread, context preserved
- **Smart reply gating** — in channels, the agent only responds when mentioned or directly addressed (no spam)
- **Eyes emoji** — visual acknowledgment while the agent processes your message
- **Thread history backfill** — agent loads thread context before replying
- **Image support** — send images to the agent, get generated images back
- **DM and group DM support** — works everywhere Slack does
- **Socket disconnect resilience** — reconnects gracefully without crashing the process

### Skill Self-Authoring & Import

Agents can propose their own skills — persistent markdown instructions that expand their capabilities. Proposals go through multi-tier safety screening: dangerous patterns are hard-rejected, capability-expanding patterns require human review, and clean content is auto-approved. You stay in the loop on anything that matters.

You can also import skills from external registries (ClawHub). Imported skills go through the same screening pipeline — we're paranoid about external code even when it's just markdown. Especially when it's just markdown.

### Subagent Delegation

Agents can delegate tasks to specialized subagents. The `claude-code` runner handles coding tasks, while the `pi-coding-agent` runner handles general-purpose work. Delegation includes governance controls and workspace isolation — subagents can't access each other's state.

### Config Hot Reload

Change `ax.yaml` and AX picks it up live — no restart required. Send `SIGHUP` or just save the file. New config is validated before the old server tears down, so a typo won't take you offline.

### Modular System Prompts

The agent's system prompt is assembled from 14 composable modules — identity, security, injection defense, skills, context, runtime, heartbeat, reply gating, delegation, memory recall, and tool style. Each module is independently testable with token budget tracking, so the prompt stays within limits even as capabilities grow.

### OpenAI-Compatible API

Drop-in `/v1/chat/completions` endpoint with streaming SSE support. Point your existing tools at AX and get security for free. The `/v1/files/` endpoint serves generated images and other persistent artifacts.

## Providers

Every subsystem is a swappable provider. Here's what ships in the box:

| Category | Implementations |
|----------|----------------|
| **LLM** | Anthropic, OpenAI, OpenRouter, Groq, router (with fallback), traced (OTel wrapper) |
| **Image** | OpenAI, OpenRouter, Gemini, router (with fallback) |
| **Memory** | file, SQLite (with FTS5), memU (knowledge graph) |
| **Scanner** | basic, patterns, promptfoo |
| **Channel** | Slack |
| **Web** | fetch, Tavily |
| **Browser** | container (Playwright) |
| **Credentials** | env, encrypted (AES-256-GCM), OS keychain |
| **Skills** | readonly, git-backed (with screening) |
| **Audit** | file (JSONL), SQLite (queryable) |
| **Sandbox** | subprocess, seatbelt, nsjail, bwrap, Docker |
| **Scheduler** | cron, full (with active hours) |
| **Screener** | static (rule-based) |

13 provider categories. 43 implementations. All swappable.

## Quick Start

```bash
# Install dependencies
npm install

# Set your API key (don't worry, it never enters the sandbox)
export ANTHROPIC_API_KEY=your-key-here

# Run AX
npm start

# Run tests (170 test files and counting)
npm test
```

## Configuration

Edit `ax.yaml` to configure providers, security profile, and sandbox settings. The defaults are conservative — we'd rather you opt into power than accidentally leave the door open. But opting in is easy, and we won't judge.

```yaml
profile: paranoid
models:
  default:
    - anthropic/claude-sonnet-4-20250514
providers:
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
```

See the [architecture doc](docs/plans/ax-architecture-doc.md) for the full details.

## CLI

```bash
ax serve              # Start the AX server
ax chat               # Interactive chat session
ax send "message"     # Send a one-shot message
ax configure          # Interactive setup wizard
ax plugin add <pkg>   # Install a provider plugin
ax plugin list        # List installed plugins
ax plugin verify      # Check plugin integrity
```

## Contributing

We'd love your help. Before diving in, please read through these so we're all on the same page:

1. Read the [PRP](docs/plans/ax-prp.md) for our design philosophy (the "why")
2. Read the [architecture doc](docs/plans/ax-architecture-doc.md) for implementation details (the "how")
3. Read the [security spec](docs/plans/ax-security-hardening-spec.md) for security requirements (the "or else")
4. Providers live in category subdirectories: `src/providers/llm/anthropic.ts`, `src/providers/channel/slack.ts`, etc.
5. Writing a new provider? Check out the [Provider SDK](src/provider-sdk/) and the [provider development guide](.claude/skills/provider-development.md)
6. All file path construction must use `safePath()` from `src/utils/safe-path.ts` — no raw `path.join()` with untrusted input
7. All IPC actions must have Zod schemas with `.strict()` mode — no unknown fields sneaking through

## License

[MIT](LICENSE)
