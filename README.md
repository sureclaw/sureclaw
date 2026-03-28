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

AX is a **personal AI agent** that lets you message an AI assistant (via CLI, Slack, WhatsApp, Telegram, etc.) and have it take actions on your behalf — read emails, fetch web pages, control a browser, generate images, manage your calendar, remember your preferences.

Sound familiar? It should. **OpenClaw** proved that AI agents can be genuinely useful. The problem is that OpenClaw also proved what happens when you don't think about security until it's too late: ~173k lines of code nobody can audit, 42,665 exposed instances on Shodan, a remote code execution CVE, and 341 malicious skills in its marketplace.

We love what OpenClaw does. We just couldn't sleep at night running it.

AX gives you the same power — **multi-channel messaging, web access, browser automation, image generation, long-term memory, extensible skills, plugin ecosystem** — but with security guardrails that are actually enforced by the architecture, not just by good intentions. And at ~34,600 lines of TypeScript across 17 provider categories, it's still small enough to audit in a long weekend.

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

Locally, the event bus runs in-process. In Kubernetes, it switches to **NATS JetStream** — events flow across pods so every agent-runtime instance sees the same stream. Same interface, same subscriptions, just distributed.

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

### Agent Workspaces

Persistent file workspaces that give agents a place to read and write files across sessions. Three scopes — **agent** (shared by all sessions for that agent), **user** (per-user across sessions), and **session** (ephemeral per conversation) — are bind-mounted into the sandbox. After each session, changed files go through scanner screening before being persisted. Backends include local filesystem and Google Cloud Storage, so workspaces work the same on your laptop and in Kubernetes.

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

### Skill Self-Authoring & Import

Agents can propose their own skills — persistent markdown instructions that expand their capabilities. Proposals go through multi-tier safety screening: dangerous patterns are hard-rejected, capability-expanding patterns require human review, and clean content is auto-approved. You stay in the loop on anything that matters.

You can also import skills from external registries (ClawHub). Imported skills go through the same screening pipeline — we're paranoid about external code even when it's just markdown. Especially when it's just markdown.

### Subagent Delegation

Agents can delegate tasks to specialized subagents. The `claude-code` runner handles coding tasks, while the `pi-coding-agent` runner handles general-purpose work. Delegation includes governance controls and workspace isolation — subagents can't access each other's state.

### Kubernetes Deployment

AX ships with a production-ready **Helm chart** for Kubernetes. The architecture splits into multiple pods — host (ingress layer), agent-runtime (conversation layer), pool controller (sandbox pod lifecycle), and ephemeral sandbox pods — all coordinated through NATS JetStream.

```bash
helm install ax ./charts/ax -f values.yaml
```

The chart includes:
- **Multi-pod architecture** — host, agent-runtime, and pool controller scale independently with HPA
- **NATS JetStream** — distributed event bus and IPC bridge for sandbox communication
- **PostgreSQL** — external or embedded, shared across all providers
- **Network policies** — defense-in-depth isolation for sandbox pods (zero egress, host-only ingress)
- **Sandbox tiers** — light and heavy pod templates with configurable CPU/memory and gVisor runtime
- **FluxCD overlays** — staging and production HelmRelease configs with SOPS encryption

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
| **Image** | OpenAI, OpenRouter, Groq, Gemini, router (with fallback) |
| **Memory** | cortex (vector-backed, LLM-powered extraction and semantic search) |
| **Scanner** | patterns (regex-only), guardian (regex + LLM classification) |
| **Channel** | Slack |
| **Web** | fetch, Tavily |
| **Browser** | container (Playwright) |
| **Credentials** | plaintext, OS keychain |
| **Skills** | readonly, git-backed (with screening) |
| **Audit** | file (JSONL), database (queryable) |
| **Sandbox** | subprocess, Docker, Apple Virtualization, k8s (Kubernetes pods) |
| **Scheduler** | full (with active hours), plainjob |
| **Screener** | static (rule-based) |
| **Database** | SQLite (with sqlite-vec), PostgreSQL (with pgvector) |
| **Storage** | file, database |
| **EventBus** | inprocess, NATS JetStream |
| **MCP Gateway** | none (disabled), database (per-agent HTTP/SSE MCP servers with circuit breaker) |
| **Workspace** | none (disabled), local (filesystem), gcs (Google Cloud Storage) |

18 provider categories. 50+ implementations. All swappable.

## Quick Start

```bash
# Install dependencies
npm install

# Set your API key (don't worry, it never enters the sandbox)
export ANTHROPIC_API_KEY=your-key-here

# Run AX
npm start

# Run tests (210+ test files and counting)
npm test
```

## Configuration

Edit `ax.yaml` to configure providers, security profile, and sandbox settings. The defaults are conservative — we'd rather you opt into power than accidentally leave the door open. But opting in is easy, and we won't judge.

```yaml
# Local development (defaults)
profile: paranoid
models:
  default:
    - anthropic/claude-sonnet-4-20250514
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web: none
  browser: none
  credentials: plaintext
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
  database: sqlite
  eventbus: inprocess
  workspace: none
```

For Kubernetes production deployments, the Helm chart renders a ConfigMap with production-ready defaults:

```yaml
# K8s production (via Helm values)
profile: paranoid
providers:
  sandbox: k8s
  database: postgresql
  audit: database
  eventbus: nats
  scanner: guardian
```

See the [architecture doc](docs/plans/ax-architecture-doc.md) for the full details.

## Deploying to Kubernetes

AX ships with a production-ready Helm chart. Here's how to get it running on your cluster.

### Prerequisites

- Kubernetes cluster (GKE, EKS, AKS, kind, minikube — we're not picky)
- Helm 3.x
- `kubectl` configured for your cluster
- A PostgreSQL database (Cloud SQL, RDS, self-hosted, whatever you've got)
- Container images built and pushed to a registry your cluster can pull from

### 1. Build and Push the Container Image

```bash
# Build the project first
npm run build

# Build the container image
docker build -f container/Dockerfile -t your-registry/ax:latest .

# Push to your registry
docker push your-registry/ax:latest
```

The same image is used for all pod types — host, agent-runtime, pool-controller, and sandbox workers. The entrypoint is overridden per deployment via the Helm chart.

### 2. Create Kubernetes Secrets

AX needs up to three secrets: a registry pull secret (if your images are in a private registry), a database credential, and your LLM API keys.

#### Registry Pull Secret (Private Registries)

If your container images live in a private registry (GitLab, GitHub Container Registry, AWS ECR, etc.), Kubernetes needs credentials to pull them. For GitLab, create a [deploy token](https://docs.gitlab.com/ee/user/project/deploy_tokens/) with `read_registry` scope, then:

```bash
kubectl create secret docker-registry ax-registry-credentials \
  --namespace ax \
  --docker-server=registry.gitlab.com \
  --docker-username=<deploy-token-name> \
  --docker-password=<deploy-token-password> \
  --docker-email=<your-email>
```

For other registries, swap out `--docker-server`:

| Registry | Server |
|----------|--------|
| GitLab | `registry.gitlab.com` |
| GitHub | `ghcr.io` |
| AWS ECR | `<account-id>.dkr.ecr.<region>.amazonaws.com` |
| Google GCR | `gcr.io` |
| Docker Hub | `https://index.docker.io/v1/` |

Then tell Kubernetes to use it for every pod in the namespace by patching the default service account:

```bash
kubectl patch serviceaccount default -n ax \
  -p '{"imagePullSecrets": [{"name": "ax-registry-credentials"}]}'
```

This way you don't need to add `imagePullSecrets` to every pod spec — any pod in the `ax` namespace will automatically use the credentials. If you're using a public registry, skip this step entirely.

#### Database Credentials

If you're using an **external PostgreSQL** (Cloud SQL, RDS, etc.), create a secret with the connection URL:

```bash
kubectl create secret generic ax-db-credentials \
  --namespace ax \
  --from-literal=url="postgresql://ax:yourpassword@your-db-host:5432/ax"
```

If you're using the **internal Bitnami PostgreSQL** subchart (`postgresql.internal.enabled: true`), skip this — the chart automatically constructs `DATABASE_URL` from the subchart's generated password secret.

#### API Credentials

```bash
# Add whichever providers you use — missing keys won't crash pods
kubectl create secret generic ax-api-credentials \
  --namespace ax \
  --from-literal=anthropic-api-key="sk-ant-..." \
  --from-literal=openrouter-api-key="sk-or-..." \
  --from-literal=openai-api-key="sk-..."
```

API credential keys are optional — if you only use Anthropic, you don't need to include the others. Credentials never enter sandbox containers — they're injected server-side into the agent-runtime pods only.

### 3. Create a Values File

Create a `my-values.yaml` to override the defaults. At minimum, point the images at your registry:

```yaml
# my-values.yaml

# Set image tag once for all components (host, agent-runtime, pool-controller)
global:
  imageTag: "latest"

host:
  image:
    repository: your-registry/ax

agentRuntime:
  image:
    repository: your-registry/ax

poolController:
  image:
    repository: your-registry/ax

sandbox:
  image:
    repository: your-registry/ax
    tag: latest
  # Set to "" if your cluster doesn't have gVisor (kind, minikube, etc.)
  runtimeClass: "gvisor"

# AX application config (rendered as ax.yaml ConfigMap)
config:
  profile: paranoid
  models:
    default: ["anthropic/claude-sonnet-4-20250514"]
  providers:
    sandbox: k8s
    database: postgresql
    storage: database
    eventbus: nats
    audit: database
    scanner: patterns

# PostgreSQL — external database (or set internal.enabled: true for Bitnami subchart)
postgresql:
  external:
    enabled: true
    existingSecret: "ax-db-credentials"
    secretKey: "url"
  internal:
    enabled: false

# API credentials secret
apiCredentials:
  existingSecret: "ax-api-credentials"
  envVars:
    ANTHROPIC_API_KEY: "anthropic-api-key"
```

### 4. Install with Helm

```bash
# Update Helm dependencies (pulls NATS subchart)
helm dependency update ./charts/ax

# Install
helm install ax ./charts/ax -f my-values.yaml --namespace ax --create-namespace
```

### 5. Verify the Deployment

```bash
# Check that all pods are running
kubectl get pods -n ax

# You should see:
#   ax-host-xxx          — HTTP ingress (x2)
#   ax-agent-runtime-xxx — conversation layer (x3)
#   ax-pool-controller-xxx — sandbox pool manager (x1)
#   ax-nats-xxx          — NATS JetStream (x3)
#   ax-sandbox-light-xxx — warm sandbox pods (x2, managed by pool controller)

# Verify the host is healthy
kubectl port-forward -n ax svc/ax-host 8080:80 &
curl http://localhost:8080/health

# Check NATS streams were created
kubectl exec -n ax ax-nats-0 -- nats stream ls
# Should show: SESSIONS, TASKS, RESULTS, EVENTS, IPC
```

### Architecture Overview

The Helm chart deploys a three-layer architecture:

| Layer | Pods | Role |
|-------|------|------|
| **Ingress** | `host` | Stateless HTTP API. Routes requests, streams SSE events. No LLM calls, no credentials. |
| **Conversation** | `agent-runtime` | Runs agent sessions, makes LLM calls, dispatches tools to sandbox pods via NATS. |
| **Execution** | `sandbox` (ephemeral) | Isolated tool execution. No network, no credentials, no host filesystem. gVisor runtime. |

Communication between layers flows through **NATS JetStream**. PostgreSQL provides shared persistent state. The pool controller maintains a warm pool of sandbox pods so tool execution doesn't wait for cold starts.

### Key Configuration

| Value | Default | Description |
|-------|---------|-------------|
| `host.replicas` | 2 | Host pod count (stateless, scale freely) |
| `agentRuntime.replicas` | 3 | Agent runtime pods (each handles multiple sessions) |
| `sandbox.runtimeClass` | `"gvisor"` | Set to `""` for clusters without gVisor |
| `sandbox.tiers.light.minReady` | 2 | Warm sandbox pods kept ready |
| `sandbox.tiers.light.maxReady` | 10 | Maximum warm sandbox pods |
| `sandbox.tiers.heavy.minReady` | 0 | Heavy-tier pods (on-demand by default) |
| `networkPolicies.enabled` | true | Enforce zero-egress on sandbox pods |
| `nats.config.cluster.replicas` | 3 | NATS cluster size |
| `host.autoscaling.enabled` | false | Enable HPA for host pods |
| `agentRuntime.autoscaling.enabled` | false | Enable HPA for agent-runtime pods |

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
  --set nats.config.cluster.replicas=1 \
  --set host.replicas=1 \
  --set agentRuntime.replicas=1
```

Note: kind doesn't support gVisor, so sandbox pods run without runtime isolation. Fine for development — not recommended for production.

### GCS Workspace Provider (Kubernetes)

AX supports Google Cloud Storage as a persistent workspace backend — files your agent creates survive pod restarts, rescheduling, and even cluster recreation. Here's how to set it up.

#### Prerequisites

- A GCS bucket (the agent needs read/write access)
- GKE with [Workload Identity](https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity) enabled (recommended), or a service account key

#### 1. Create a GCS Bucket

```bash
# Pick a globally unique name
export GCS_BUCKET=ax-workspaces-yourproject

gcloud storage buckets create gs://$GCS_BUCKET \
  --location=us-central1 \
  --uniform-bucket-level-access
```

#### 2. Set Up GCS Authentication

**Option A: GKE Workload Identity (recommended)**

This is the zero-secrets approach. The Kubernetes service account gets mapped to a GCP IAM service account that has bucket access.

```bash
# Create a GCP service account for AX
gcloud iam service-accounts create ax-workspace \
  --display-name="AX Workspace Writer"

# Grant it access to the bucket
gcloud storage buckets add-iam-policy-binding gs://$GCS_BUCKET \
  --member="serviceAccount:ax-workspace@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/storage.objectUser"

# Bind the GCP SA to the Kubernetes SA
gcloud iam service-accounts add-iam-policy-binding \
  ax-workspace@YOUR_PROJECT.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:YOUR_PROJECT.svc.id.goog[ax/ax-agent-runtime]"
```

Then annotate the agent-runtime service account in your values file:

```yaml
# my-values.yaml
agentRuntime:
  env:
    - name: GCS_WORKSPACE_BUCKET
      value: "ax-workspaces-yourproject"
```

And add the Workload Identity annotation to the service account template (or patch it after install):

```bash
kubectl annotate serviceaccount ax-agent-runtime -n ax \
  iam.gke.io/gcp-service-account=ax-workspace@YOUR_PROJECT.iam.gserviceaccount.com
```

**Option B: Service Account Key (non-GKE clusters)**

If you're not on GKE, create a key file and mount it:

```bash
# Create and download a key
gcloud iam service-accounts keys create gcs-key.json \
  --iam-account=ax-workspace@YOUR_PROJECT.iam.gserviceaccount.com

# Create a Kubernetes secret from it
kubectl create secret generic ax-gcs-credentials \
  --namespace ax \
  --from-file=key.json=gcs-key.json
```

Then add the secret mount and env var to your values:

```yaml
agentRuntime:
  env:
    - name: GCS_WORKSPACE_BUCKET
      value: "ax-workspaces-yourproject"
    - name: GOOGLE_APPLICATION_CREDENTIALS
      value: "/etc/gcs/key.json"
```

You'll also need to add a volume and volumeMount to the agent-runtime deployment (post-install patch or chart template override).

#### 3. Configure AX for GCS Workspaces

Add the workspace provider to your Helm values:

```yaml
# my-values.yaml
config:
  providers:
    workspace: gcs
  workspace:
    bucket: "ax-workspaces-yourproject"
    # prefix: "production/"  # optional — namespaces objects within the bucket
    # maxFileSize: 10485760  # optional — 10MB default
    # maxFiles: 1000         # optional
```

Or skip the config-level `bucket` and set `GCS_WORKSPACE_BUCKET` as an env var on the agent-runtime pods (shown above). The env var works as a fallback when `workspace.bucket` isn't in config.

#### 4. Deploy

```bash
helm upgrade --install ax ./charts/ax -f my-values.yaml --namespace ax --create-namespace
```

#### 5. Verify Workspaces Are Working

```bash
# Port-forward to the host
kubectl port-forward -n ax svc/ax-host 8080:80 &

# Send a message asking the agent to create a file
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Mount your agent workspace and write a file called hello.txt with the text \"it works\""}]}'

# Check the GCS bucket
gcloud storage ls gs://$GCS_BUCKET/agent/
# You should see: gs://ax-workspaces-yourproject/agent/main/hello.txt
```

Workspace files are organized in GCS as `<prefix>/<scope>/<id>/<path>` — where scope is `agent`, `user`, or `session`, and id is the agent name or session identifier.

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

Most agent turns are simple — call an API, answer a question, look something up. They don't need a full sandbox container with network isolation, GCS workspace sync, and a MITM proxy. That's like renting a U-Haul to pick up a coffee.

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

Use the CLI to register MCP servers for an agent:

```bash
# Add an MCP server
ax mcp add main linear --url http://linear-mcp.example.com/mcp \
  --header "Authorization: Bearer {LINEAR_API_KEY}"

# Add another server for the same agent
ax mcp add main github --url http://github-mcp.example.com/mcp \
  --header "Authorization: Bearer {GITHUB_TOKEN}"

# List configured servers
ax mcp list main

# Test connectivity
ax mcp test main linear
```

Credential placeholders like `{LINEAR_API_KEY}` are resolved from the credential provider at call time — the actual secrets never touch the database.

#### 3. Manage via Admin API

MCP servers can also be managed via the admin API:

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
ax serve              # Start the AX server
ax chat               # Interactive chat session
ax send "message"     # Send a one-shot message
ax configure          # Interactive setup wizard
ax plugin add <pkg>   # Install a provider plugin
ax plugin list        # List installed plugins
ax plugin verify      # Check plugin integrity
ax mcp add <agent> <name> --url <url>  # Add MCP server
ax mcp list <agent>   # List MCP servers
ax mcp test <agent> <name>  # Test MCP server connection
ax mcp remove <agent> <name>  # Remove MCP server
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
