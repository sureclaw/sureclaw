# Sureclaw: Project Requirements Plan (PRP)

> **Purpose:** This document is the single source of truth for what Sureclaw is, why it exists, and what it requires. It is intended to be read by Claude Code before any implementation work begins.

---

## 1. What Is Sureclaw?

Sureclaw is a **security-first personal AI agent** that lets you message an AI assistant (via WhatsApp, Telegram, CLI, etc.) and have it take actions on your behalf — read emails, fetch web pages, control a browser, manage your calendar, remember your preferences — while being **dramatically safer** than existing alternatives.

It is a direct response to the security catastrophe of **OpenClaw** (~173,000 LOC, 52+ modules, 42,665 exposed instances on Shodan, CVE-2026-25253 RCE, 341 malicious marketplace skills) and the limitations of **NanoClaw** (~500 LOC, secure but locked to a single vendor and channel).

Sureclaw threads the needle: **small enough to audit in a day, secure by default at the kernel level, model-agnostic, and extensible without the supply chain nightmare.**

---

## 2. Design Philosophy

### 2.1 Core Principles

| # | Principle | Rationale |
|---|-----------|-----------|
| 1 | **Isolation is the only security** | Application-level checks (allowlists, pairing codes) failed catastrophically in OpenClaw. Kernel-level sandbox isolation is the only defense that survives prompt injection. |
| 2 | **Small enough to read** | If you can't read the whole codebase in a sitting, you can't trust it. Target: <2,000 LOC for core, ~4,150 LOC total with all providers. |
| 3 | **No Control UI** | OpenClaw's web dashboard was the #1 attack vector (CVE-2026-25253). Eliminate it entirely. Admin via CLI or the main chat channel only. |
| 4 | **Credentials never enter the container** | Solved via a credential proxy. API keys and OAuth tokens are injected server-side by the host process. The agent never sees them. |
| 5 | **Model-agnostic** | No vendor lock-in. Support Claude, GPT, Gemini, local models via a unified provider interface. |
| 6 | **No marketplace** | ClawHub's open-upload model led to 341 malicious skills. Skills are local files you write or vet yourself. |
| 7 | **Deny-by-default networking** | Agent containers have NO outbound network access. All external communication goes through the host's IPC proxy. |
| 8 | **Data and instructions are separated** | External content (emails, web pages, docs) is wrapped in taint markers. The agent is instructed to treat tainted content as data, not instructions. |
| 9 | **Security is a dial, not a switch** | Three configuration profiles (Paranoid, Standard, Power User) let users trade isolation for capability. Architectural invariants hold at all levels. |
| 10 | **Plan before you build** | Every feature starts with interface design and threat modeling. Implementation follows the plan. |

### 2.2 Architectural Invariants

These properties are enforced by the architecture and **cannot** be weakened by configuration:

- Agent container has **no network**. No config flag grants direct internet access.
- Credentials **never** enter containers. No env vars, no file mounts, at any profile level.
- All external content is **taint-tagged**. Scanners always run, even on stub providers.
- Every action is **audited**. The container cannot modify the audit log.
- The agent **cannot modify its own sandbox**. No IPC action exists to change isolation level.
- **No web UI exists**. This is a permanent architectural decision.
- Proactive actions use the **same pipeline** as user actions. Scanning, sandboxing, and auditing apply equally.

---

## 3. Provider Contract Pattern

This is the core architectural pattern. Every major subsystem follows the same shape:

1. A **TypeScript interface** (the contract)
2. A **"null" or minimal implementation** (ships with core, works immediately)
3. One or more **real implementations** (added incrementally)

The host process loads providers at startup from config. You start with all stubs → everything works → swap providers one at a time → test as you go.

### 3.1 Provider Categories

| Provider | Purpose | Stage 0 (Default) | Later Stages |
|----------|---------|-------------------|--------------|
| **LLM** | Talk to language models | `anthropic` | `openai`, `multi` (router) |
| **Memory** | Long-term knowledge storage | `file` (markdown + grep) | `sqlite` (FTS5), `memu` (knowledge graph) |
| **Scanner** | Injection detection, canary tokens | `basic` (regex) | `patterns` (expanded library), `promptfoo` (ML) |
| **Channel** | Message ingress/egress | `cli` (stdin/stdout) | `whatsapp`, `telegram`, `discord` |
| **Web** | External content retrieval | `none` (stub) | `fetch` (proxied), `search` (API) |
| **Browser** | Headless browser control | `none` (stub) | `container` (sandboxed Playwright) |
| **Credential** | Secret storage and injection | `env` (process.env) | `encrypted` (AES-256), `keychain` (OS) |
| **Skill Store** | Skill versioning and self-modification | `readonly` | `git` (proposal-review-commit) |
| **Audit** | Action logging | `file` (JSONL append) | `sqlite` (queryable) |
| **Sandbox** | Agent process isolation | `subprocess` (dev) / `seatbelt` (macOS) / `nsjail` (Linux) | `docker` (gVisor), `firecracker` |
| **Scheduler** | Proactive behavior | `none` (stub) | `cron` (jobs + heartbeats), `full` (events + memory hints) |

---

## 4. Sandbox Strategy

Most agent invocations are lightweight: read context → IPC call to host → return text. Full Docker containers are overkill.

### 4.1 Tiered Sandbox Provider

| Platform | Default (lightweight) | Escalation (heavy workloads) |
|----------|----------------------|------------------------------|
| **Linux** | **nsjail** (~5ms start, ~1MB) — Linux namespaces + seccomp-bpf | Docker + gVisor, or Firecracker microVM |
| **macOS** | **Seatbelt** (`sandbox-exec`, ~0ms, weaker isolation) | Docker Desktop fallback |

### 4.2 nsjail Key Properties (Linux Default)

- `clone_newnet: true` — **NO NETWORK** (the critical invariant)
- `clone_newuser`, `clone_newns`, `clone_newpid` — full namespace isolation
- Filesystem: bind-mount only `/workspace` (rw), `/skills` (ro), `/ipc/proxy.sock`
- seccomp-bpf: tiny allowlist of syscalls needed by Node.js
- Resource limits via cgroups: CPU time, memory, file descriptors

### 4.3 Escalation

The host picks sandbox level based on the invocation:
- **nsjail** (default): LLM calls, text generation, memory queries. 95% of invocations.
- **Docker + gVisor**: Sessions needing package installation, complex file ops, heavy tool use.
- **Firecracker**: Multi-tenant hosting. Hardware isolation.

Escalation can happen mid-session: start in nsjail, escalate to Docker if the agent requests heavy tools.

---

## 5. Security Model Summary

### 5.1 Trust Zones

| Zone | Trust Level | Network | Credentials |
|------|-------------|---------|-------------|
| Host Process | Fully trusted | Full outbound | Reads from OS keychain |
| Agent Container | **Untrusted** | **NONE** | **NONE** — via proxy only |
| Browser Container | Untrusted | Filtered egress (allowlist) | Injected per-request by host |
| memU Container | Semi-trusted | Localhost (PostgreSQL) | LLM via host proxy |

### 5.2 Trust Boundary Crossings

Every crossing passes through a host-side mediator. No direct container-to-container connections.

Key crossings: User→Agent (router+scanner), Agent→LLM (credential proxy), Agent→Web (fetch proxy with DNS pinning), Agent→Browser (structured command mediator), Agent→Skills (proposal-review-commit), Scheduler→Agent (same pipeline as user messages).

### 5.3 Configuration Profiles

| Dimension | Paranoid (Default) | Standard | Power User |
|-----------|-------------------|----------|------------|
| Browser | Disabled | Blocklist egress | Unrestricted |
| Web fetch | Allowlist (empty) | Blocklist | Unrestricted |
| OAuth | None | Read-only | Read-write |
| Skill modification | Read-only | Proposal-review-commit | Relaxed auto-approve |
| Proactive behavior | Disabled | Cron + heartbeats | Full triggers + memory hints |

### 5.4 Known Residual Risks

- **Prompt injection is fundamentally unsolved.** Taint tags + scanners reduce blast radius but can't prevent a sufficiently clever injection. Sureclaw's contribution is making the blast radius dramatically smaller.
- **Taint tag compliance is voluntary.** LLMs follow instructions statistically, not structurally.
- **Host process is single point of trust.** ~4,150 LOC is auditable but not formally verified.
- **Container runtime is a trust assumption.** gVisor/nsjail escape CVEs are rare but documented.

---

## 6. Proactive Behavior

### 6.1 Scheduler Provider

Three patterns, all flowing through the same sandboxed pipeline as user messages:

1. **Cron jobs** — "Send me a briefing at 7 AM every day"
2. **Heartbeats** — "Wake up every 30 minutes, check if anything needs attention"
3. **Memory-driven hints** — via memU proactive bridge (pending tasks, temporal patterns, relationship follow-ups)

### 6.2 ProactiveHint Interface

```typescript
interface ProactiveHint {
  source: 'memory' | 'pattern' | 'trigger';
  kind: 'pending_task' | 'temporal_pattern' | 'follow_up' | 'anomaly' | 'custom';
  reason: string;
  suggestedPrompt: string;
  confidence: number;        // 0-1, from memU retrieval relevance
  scope: string;
  memoryId?: string;
  cooldownMinutes?: number;  // default: 60
}
```

### 6.3 Controls

- Budget caps per invocation (`maxTokenBudget`)
- Active hours enforcement
- Cooldown dedup (prevents re-firing same hint within window)
- Confidence thresholds (default: 0.8)
- Full audit logging of all fired/suppressed hints

---

## 7. Self-Modifying Skills

Skills follow a **proposal-review-commit** pattern (like code changes in a production codebase):

1. Agent **proposes** changes via IPC (writes to staging area, NOT directly to skill files)
2. Host **validates** automatically: taint analysis, injection scanning, capability escalation check, semantic diff
3. Verdict: `AUTO_APPROVE` / `NEEDS_REVIEW` / `REJECT`
4. If approved: **git commit** with full version history
5. Hard-reject patterns (shell commands, base64, eval) **cannot be overridden**
6. Cumulative drift detection catches slow poisoning via many small changes

---

## 8. Staged Implementation Plan

| Stage | Description | LOC Added | Key Deliverables |
|-------|-------------|-----------|------------------|
| **0** | Walking skeleton | ~1,200 | CLI chat, Docker sandbox, Anthropic LLM, file memory, basic scanner, canary tokens, JSONL audit, taint tracking |
| **1** | Real messaging + web | ~600 | WhatsApp, proxied web fetch, encrypted creds, cron/heartbeats |
| **2** | Multi-model + search + API | ~450 | OpenAI provider, model router, search API, completions gateway |
| **3** | Advanced security + skills | ~650 | Pattern library scanner, git-backed proposal-review-commit skills |
| **4** | Browser + agents + triggers | ~800 | Sandboxed Playwright, multi-agent delegation, webhook triggers, memory-driven proactive hints |
| **5** | Production integrations | ~500 | memU memory, promptfoo scanning, OS keychain credentials |

**Total: ~4,150 LOC** (vs. OpenClaw's ~173,000)

---

## 9. Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | TypeScript (Node.js) | Same as OpenClaw/NanoClaw ecosystem. Strong typing for provider contracts. |
| Sandbox (Linux) | nsjail (default), Docker+gVisor (escalation) | nsjail: ~5ms start, ~1MB. gVisor: full OCI support. |
| Sandbox (macOS) | Seatbelt (`sandbox-exec`) | Zero-dep macOS sandbox. Weaker isolation than nsjail but sufficient for local dev. |
| Database | SQLite (better-sqlite3) | Embedded, zero-config, used for message queue, memory, audit. |
| Config | YAML (sureclaw.yaml) | Human-readable, well-supported. |
| IPC | Unix domain socket | Host→container communication. No network needed. |
| Skills version control | git (isomorphic-git) | Proposal-review-commit with full history. |

---

## 10. What We Explicitly Do NOT Build

| Feature | Reason |
|---------|--------|
| Web control UI | #1 attack vector in OpenClaw. Admin via CLI + chat only. |
| Marketplace / skill registry | Supply chain nightmare. Local skills only. |
| `auth: "none"` mode | Sandbox is mandatory. No escape hatch. |
| Social network (Moltbook) | Attack surface amplifier. Out of scope. |
| VS Code extension | Nothing to impersonate. |
| Listening ports (by default) | Host is outbound-only. Completions API is opt-in, Unix socket default. |
