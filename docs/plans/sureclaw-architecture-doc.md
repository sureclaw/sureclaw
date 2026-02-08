# Sureclaw: Architecture Document

> **Purpose:** This is the implementation-level architecture reference for Claude Code. It describes every component, interface, data flow, and file location. Read the PRP first for context.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       HOST PROCESS (Node.js)                        │
│                    (the only thing on your machine)                  │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Channel:  │  │ Channel: │  │ Channel: │  │  Completions     │   │
│  │ CLI       │  │ WhatsApp │  │ Telegram │  │  Gateway (opt-in)│   │
│  └─────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬──────────┘  │
│        └──────────────┴─────────────┴────────────────┘             │
│                              │                                      │
│                    ┌─────────▼──────────┐                           │
│                    │   Message Router    │                           │
│                    │   + Taint Tracker   │                           │
│                    └─────────┬──────────┘                           │
│                              │                                      │
│                    ┌─────────▼──────────┐                           │
│                    │   Scanner Provider  │  ← input scanning        │
│                    └─────────┬──────────┘                           │
│                              │                                      │
│                    ┌─────────▼──────────┐                           │
│                    │  Sandbox Launcher   │  ← nsjail/Docker/Seatbelt│
│                    └─────────┬──────────┘                           │
│                              │                                      │
│  ┌───────────────────────────▼──────────────────────────────────┐  │
│  │              IPC Proxy (Unix socket)                          │  │
│  │  Dispatches container requests to host-side providers:        │  │
│  │  • LLM calls → Credential Proxy → API                        │  │
│  │  • Memory read/write → Memory Provider                        │  │
│  │  • Web fetch → Web Provider (DNS pinning, taint tagging)      │  │
│  │  • Browser commands → Browser Provider (structured only)      │  │
│  │  • Skill proposals → Skill Store (validate, stage, commit)    │  │
│  │  • OAuth calls → Credential Provider (scope-validated)        │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌────────────────────┐  ┌──────────────────┐  ┌────────────────┐ │
│  │  Audit Provider     │  │  Scheduler       │  │  Credential    │ │
│  │  (append-only log)  │  │  (cron/heartbeat)│  │  Provider      │ │
│  └────────────────────┘  └──────────────────┘  └────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       ┌────────────┐ ┌────────────┐ ┌────────────┐
       │  Sandbox    │ │  Sandbox   │ │  Sandbox   │
       │  (nsjail/   │ │            │ │            │
       │   Docker)   │ │            │ │            │
       │             │ │            │ │            │
       │ agent-runner│ │            │ │            │
       │ ipc-client  │ │            │ │            │
       │             │ │            │ │            │
       │ Mounts:     │ │            │ │            │
       │  /workspace │ │            │ │            │
       │  /skills(ro)│ │            │ │            │
       │  /ipc (sock)│ │            │ │            │
       │             │ │            │ │            │
       │ NO network  │ │ NO network │ │ NO network │
       │ NO env vars │ │ NO env vars│ │ NO env vars│
       └────────────┘ └────────────┘ └────────────┘
```

---

## 2. Provider Contracts

All interfaces live in `src/providers/types.ts`. Each provider category gets its own subdirectory under `src/providers/`.

```typescript
// src/providers/types.ts — The interfaces that define everything

// ── LLM Provider ──────────────────────────────────────
export interface LLMProvider {
  name: string;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  models(): Promise<string[]>;
}

// ── Memory Provider ───────────────────────────────────
export interface MemoryProvider {
  write(entry: MemoryEntry): Promise<string>;       // returns ID
  query(q: MemoryQuery): Promise<MemoryEntry[]>;
  read(id: string): Promise<MemoryEntry | null>;
  delete(id: string): Promise<void>;
  list(scope: string, limit?: number): Promise<MemoryEntry[]>;
  onProactiveHint?(handler: (hint: ProactiveHint) => void): void;
}

// ── Scanner Provider ──────────────────────────────────
export interface ScannerProvider {
  scanInput(msg: ScanTarget): Promise<ScanResult>;
  scanOutput(msg: ScanTarget): Promise<ScanResult>;
  canaryToken(): string;
  checkCanary(output: string, token: string): boolean;
}

// ── Channel Provider ──────────────────────────────────
export interface ChannelProvider {
  name: string;
  connect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  send(target: string, content: OutboundMessage): Promise<void>;
  disconnect(): Promise<void>;
}

// ── Web Provider ──────────────────────────────────────
export interface WebProvider {
  fetch(req: FetchRequest): Promise<FetchResponse>;
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}

// ── Browser Provider ──────────────────────────────────
export interface BrowserProvider {
  launch(config: BrowserConfig): Promise<BrowserSession>;
  navigate(session: string, url: string): Promise<void>;
  snapshot(session: string): Promise<PageSnapshot>;
  click(session: string, ref: number): Promise<void>;
  type(session: string, ref: number, text: string): Promise<void>;
  screenshot(session: string): Promise<Buffer>;
  close(session: string): Promise<void>;
}

// ── Credential Provider ───────────────────────────────
export interface CredentialProvider {
  get(service: string): Promise<string | null>;
  set(service: string, value: string): Promise<void>;
  delete(service: string): Promise<void>;
  list(): Promise<string[]>;
}

// ── Skill Store Provider ──────────────────────────────
export interface SkillStoreProvider {
  list(): Promise<SkillMeta[]>;
  read(name: string): Promise<string>;
  propose(proposal: SkillProposal): Promise<ProposalResult>;
  approve(proposalId: string): Promise<void>;
  reject(proposalId: string): Promise<void>;
  revert(commitId: string): Promise<void>;
  log(opts?: LogOptions): Promise<SkillLogEntry[]>;
}

// ── Audit Provider ────────────────────────────────────
export interface AuditProvider {
  log(entry: AuditEntry): Promise<void>;
  query(filter: AuditFilter): Promise<AuditEntry[]>;
}

// ── Sandbox Provider ──────────────────────────────────
export interface SandboxProvider {
  spawn(config: SandboxConfig): Promise<SandboxProcess>;
  kill(pid: number): Promise<void>;
  isAvailable(): Promise<boolean>;
}

// ── Scheduler Provider ────────────────────────────────
export interface SchedulerProvider {
  start(router: MessageRouter, registry: ProviderRegistry): Promise<void>;
  stop(): Promise<void>;
  addCron?(job: CronJobDef): void;
  removeCron?(jobId: string): void;
  listJobs?(): CronJobDef[];
}

// ── ProactiveHint (used by memory → scheduler bridge) ─
export interface ProactiveHint {
  source: 'memory' | 'pattern' | 'trigger';
  kind: 'pending_task' | 'temporal_pattern' | 'follow_up' | 'anomaly' | 'custom';
  reason: string;
  suggestedPrompt: string;
  confidence: number;
  scope: string;
  memoryId?: string;
  cooldownMinutes?: number;
}
```

---

## 3. Provider Registry

```typescript
// src/registry.ts

import type * as P from './providers/types';

export interface ProviderRegistry {
  llm: P.LLMProvider;
  memory: P.MemoryProvider;
  scanner: P.ScannerProvider;
  channels: P.ChannelProvider[];
  web: P.WebProvider;
  browser: P.BrowserProvider;
  credentials: P.CredentialProvider;
  skills: P.SkillStoreProvider;
  audit: P.AuditProvider;
  sandbox: P.SandboxProvider;
  scheduler: P.SchedulerProvider;
}

export async function loadProviders(config: Config): Promise<ProviderRegistry> {
  return {
    llm:         await loadProvider('llm', config.providers.llm, config),
    memory:      await loadProvider('memory', config.providers.memory, config),
    scanner:     await loadProvider('scanner', config.providers.scanner, config),
    channels:    await Promise.all(
                   config.providers.channels.map(c => loadProvider('channel', c, config))
                 ),
    web:         await loadProvider('web', config.providers.web, config),
    browser:     await loadProvider('browser', config.providers.browser, config),
    credentials: await loadProvider('credentials', config.providers.credentials, config),
    skills:      await loadProvider('skills', config.providers.skills, config),
    audit:       await loadProvider('audit', config.providers.audit, config),
    sandbox:     await loadProvider('sandbox', config.providers.sandbox, config),
    scheduler:   await loadProvider('scheduler', config.providers.scheduler, config),
  };
}

async function loadProvider(kind: string, name: string, config: Config) {
  // Each provider category is its own subdirectory
  // e.g., 'llm' + 'anthropic' → import('./providers/llm/anthropic')
  const mod = await import(`./providers/${kind}/${name}`);
  return mod.create(config);
}
```

---

## 4. Configuration

```yaml
# sureclaw.yaml

providers:
  llm: anthropic              # providers/llm/anthropic.ts
  memory: file                # providers/memory/file.ts
  scanner: basic              # providers/scanner/basic.ts
  channels: [cli]             # providers/channel/cli.ts
  web: none                   # providers/web/none.ts
  browser: none               # providers/browser/none.ts
  credentials: env            # providers/credentials/env.ts
  skills: readonly            # providers/skills/readonly.ts
  audit: file                 # providers/audit/file.ts
  sandbox: subprocess          # providers/sandbox/subprocess.ts (or seatbelt/nsjail/docker)
  scheduler: none             # providers/scheduler/none.ts

# Profile presets (paranoid | standard | power-user)
profile: paranoid

# Agent definitions
agents:
  assistant:
    model: claude-sonnet-4-20250514
    personality: agents/assistant/AGENT.md
    capabilities: agents/assistant/capabilities.yaml

# Sandbox settings
sandbox:
  timeout_sec: 120
  memory_mb: 512
  seccomp_policy: policies/agent.kafel  # nsjail only

# Scheduler settings (when scheduler != none)
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "America/New_York" }
  max_token_budget: 4096
  heartbeat_interval_min: 30

# Web access (when web != none)
web:
  mode: blocklist             # allowlist | blocklist | unrestricted
  blocklist: ["*.internal", "10.*", "169.254.*"]
```

---

## 5. File Structure

```
sureclaw/
├── src/
│   ├── host.ts                        # Main loop, startup, shutdown (~200)
│   ├── router.ts                      # Message routing + taint tracking (~150)
│   ├── ipc.ts                         # IPC proxy — dispatches to providers (~200)
│   ├── registry.ts                    # Dynamic provider loading (~80)
│   ├── config.ts                      # YAML config parser (~50)
│   ├── db.ts                          # SQLite message queue (~80)
│   ├── completions.ts                 # Chat completions gateway [Stage 2] (~200)
│   │
│   └── providers/
│       ├── types.ts                   # All provider interfaces (~200)
│       │
│       ├── llm/                       # ── LLM Providers ──────────────
│       │   ├── anthropic.ts           # Direct Anthropic API (~80) [Stage 0]
│       │   ├── openai.ts             # OpenAI-compatible API (~80) [Stage 2]
│       │   └── multi.ts              # Model router (~120) [Stage 2]
│       │
│       ├── memory/                    # ── Memory Providers ───────────
│       │   ├── file.ts               # Markdown files + grep (~100) [Stage 0]
│       │   ├── sqlite.ts             # SQLite + FTS5 (~150) [Stage 1]
│       │   └── memu.ts              # memU integration + proactive bridge (~200) [Stage 5]
│       │
│       ├── scanner/                   # ── Scanner Providers ──────────
│       │   ├── basic.ts              # Regex + canary tokens (~60) [Stage 0]
│       │   ├── patterns.ts           # Expanded pattern library (~150) [Stage 3]
│       │   └── promptfoo.ts          # ML-based detection (~200) [Stage 5]
│       │
│       ├── channel/                   # ── Channel Providers ──────────
│       │   ├── cli.ts                # stdin/stdout (~40) [Stage 0]
│       │   ├── whatsapp.ts           # Baileys WhatsApp (~80) [Stage 1]
│       │   ├── telegram.ts           # Telegram Bot API (~80) [Stage 2]
│       │   └── discord.ts            # Discord.js (~80) [Stage 2]
│       │
│       ├── web/                       # ── Web Providers ─────────────
│       │   ├── none.ts               # Stub (~10) [Stage 0]
│       │   ├── fetch.ts              # Proxied fetch + DNS pinning (~100) [Stage 1]
│       │   └── search.ts            # Search API integration (~50) [Stage 2]
│       │
│       ├── browser/                   # ── Browser Providers ─────────
│       │   ├── none.ts               # Stub (~10) [Stage 0]
│       │   └── container.ts          # Sandboxed Playwright (~250) [Stage 4]
│       │
│       ├── credentials/               # ── Credential Providers ──────
│       │   ├── env.ts                # Read from process.env (~30) [Stage 0]
│       │   ├── encrypted.ts          # AES-256 encrypted file (~80) [Stage 1]
│       │   └── keychain.ts           # OS keychain integration (~100) [Stage 5]
│       │
│       ├── skills/                    # ── Skill Store Providers ─────
│       │   ├── readonly.ts           # Read .md files, no modification (~30) [Stage 0]
│       │   └── git.ts               # Proposal-review-commit + git (~500) [Stage 3]
│       │
│       ├── audit/                     # ── Audit Providers ───────────
│       │   ├── file.ts               # Append JSONL (~30) [Stage 0]
│       │   └── sqlite.ts            # Queryable SQLite log (~80) [Stage 1]
│       │
│       ├── sandbox/                   # ── Sandbox Providers ─────────
│       │   ├── subprocess.ts        # No isolation, dev only (~50) [Stage 0, Dev]
│       │   ├── seatbelt.ts          # macOS sandbox-exec (~80) [Stage 0, macOS]
│       │   ├── nsjail.ts            # Linux namespaces + seccomp (~100) [Stage 0, Linux]
│       │   └── docker.ts            # Docker + gVisor (~150) [Stage 0 alt]
│       │
│       └── scheduler/                 # ── Scheduler Providers ───────
│           ├── none.ts               # Stub (~10) [Stage 0]
│           ├── cron.ts              # Cron jobs + heartbeats (~120) [Stage 1]
│           └── full.ts              # Events + memory-driven hints (~250) [Stage 4]
│
├── container/                         # Runs inside sandbox
│   ├── Dockerfile                     # Minimal image (~30)
│   ├── agent-runner.ts                # Model-agnostic agent loop (~250)
│   └── ipc-client.ts                 # IPC client for container (~100)
│
├── policies/                          # Sandbox policies
│   ├── agent.kafel                    # nsjail seccomp-bpf policy
│   └── agent.sb                       # macOS Seatbelt profile
│
├── agents/                            # Agent definitions
│   └── assistant/
│       ├── AGENT.md                   # Personality and instructions
│       └── capabilities.yaml          # Allowed tools, scopes, limits
│
├── skills/                            # Read-only skill files
│   └── default.md                     # Base personality + safety rules
│
├── data/                              # Runtime data (gitignored)
│   ├── messages.db                    # SQLite message queue
│   ├── memory/                        # Memory storage
│   ├── audit/                         # Audit logs
│   └── sessions/                      # Per-session workspaces
│
├── sureclaw.yaml                     # Main config
├── package.json
└── tsconfig.json
```

### 5.1 Provider Loading Convention

Each provider subdirectory contains one file per implementation. The file exports a `create(config: Config)` function that returns the provider instance.

```typescript
// Example: src/providers/llm/anthropic.ts
import type { LLMProvider, Config } from '../types';

export async function create(config: Config): Promise<LLMProvider> {
  const apiKey = await config.registry.credentials.get('anthropic');
  return {
    name: 'anthropic',
    async *chat(req) { /* ... */ },
    async models() { return ['claude-sonnet-4-20250514', /* ... */]; },
  };
}
```

The registry resolves providers by path: `providers/${kind}/${name}`. So config `llm: anthropic` loads `src/providers/llm/anthropic.ts`.

---

## 6. Core Host Components

### 6.1 host.ts (~200 LOC)

Main entry point. Responsibilities:
- Parse config (`sureclaw.yaml`)
- Load providers via registry
- Start channels (call `connect()` on each)
- Start scheduler
- Main message loop: channel message → router → sandbox → response → channel
- Graceful shutdown

### 6.2 router.ts (~150 LOC)

Taint-aware message routing. Responsibilities:
- Determine target session (main vs. group)
- Inject canary token into system prompt
- Wrap external content in taint markers: `<external_content trust="external" source="...">`
- Pass through scanner (input side)
- After agent response: pass through scanner (output side), check canary
- Route response back to originating channel

### 6.3 ipc.ts (~200 LOC)

The IPC proxy is the **critical security boundary**. It:
- Listens on a Unix domain socket inside the container mount
- Receives JSON-RPC requests from the agent runner
- Dispatches to host-side providers (LLM, memory, web, browser, skills)
- **Injects credentials** server-side (agent never sees API keys)
- Enforces rate limits and spend caps
- Logs every call to the audit provider
- Returns results with taint metadata

Supported IPC actions:
```
llm_chat          → LLMProvider.chat()
memory_read       → MemoryProvider.read()
memory_write      → MemoryProvider.write()
memory_query      → MemoryProvider.query()
web_fetch         → WebProvider.fetch() [with DNS pinning, taint tagging]
web_search        → WebProvider.search()
browser_*         → BrowserProvider.*() [structured commands only]
skill_propose     → SkillStoreProvider.propose()
oauth_call        → CredentialProvider.get() + scoped HTTP call
```

### 6.4 db.ts (~80 LOC)

SQLite message queue (same pattern as NanoClaw). Stores pending messages, dequeued by the main loop. Ensures no message loss if the agent crashes mid-response.

### 6.5 completions.ts (~200 LOC) [Stage 2]

OpenAI-compatible `/v1/chat/completions` endpoint.
- **Default: Unix socket** (`/run/sureclaw/completions.sock`)
- Optional: localhost TCP with mandatory bearer token (opt-in, explicit config)
- Requests flow through the same router → sandbox pipeline
- Supports streaming (SSE)

---

## 7. Container Components

### 7.1 agent-runner.ts (~250 LOC)

The model-agnostic agent loop that runs inside the sandbox:

```
1. Read /workspace/CONTEXT.md for personality/memory
2. Read /skills/*.md for available skills
3. Receive message via stdin or IPC
4. Build prompt (system + context + skills + taint-tagged content + user message)
5. Call LLM via IPC (ipc.call({ action: 'llm_chat', ... }))
6. If LLM requests tool use → call tool via IPC → feed result back to LLM
7. Return final response via stdout or IPC
```

### 7.2 ipc-client.ts (~100 LOC)

Thin client that connects to the host's Unix socket and exposes typed methods:

```typescript
const llmResponse = await ipc.call({ action: 'llm_chat', messages: [...] });
const memory = await ipc.call({ action: 'memory_query', query: 'user preferences' });
const page = await ipc.call({ action: 'web_fetch', url: 'https://...' });
```

---

## 8. Data Flow: User Message → Response

```
1. User sends "summarize my inbox" via WhatsApp
2. channel-whatsapp.ts receives message, calls router
3. Router:
   a. Assigns session ID
   b. Injects canary token into system prompt
   c. Passes message through scanner (input scan)
   d. If external content involved: wraps in taint tags
4. Host spawns sandbox (nsjail by default):
   a. Bind-mount: /workspace/{session}, /skills (ro), /ipc/proxy.sock
   b. No network, no env vars, no host filesystem
5. agent-runner.ts inside sandbox:
   a. Reads context and skills
   b. Builds prompt
   c. Calls LLM via IPC → host injects API key → forwards to Anthropic
   d. LLM says "I need to read emails" → agent calls IPC: oauth_call(gmail.readonly)
   e. Host: validates scope, injects OAuth token, fetches emails, taint-tags content
   f. Agent receives taint-tagged email content
   g. LLM generates summary
   h. Agent returns response via IPC
6. Host receives response:
   a. Scanner checks output (canary leak, PII, unexpected tool calls)
   b. If clean: deliver to WhatsApp
   c. Log everything to audit provider
7. Sandbox is destroyed
```

---

## 9. Sandbox Configurations

### 9.1 nsjail (Linux Default)

```protobuf
name: "sureclaw-agent"
mode: ONCE
hostname: "AGENT"
cwd: "/workspace"
time_limit: 120
max_cpus: 1
rlimit_as: 512
rlimit_cpu: 60
rlimit_nofile: 32

clone_newnet: true       # NO NETWORK
clone_newuser: true
clone_newns: true
clone_newpid: true
clone_newipc: true
clone_newuts: true

mount { src: "{workspace}" dst: "/workspace" is_bind: true rw: true }
mount { src: "{skills}"    dst: "/skills"    is_bind: true rw: false }
mount { src: "{ipc_sock}"  dst: "/ipc/proxy.sock" is_bind: true }
mount { dst: "/tmp" fstype: "tmpfs" rw: true }
mount { dst: "/proc" fstype: "proc" }

seccomp_string: "ALLOW {
  read, write, close, fstat, mmap, mprotect, munmap, brk,
  rt_sigaction, rt_sigprocmask, ioctl, access, pipe, pipe2,
  dup, dup2, socket, connect, sendto, recvfrom,
  clone, execve, wait4, exit_group, getpid, getuid, getgid,
  arch_prctl, set_tid_address, set_robust_list,
  futex, epoll_create1, epoll_ctl, epoll_wait,
  openat, newfstatat, readlink, getcwd, fcntl,
  getdents64, lseek, clock_gettime, nanosleep,
  eventfd2, timerfd_create, timerfd_settime,
  sched_getaffinity, prlimit64, statx
} DEFAULT KILL"
```

### 9.2 macOS Seatbelt Profile

```scheme
;; policies/agent.sb
(version 1)
(deny default)

;; Allow reading workspace and skills
(allow file-read* (subpath "/workspace"))
(allow file-read* (subpath "/skills"))
(allow file-write* (subpath "/workspace"))
(allow file-read* (subpath "/tmp"))
(allow file-write* (subpath "/tmp"))

;; Allow IPC socket
(allow file-read* file-write* (literal "/ipc/proxy.sock"))
(allow network-outbound (to unix-socket "/ipc/proxy.sock"))

;; Allow Node.js runtime
(allow file-read* (subpath "/usr/local"))
(allow file-read* (subpath "/opt/homebrew"))
(allow process-exec)

;; DENY all network
(deny network*)
```

---

## 10. Staged Implementation

### Stage 0: Walking Skeleton (~1,200 LOC, 1-2 weekends)

**Goal:** End-to-end loop — you type a message, agent runs in a sandbox, you get a response.

**Config:**
```yaml
providers:
  llm: anthropic
  memory: file
  scanner: basic
  channels: [cli]
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess    # or seatbelt (macOS), nsjail (Linux), docker (alt)
  scheduler: none
```

**Build order:**
```
 1. src/providers/types.ts                    (200 LOC) — All interfaces
 2. src/config.ts                             (50)  — YAML parser
 3. src/providers/credentials/env.ts          (30)  — Read process.env
 4. src/providers/audit/file.ts               (30)  — JSONL append
 5. src/providers/llm/anthropic.ts            (80)  — Anthropic API
 6. src/providers/memory/file.ts              (100) — Markdown + grep
 7. src/providers/scanner/basic.ts            (60)  — Regex + canary
 8. src/providers/channel/cli.ts              (40)  — stdin/stdout
 9. src/providers/web/none.ts                 (10)  — Stub
10. src/providers/browser/none.ts             (10)  — Stub
11. src/providers/skills/readonly.ts          (30)  — Read .md files
12. src/providers/scheduler/none.ts           (10)  — Stub
13. src/providers/sandbox/subprocess.ts       (50)  — No-isolation dev spawner
13a. src/providers/sandbox/seatbelt.ts        (80)  — macOS sandbox-exec
13b. src/providers/sandbox/nsjail.ts          (100) — Linux nsjail spawner
13c. src/providers/sandbox/docker.ts          (150) — Docker + gVisor
14. src/registry.ts                           (80)  — Provider loading
15. src/db.ts                                 (80)  — SQLite message queue
16. src/router.ts                             (150) — Taint-aware routing
17. src/ipc.ts                                (200) — IPC proxy
18. src/host.ts                               (200) — Main loop
19. container/agent-runner.ts                 (250) — Agent loop
20. container/ipc-client.ts                   (100) — IPC client
21. container/Dockerfile                      (30)  — Container image
```

### Stage 1: Real Messaging + Web (~600 LOC)

Add: `channel/whatsapp.ts`, `web/fetch.ts`, `credentials/encrypted.ts`, `memory/sqlite.ts`, `audit/sqlite.ts`, `scheduler/cron.ts`

### Stage 2: Multi-Model + Search + API (~450 LOC)

Add: `llm/openai.ts`, `llm/multi.ts`, `web/search.ts`, `completions.ts`

### Stage 3: Advanced Security + Skills (~650 LOC)

Add: `scanner/patterns.ts`, `skills/git.ts`

### Stage 4: Browser + Agents + Triggers (~800 LOC)

Add: `browser/container.ts`, `scheduler/full.ts`, multi-agent delegation

### Stage 5: Production Integrations (~500 LOC)

Add: `memory/memu.ts`, `scanner/promptfoo.ts`, `credentials/keychain.ts`

---

## 11. Key Shared Types

```typescript
// Additional types referenced by provider interfaces

interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  stream?: boolean;
}

interface ChatChunk {
  type: 'text' | 'tool_use' | 'done';
  content?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  usage?: { inputTokens: number; outputTokens: number };
}

interface MemoryEntry {
  id?: string;
  scope: string;           // e.g., "user:alice", "agent:assistant", "global"
  content: string;
  tags?: string[];
  taint?: TaintTag;
  createdAt?: Date;
}

interface MemoryQuery {
  scope: string;
  query: string;
  limit?: number;
  tags?: string[];
}

interface ScanTarget {
  content: string;
  source: string;
  taint?: TaintTag;
  sessionId: string;
}

interface ScanResult {
  verdict: 'PASS' | 'FLAG' | 'BLOCK';
  reason?: string;
  patterns?: string[];     // which patterns matched
}

interface TaintTag {
  source: string;          // e.g., "web:example.com", "email", "browser:dashboard.com"
  trust: 'user' | 'external' | 'system';
  timestamp: Date;
}

interface SandboxConfig {
  workspace: string;       // path to session workspace
  skills: string;          // path to skills directory
  ipcSocket: string;       // path to IPC socket
  timeoutSec?: number;
  memoryMB?: number;
  command: string[];       // e.g., ['node', 'agent-runner.js']
}

interface SandboxProcess {
  pid: number;
  exitCode: Promise<number>;
  stdout: ReadableStream;
  stderr: ReadableStream;
  kill(): void;
}

interface InboundMessage {
  id: string;
  channel: string;
  sender: string;
  content: string;
  media?: Buffer;
  timestamp: Date;
  isGroup: boolean;
  groupId?: string;
}

interface OutboundMessage {
  content: string;
  media?: Buffer;
  replyTo?: string;
}

interface AuditEntry {
  timestamp: Date;
  sessionId: string;
  action: string;          // e.g., 'llm_chat', 'web_fetch', 'skill_propose'
  args: Record<string, unknown>;
  result: 'success' | 'blocked' | 'error';
  taint?: TaintTag;
  durationMs: number;
  tokenUsage?: { input: number; output: number };
}

interface CronJobDef {
  id: string;
  schedule: string;        // cron expression
  agentId: string;
  prompt: string;
  maxTokenBudget?: number;
}
```
