<p align="center">
  <img src="docs/web/ax-logo.svg" alt="Project AX" width="128">
</p>

<p align="center"><em>Let your agent cook. In a fireproof kitchen.</em></p>
<p align="center"><strong>Always-on AI agents that act autonomously</strong></p>

<p align="center">
  <a href="https://github.com/project-ax/project-ax/actions/workflows/ci.yml"><img src="https://github.com/project-ax/project-ax/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/project-ax/project-ax/actions/workflows/pages.yml"><img src="https://github.com/project-ax/project-ax/actions/workflows/pages.yml/badge.svg" alt="GitHub Pages"></a>
  <a href="https://github.com/project-ax/project-ax/blob/main/LICENSE"><img src="https://img.shields.io/github/license/project-ax/project-ax" alt="License: MIT"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A524-5fa04e?logo=nodedotjs&logoColor=white" alt="Node.js >= 24"></a>
</p>
<p align="center">
  <a href="https://github.com/project-ax/project-ax/stargazers"><img src="https://img.shields.io/github/stars/project-ax/project-ax?style=flat" alt="GitHub stars"></a>
  <a href="https://github.com/project-ax/project-ax/network/members"><img src="https://img.shields.io/github/forks/project-ax/project-ax?style=flat" alt="GitHub forks"></a>
  <a href="https://github.com/project-ax/project-ax/issues"><img src="https://img.shields.io/github/issues/project-ax/project-ax" alt="GitHub issues"></a>
  <a href="https://github.com/project-ax/project-ax/pulls"><img src="https://img.shields.io/github/issues-pr/project-ax/project-ax" alt="GitHub pull requests"></a>
  <a href="https://github.com/project-ax/project-ax/commits/main"><img src="https://img.shields.io/github/last-commit/project-ax/project-ax" alt="Last commit"></a>
  <a href="https://github.com/project-ax/project-ax"><img src="https://img.shields.io/github/repo-size/project-ax/project-ax" alt="Repo size"></a>
</p>
<p align="center">
  <a href="https://semgrep.dev/"><img src="https://img.shields.io/badge/security-semgrep-purple?logo=semgrep" alt="Semgrep"></a>
  <a href="https://github.com/gitleaks/gitleaks"><img src="https://img.shields.io/badge/secrets-gitleaks-blue" alt="Gitleaks"></a>
  <a href="https://github.com/project-ax/project-ax/blob/main/SECURITY.md"><img src="https://img.shields.io/badge/security%20policy-published-green" alt="Security policy"></a>
  <a href="https://github.com/project-ax/project-ax/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome"></a>
</p>

---

AX is a **personal AI agent** that lets you message an AI assistant (via CLI, Slack, WhatsApp, Telegram, etc.) and have it take actions on your behalf — read emails, fetch web pages, manage your calendar, remember your preferences.

Sound familiar? It should. **OpenClaw** proved that AI agents can be genuinely useful. The problem is that OpenClaw also proved what happens when you don't think about security until it's too late: ~173k lines of code nobody can audit, 42,665 exposed instances on Shodan, a remote code execution CVE, and 341 malicious skills in its marketplace.

We love what OpenClaw does. We just couldn't sleep at night running it.

AX gives you the same power — **multi-channel messaging, web access, long-term memory, extensible skills, plugin ecosystem** — but with security guardrails that are actually enforced by the architecture, not just by good intentions. And at ~34,600 lines of TypeScript across 15 provider categories, it's still small enough to audit in a long weekend.

The best part? **You decide where you sit on the spectrum.** Lock everything down, open everything up, or land somewhere in the middle. We give you the dial. We just make sure the safety net is always there, even when you crank it to 11.

## Architecture

We use a **provider contract pattern** — every subsystem (LLM, memory, security, channels, etc.) is a TypeScript interface with pluggable implementations. The host process is trusted. Agent containers are not. That's not rude, it's just good security.

### Trust Zones

| Zone | Trust Level | Isolation |
|------|-------------|-----------|
| **Host Process** | Fully trusted | Runs on your machine |
| **Agent Container** | Untrusted | No network, no credentials, no host filesystem |
| **Plugin Processes** | Semi-trusted | Separate processes, integrity-verified, no raw credentials |

### Architectural Invariants

A few things are non-negotiable regardless of which profile you choose. These are **enforced by the architecture** and can't be weakened by configuration:

- Agent containers have **no network access**. All external communication goes through the host's IPC proxy.
- Credentials **never** enter containers. API keys are injected server-side. The agent can use them, but it can never see them.
- All external content is **taint-tagged**. Emails, web pages, anything from outside gets labeled and tracked.
- Every action is **audited**. Containers cannot modify the audit log.
- The agent **cannot modify its own sandbox**.
- Provider loading uses a **static allowlist** — no dynamic imports from config values. Ever.
- **No public web UI**. OpenClaw's end-user dashboard was its #1 attack vector, so we don't expose one. The admin dashboard is a separate, token-gated surface used only by operators for approvals and audit — not reachable by agents or end users.

### Container Architecture

| Platform | Container | Runtime |
|----------|-----------|---------|
| Linux | Docker | gVisor optional |
| macOS | Apple Virtualization | Container framework |
| Kubernetes | k8s pods | gVisor runtime class |

Every agent runs inside a single container with a three-phase lifecycle: **provision** (with network, git clone, dependency install) → **run** (no network, tools execute locally) → **cleanup** (with network, push results). The host orchestrates the phases and maintains a tamper-proof audit log via the audit gate — every tool call is approved before execution.

## Security Profiles

This is the dial. You pick where you want to be:

| Profile | What it's for | Taint Threshold |
|---------|---------------|-----------------|
| **Paranoid** (default) | Maximum safety. Web disabled, no OAuth, read-only skills. | 10% |
| **Standard** | The sweet spot for most people. Web access with blocklists, scheduled tasks, skill proposals with review. | 30% |
| **Power User** | Full capability. Unrestricted web, read-write OAuth, multi-agent delegation. You know the risks. | 60% |

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
```

Only `default` is required — all other task types fall back to it when not configured. The **LLM router** handles failover automatically within each chain — if your primary model hits a rate limit or goes down, AX falls back to the next candidate with exponential backoff and circuit breakers. You set the preference order; we handle the rest.

Extended thinking models (Anthropic's `thinking` blocks, OpenAI's `reasoning_content`, DeepSeek R1) are supported natively — reasoning steps stream in real time alongside regular content.

### Streaming Event Bus

Real-time observability into everything your agent does. The event bus emits typed events — `llm.start`, `llm.chunk`, `llm.thinking`, `tool.call`, `scan.inbound`, `scan.outbound`, `completion.done` — and you can subscribe globally or per-request. Connect via the `/v1/events` SSE endpoint to watch your agent think in real time.

Locally, the event bus runs in-process. In Kubernetes, it switches to **PostgreSQL LISTEN/NOTIFY** — events flow across pods so every agent-runtime instance sees the same stream. Same interface, same subscriptions, just distributed.

### Provider Plugin Framework

Extend AX with third-party providers without touching core code. The provider plugin system includes:

- **Provider SDK** (`@ax/provider-sdk`) — TypeScript interfaces, contract test harness, and safe path utilities for provider authors
- **CLI management** — `ax provider add/remove/list/verify`
- **Integrity verification** — SHA-based hash checking on startup. If a plugin's been tampered with, we notice.
- **Process isolation** — Plugins run in separate processes. Credentials are injected server-side, never passed to plugin code.
- **Lockfile** (`plugins.lock`) — Reproducible plugin installs, because "works on my machine" isn't a security strategy.

### OpenTelemetry Tracing

Plug AX into your existing observability stack. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and every LLM call, tool invocation, and completion gets traced with spans and attributes. First-class Langfuse integration too — just set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.

Zero cost when disabled. The heavy OTel SDK packages are lazy-loaded only when tracing is actually configured.

### Shared Database & Storage

AX consolidates all persistent state — conversations, memory, audit logs, message queues, session tracking — behind a shared `DatabaseProvider`. One database choice for the whole application. SQLite locally, PostgreSQL in production. Schema is managed through Kysely migrations, and vector search is available when sqlite-vec or pgvector extensions are loaded.

The `StorageProvider` unifies conversation history, message queues, session tracking, and document storage behind a single interface backed by the database layer.

```yaml
database: sqlite          # or postgresql
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

### Git-Native Skills

Skills are just files in the agent's workspace. To add one, drop a `SKILL.md` under `.ax/skills/<name>/` and commit it. The host's reconciler picks it up, and the admin dashboard surfaces a card for any skill that declares new MCP servers, domains, or credentials — you approve it with a click. No CLI install commands. No registries to trust. Just files and git.

Agents can also propose their own skills with the `skill_propose` tool — persistent markdown instructions that expand their capabilities. Proposals go through multi-tier safety screening: dangerous patterns are hard-rejected, capability-expanding patterns require human review, and clean content is auto-approved. You stay in the loop on anything that matters.

### Subagent Delegation

Agents can delegate tasks to specialized subagents. The `claude-code` runner handles coding tasks, while the `pi-coding-agent` runner handles general-purpose work. Delegation includes governance controls and workspace isolation — subagents can't access each other's state.

### Kubernetes Deployment

AX ships with a production-ready **Helm chart** for Kubernetes. The architecture splits into host pods (HTTP ingress + orchestration) and ephemeral sandbox pods — coordinated through HTTP and PostgreSQL.

```bash
npx ax k8s init    # generates values + secrets
helm install ax ./charts/ax -f ax-values.yaml -n ax
```

The chart includes:
- **Host pods** — HTTP API, LLM orchestration, sandbox dispatch (scale with HPA)
- **PostgreSQL** — external or embedded, shared across all providers (event bus via LISTEN/NOTIFY)
- **Git server** — HTTP git server for workspace persistence across sandbox pods
- **Network policies** — defense-in-depth isolation for sandbox pods (zero egress, host-only ingress)
- **Web proxy** — controlled HTTP/HTTPS outbound for sandboxed agents (npm install, git clone)

Works with any Kubernetes: GKE, EKS, AKS, kind, minikube. Zero vendor lock-in.

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
| **LLM** | Anthropic, OpenAI, OpenRouter, Groq, DeepInfra, router (with fallback), traced (OTel wrapper) |
| **Memory** | cortex (vector-backed, LLM-powered extraction and semantic search) |
| **Security** | patterns (regex-only), guardian (regex + LLM classification) |
| **Channel** | Slack |
| **Web** | fetch, Tavily (search + extract) |
| **Credentials** | plaintext, OS keychain, database |
| **Audit** | database (queryable) |
| **Sandbox** | Docker, Apple Virtualization, k8s (Kubernetes pods) |
| **Scheduler** | none, plainjob |
| **Database** | SQLite (with sqlite-vec), PostgreSQL (with pgvector) |
| **Storage** | database |
| **EventBus** | inprocess, PostgreSQL (LISTEN/NOTIFY) |
| **MCP Gateway** | none (disabled), database (per-agent HTTP/SSE MCP servers with circuit breaker) |
| **Auth** | admin-token, better-auth |
| **Workspace** | git-local (bare repos on disk), git-http (shared git server for k8s) |

16 provider categories. All swappable.

## Quick Start

### Prerequisites

- **Node.js 24+** and npm
- **Git** (for workspace persistence)
- **Docker** (Linux) or **Apple Containers** (macOS) — AX auto-detects your platform
- An API key from any supported LLM provider (Anthropic, OpenAI, OpenRouter, Groq, DeepInfra)

### 1. Install and Configure

```bash
# Clone and install
git clone https://github.com/project-ax/project-ax.git
cd project-ax
npm install

# Run the setup wizard — three questions, done
npx ax configure
```

The wizard asks for your **security profile**, **LLM provider**, and **API key**. Everything else — sandbox type, database, event bus, workspace — is auto-configured for your platform. Your API key is stored locally and never enters the sandbox. We're paranoid like that.

### 2. Start AX

```bash
npm start
```

That's it. AX is now listening on a Unix socket at `~/.ax/ax.sock` with an OpenAI-compatible API.

### 3. Chat

```bash
# Interactive chat
npx ax chat

# Or send a one-shot message
npx ax send "What can you help me with?"
```

### What Just Happened?

The wizard generated a minimal `~/.ax/ax.yaml` that looks something like this:

```yaml
profile: balanced
models:
  default:
    - anthropic/claude-sonnet-4-20250514
sandbox:
  timeout_sec: 120
  memory_mb: 512
```

That's the entire config. AX fills in everything else with sensible local-mode defaults:

| Setting | Default |
|---------|---------|
| Sandbox | Apple containers (macOS) or Docker (Linux) |
| Database | SQLite at `~/.ax/data/ax.db` |
| Event bus | In-process |
| Workspace | Local git repos at `~/.ax/repos/` |
| Credentials | Database (SQLite) |
| Memory | Cortex (vector-backed) |
| Security | Pattern scanner |

Want to change something? Add it to `ax.yaml`. Only specify what you want to override — the defaults handle the rest.

### Running Tests

```bash
npm test          # Full suite (vitest, 230+ test files)
npm run build     # TypeScript compilation
```

## Configuration

AX has two deployment modes. You don't pick one — the tooling picks for you.

### Local Mode (via `ax configure`)

For development and personal use. Runs as a single process on your machine. The config is minimal by design — you shouldn't need to think about providers, databases, or event buses just to talk to an AI agent.

```yaml
# This is a complete, valid ax.yaml
profile: balanced
models:
  default:
    - anthropic/claude-sonnet-4-20250514
```

Need web search? Add it:

```yaml
profile: balanced
models:
  default:
    - anthropic/claude-sonnet-4-20250514
providers:
  web:
    search: tavily
```

Need Slack? Add it:

```yaml
providers:
  channels:
    - slack
```

Everything you don't specify uses the local-mode defaults. The full list of providers and their options is in the [architecture doc](docs/plans/ax-architecture-doc.md).

### K8s Mode (via `ax k8s init`)

For production. Runs across multiple pods with PostgreSQL, HTTP IPC, and network-isolated sandbox pods.

```bash
npx ax k8s init
```

This asks four questions — **profile**, **model**, **API key**, and **database** (internal or external PostgreSQL) — then generates a `ax-values.yaml` and creates the necessary Kubernetes secrets. Deploy with:

```bash
helm install ax charts/ax -f ax-values.yaml -n ax
```

See [Deploying to Kubernetes](#deploying-to-kubernetes) below for the full walkthrough.

## Deploying to Kubernetes

### Prerequisites

- Kubernetes cluster (GKE, EKS, AKS, kind, minikube — we're not picky)
- Helm 3.x
- `kubectl` configured for your cluster
- Container images built and pushed to a registry your cluster can pull from

### 1. Build and Push the Container Image

```bash
npm run build
docker build -f container/Dockerfile -t your-registry/ax:latest .
docker push your-registry/ax:latest
```

The same image is used for host and sandbox pods. The entrypoint is overridden per deployment via the Helm chart.

### 2. Run the K8s Setup Wizard

```bash
npx ax k8s init
```

This asks four questions:
1. **Security profile** — paranoid, balanced, or yolo
2. **Model** — compound provider/model ID (e.g. `anthropic/claude-sonnet-4-20250514`)
3. **API key** — for your chosen LLM provider
4. **Database** — internal (chart provisions PostgreSQL) or external (your own)

The wizard creates the namespace, Kubernetes secrets, and generates an `ax-values.yaml` with K8s-mode providers pre-configured (PostgreSQL, postgres event bus, k8s sandbox, git-http workspace).

### 3. Install with Helm

```bash
helm install ax ./charts/ax -f ax-values.yaml -n ax
```

### 4. Verify the Deployment

```bash
kubectl get pods -n ax
# ax-host-xxx    — HTTP ingress + orchestration (x2)

kubectl port-forward -n ax svc/ax-host 8080:80 &
curl http://localhost:8080/health
```

### Architecture Overview

| Layer | Pods | Role |
|-------|------|------|
| **Host** | `host` | HTTP API, LLM orchestration, sandbox dispatch. Scales with HPA. |
| **Sandbox** | ephemeral | Isolated tool execution. No network, no credentials, no host filesystem. gVisor runtime. |
| **Git Server** | `git-server` | HTTP git repos for workspace persistence across sandbox pods. |
| **PostgreSQL** | external or internal | Shared state, event bus (LISTEN/NOTIFY), audit logs. |

Communication flows through **HTTP**. Sandbox pods connect to the host for IPC and to the git server for workspace repos. Network policies enforce zero egress — sandbox pods can only reach the host and git server.

### Key Configuration

| Value | Default | Description |
|-------|---------|-------------|
| `host.replicas` | 2 | Host pod count (stateless, scale freely) |
| `sandbox.runtimeClass` | `"gvisor"` | Set to `""` for clusters without gVisor |
| `networkPolicies.enabled` | true | Enforce zero-egress on sandbox pods |
| `gitServer.enabled` | false | Enable HTTP git server for workspace persistence |
| `host.autoscaling.enabled` | false | Enable HPA for host pods |

### Exposing AX

By default the host Service is `ClusterIP`. To expose it externally:

```yaml
# my-values.yaml — enable Ingress
host:
  ingress:
    enabled: true
    className: "nginx"  # or your ingress class
    host: "ax.yourdomain.com"
    tls:
      - secretName: ax-tls
        hosts:
          - ax.yourdomain.com
```

Or use a LoadBalancer service, port-forward, or whatever your cluster setup prefers. We don't judge.

### Local Development with kind

For local testing without a cloud cluster:

```bash
# Create a kind cluster
kind create cluster --name ax-dev

# Load images directly (skip the registry)
kind load docker-image your-registry/ax:latest --name ax-dev

# Install with local-friendly settings
helm install ax ./charts/ax -f my-values.yaml --namespace ax --create-namespace \
  --set sandbox.runtimeClass="" \
  --set host.replicas=1 \
  --set agentRuntime.replicas=1
```

Note: kind doesn't support gVisor, so sandbox pods run without runtime isolation. Fine for development — not recommended for production.

### FluxCD GitOps

For GitOps deployments, AX includes FluxCD overlays in `flux/`:

```
flux/
├── sources/          # GitRepository + HelmRepository
├── base/             # Base HelmRelease
├── staging/          # Staging overrides (1 replica, relaxed profile)
└── production/       # Production overrides (HPA, TLS, paranoid profile)
```

Secrets are encrypted with SOPS (age-based). See `flux/README.md` for setup instructions.

## MCP Fast Path

Most agent turns are simple — call an API, answer a question, look something up. They don't need a full sandbox container with network isolation and a MITM proxy. That's like renting a U-Haul to pick up a coffee.

The **MCP fast path** runs these simple turns entirely in the host process. No pods, no IPC, no proxy. MCP tools route through external HTTP/SSE MCP servers that handle authentication and API calls. The agent never sees credentials. When a turn actually needs shell access, filesystem, or git — the agent requests sandbox escalation and a dedicated pod is provisioned on demand.

**Result:** 95% of turns skip all container infrastructure. The other 5% get a session-bound sandbox that persists across turns.

### Setting Up MCP Servers

The `database` MCP provider stores per-agent server definitions in the database. Each agent can connect to multiple MCP servers, and tool names are prefixed with the server name to avoid collisions.

#### 1. Configure AX

Enable the MCP provider in your `ax.yaml`:

```yaml
providers:
  mcp: database    # enable database-backed MCP servers
```

#### 2. Add MCP Servers

MCP servers are declared in skill frontmatter (under `.ax/skills/<name>/SKILL.md`) or registered directly via the admin API. The old CLI registration commands have been retired — git-native skill files plus a dashboard review flow cover every real use case with fewer surprises.

Credential placeholders like `{LINEAR_API_KEY}` are resolved from the credential provider at call time — the actual secrets never touch the database.

#### 3. Manage via Admin API

MCP servers can be managed via the admin API:

```bash
# List servers for an agent
curl http://localhost:8080/admin/api/agents/main/mcp-servers

# Add a server
curl -X POST http://localhost:8080/admin/api/agents/main/mcp-servers \
  -H "Content-Type: application/json" \
  -d '{"name": "linear", "url": "http://linear-mcp.example.com/mcp"}'

# Test a server
curl -X POST http://localhost:8080/admin/api/agents/main/mcp-servers/linear/test
```

### How Credentials Stay Secure

```text
LLM loop (in host process, no credentials)
  │
  ├─ tool_call("linear__get_issues", { query: "bugs" })
  │
  ▼
Host (trusted) → McpProvider.callTool()
  │
  ├─ resolveHeaders({LINEAR_API_KEY} → actual key from credential provider)
  │
  ▼
MCP Server (receives request with resolved credentials)
  │
  ├─ HTTPS to api.linear.app with bearer token
  │
  ▼
Response flows back: MCP Server → Host → LLM loop
```

The LLM never sees credentials. The credential provider manages them. The host resolves placeholders at call time and routes tool calls. Same security invariant as the sandbox model, minus the MITM proxy complexity.

## CLI

```bash
ax serve                # Start the AX server
ax chat                 # Interactive chat session
ax send "message"       # Send a one-shot message
ax configure            # Setup wizard (profile, LLM provider, API key)
ax k8s init             # K8s setup wizard (generates Helm values + secrets)
ax provider add <pkg>   # Install a third-party provider plugin
ax provider remove <pkg> # Remove a third-party provider plugin
ax provider list        # List installed provider plugins
ax provider verify      # Check provider plugin integrity
```

Skills and MCP servers are managed via `.ax/skills/` files committed to the agent's workspace plus the admin dashboard — not the CLI. See the Git-Native Skills section above.

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
