# Plugin Framework Design: Provider Packages & Third-Party Trust Boundary

**Date:** 2026-02-26
**Status:** Approved — open questions resolved 2026-02-27
**Author:** Architecture review session

## Problem Statement

The AX codebase has grown to ~18.5K LOC — well past the original ~4.1K target. The
`src/providers/` directory alone contains 13 categories with 30+ implementations, and
every new provider bloats the core. Meanwhile, the provider contract pattern is already
90% of a plugin framework — each provider is a TypeScript interface with a `create(config)`
factory. The missing piece isn't architecture; it's **packaging and distribution**.

The question: can we use npm packages to split providers out of core without violating
the security invariants that make AX trustworthy?

### Constraints (Non-Negotiable)

These are architectural invariants from the PRP and security hardening spec. Any plugin
framework design that violates them is DOA:

1. **SC-SEC-002 — Static provider allowlist.** No dynamic `import()` from config values.
   This was the fix for a critical RCE finding. Non-negotiable.
2. **Credentials never enter containers.** Providers that touch credentials run on the
   host side. A malicious provider on the host = game over.
3. **No marketplace.** OpenClaw's ClawHub had 341 malicious skills. We don't repeat that.
4. **"Small enough to audit."** If a human can't read the code that runs on the host,
   the security model is broken.
5. **Everything is audited.** Providers must participate in the audit pipeline.

## Options Considered

### Option A: Official Provider Packages (Monorepo Split)

Move each provider category into its own scoped npm package while keeping everything
under the same repo and release process.

```
@ax/core                        # host, agent, IPC, registry (~3K LOC)
@ax/provider-llm-anthropic      # Anthropic LLM provider
@ax/provider-llm-openai         # OpenAI-compatible LLM provider
@ax/provider-llm-router         # Multi-model router
@ax/provider-memory-file        # File-based memory
@ax/provider-memory-sqlite      # SQLite + FTS5 memory
@ax/provider-memory-memu        # Knowledge graph memory
@ax/provider-sandbox-nsjail     # nsjail sandbox
@ax/provider-sandbox-docker     # Docker + gVisor sandbox
...
```

**How it works:**
- `provider-map.ts` maps to package exports (`@ax/provider-llm-anthropic`) instead
  of relative paths (`../providers/llm/anthropic.js`).
- All packages live in a monorepo (pnpm workspaces or similar).
- Same CI, same review process, same release cadence.
- `@ax/core` shrinks back to ~3K LOC. Auditable again.

**Security analysis:**
- Supply chain stays under our control (we publish everything).
- Static allowlist preserved — entries just point to package names.
- No new trust boundary introduced.
- `npm audit` and lockfile integrity cover the dependency graph.

**Trade-offs:**
| Pro | Con |
|-----|-----|
| Core shrinks to auditable size | Monorepo tooling overhead (pnpm, changesets, etc.) |
| Users install only what they need | More packages to version and release |
| Clean dependency boundaries | Cross-package type sharing needs care |
| Natural path to Option B | Initial migration is non-trivial |

### Option B: Vetted Third-Party Providers (Sandboxed Plugin Host)

Add a trust boundary that allows approved third-party npm packages to act as providers
without running in the main host process.

```
┌─────────────────────────────────────────────┐
│  Host Process (trusted)                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Registry │  │ IPC Srv  │  │ Audit     │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│       │                                      │
│  ┌────┴────────────────────────────────┐    │
│  │ PluginHost (new)                    │    │
│  │  - Spawns plugin worker processes   │    │
│  │  - Proxies provider interface calls │    │
│  │  - Injects credentials server-side  │    │
│  │  - Enforces capability restrictions │    │
│  └──┬──────────┬──────────┬────────────┘    │
│     │          │          │                  │
│  ┌──┴───┐  ┌──┴───┐  ┌──┴───┐              │
│  │Worker│  │Worker│  │Worker│  (sandboxed)  │
│  │PlugA │  │PlugB │  │PlugC │              │
│  └──────┘  └──────┘  └──────┘              │
└─────────────────────────────────────────────┘
```

**How it works:**
- Third-party providers run in separate worker processes (not the main host).
- Communication uses the same IPC pattern used for agent ↔ host.
- Credentials are **never** passed to plugin workers — the PluginHost injects them
  on the proxy side, same as with agents.
- Each plugin declares capabilities in a manifest:

```typescript
// MANIFEST.json in plugin package
{
  "name": "@community/provider-memory-postgres",
  "ax_provider": {
    "kind": "memory",
    "name": "postgres"
  },
  "capabilities": {
    "network": ["localhost:5432"],   // Only Postgres, nothing else
    "filesystem": "none",
    "credentials": ["POSTGRES_URL"]  // Credential keys it needs (injected by host)
  },
  "integrity": "sha512-..."
}
```

- A `plugins.lock` file pins exact versions + integrity hashes.
- `ax plugin add @community/provider-memory-postgres` installs, pins, hashes.
  Requires explicit human review of the manifest.

**Security analysis:**
- Plugin code never runs in the host process → credential isolation preserved.
- Network access is scoped per-plugin via capability declarations.
- Integrity hashes prevent supply chain tampering post-install.
- The PluginHost is the only new trusted code (~200-300 LOC).

**Trade-offs:**
| Pro | Con |
|-----|-----|
| Community can contribute providers | New trusted component (PluginHost) to audit |
| Credential isolation preserved | IPC overhead for every provider call |
| Capability-scoped network | Plugin sandboxing on macOS is weaker |
| No marketplace needed (npm is the registry) | Plugin authors must learn the manifest format |

### Option C: Provider SDK (Compile-Time Integration)

Publish `@ax/provider-sdk` with interfaces and test harness. Third parties build
providers as npm packages. Users install them and manually add entries to
`provider-map.ts`. No runtime plugin loading at all.

```bash
# Third-party author workflow
npm init @ax/provider         # scaffolds a provider package
npm test                       # runs the AX provider test harness
npm publish                    # publishes to npm

# User workflow
npm install @community/provider-memory-postgres
# Then manually edit provider-map.ts:
#   memory: { postgres: '@community/provider-memory-postgres' }
npm run build                  # rebuild with new provider in allowlist
```

**Security analysis:**
- Zero new runtime trust surface.
- User explicitly reviews and adds to allowlist — same as adding an in-tree provider.
- Package runs in the host process (same as official providers), so it must be trusted.
- `npm audit` + lockfile integrity apply.

**Trade-offs:**
| Pro | Con |
|-----|-----|
| Zero new attack surface | Requires rebuild to add a provider |
| Familiar npm workflow | Third-party code runs in host (must be trusted) |
| SDK enables community | No isolation between official and third-party code |
| Cheapest to implement | Not a "plugin framework" — more of a "provider cookbook" |

## Recommendation

**Start with Option A. Design for Option B. Ship Option C immediately as a bridge.**

### Phase 1: Provider SDK (Option C) — Week 1-2

Low-risk, high-value. Publish `@ax/provider-sdk` containing:

- All provider TypeScript interfaces (extracted from co-located `types.ts` files).
- A `TestHarness` that validates a provider against its contract.
- A `create-ax-provider` scaffolding CLI.
- Documentation on the provider contract pattern.

This unblocks community contribution today with zero architecture changes.

```
@ax/provider-sdk
├── interfaces/
│   ├── llm.ts          # LLMProvider interface
│   ├── memory.ts       # MemoryProvider interface
│   ├── scanner.ts      # ScannerProvider interface
│   └── ...             # All 13 provider interfaces
├── testing/
│   ├── harness.ts      # Contract test runner
│   └── fixtures/       # Test fixtures per provider type
├── utils/
│   └── safe-path.ts    # safePath utility for file providers
└── bin/
    └── create-provider # Scaffolding CLI
```

### Phase 2: Monorepo Split (Option A) — Week 3-6

Split `src/providers/` into scoped packages:

1. Extract shared types into `@ax/provider-sdk` (already done in Phase 1).
2. Move each provider implementation into `@ax/provider-{kind}-{name}`.
3. Update `provider-map.ts` to resolve package names instead of relative paths.
4. Set up pnpm workspaces + changesets for versioning.
5. `@ax/core` becomes the installable "ax server" that depends on whichever
   provider packages the user chooses.

**`provider-map.ts` after migration:**

```typescript
const _PROVIDER_MAP = {
  llm: {
    anthropic:  '@ax/provider-llm-anthropic',
    openai:     '@ax/provider-llm-openai',
    router:     '@ax/provider-llm-router',
    mock:       '@ax/provider-llm-mock',
  },
  memory: {
    file:   '@ax/provider-memory-file',
    sqlite: '@ax/provider-memory-sqlite',
    memu:   '@ax/provider-memory-memu',
  },
  // ...
} as const;
```

The `resolveProviderPath` function changes from URL resolution to `require.resolve`
or `import()` by package name — still static, still an allowlist, but now the
implementations live in their own packages.

**User `ax.yaml` stays identical.** The split is invisible to end users.

### Phase 3: Plugin Host (Option B) — Week 8-12

Only if community demand warrants it. Build the `PluginHost` trust boundary:

1. Define the plugin manifest schema (`MANIFEST.json`).
2. Build the PluginHost process manager (~200-300 LOC).
3. Implement capability-scoped proxy (network allowlist, credential injection).
4. Add `ax plugin add/remove/list` CLI commands.
5. Generate `plugins.lock` with integrity hashes.
6. Add plugin lifecycle to audit logging.

**Gate:** Phase 3 only ships if Phase 2 is stable and there's demonstrated community
interest in building providers. We don't build infrastructure for hypothetical demand.

## Migration Path

### For Existing Users

Nothing changes in Phases 1-2. `ax.yaml` syntax is identical. Provider names are
identical. The split is a packaging concern, not a user-facing change.

### For Provider Authors (Phase 1+)

```bash
# Scaffold a new provider
npx create-ax-provider memory postgres

# Implement the interface
# src/index.ts exports create(config: Config): Promise<MemoryProvider>

# Run contract tests
npm test

# Publish
npm publish
```

### For Plugin Users (Phase 3)

```bash
# Install a vetted third-party provider
ax plugin add @community/provider-memory-postgres

# Review the manifest (printed to stdout)
# Plugin capabilities: network=localhost:5432, credentials=POSTGRES_URL

# Confirm installation
# → Added to plugins.lock with sha512 integrity hash

# Use in ax.yaml like any other provider
providers:
  memory: postgres
```

## Security Review Checklist

Before any phase ships, verify:

- [ ] SC-SEC-002: Provider loading still uses static allowlist (no dynamic paths from config)
- [ ] Credentials never enter plugin worker processes (Phase 3)
- [ ] Plugin manifest capabilities are enforced, not advisory (Phase 3)
- [ ] `plugins.lock` integrity hashes are verified on every load (Phase 3)
- [ ] All plugin provider calls are audit-logged
- [ ] Taint budget tracking works across plugin-provided content
- [ ] No `eval()`, `Function()`, or dynamic `import()` from user-controlled strings

## What We're NOT Building

To be painfully clear:

- **No marketplace UI.** npm is the registry. We don't curate or host packages.
- **No auto-discovery.** You can't `ax search plugins`. You find packages on npm, you
  read the code, you install them deliberately.
- **No trust-on-first-use.** Every plugin addition requires human review of the manifest
  and explicit confirmation.
- **No hot-reloading of plugins.** Restart required. This is a feature, not a limitation —
  it prevents runtime code injection.

## Resolved Decisions

### 1. Monorepo tooling: **pnpm workspaces**

pnpm workspaces is the right fit. Nx and Turborepo solve problems we don't have yet
(remote build caching, complex dependency graphs across dozens of teams). At ~35
packages under one team with one CI pipeline, pnpm's native workspace support is
sufficient. Key advantages:

- **Strict dependency isolation by default.** No phantom dependencies — a provider
  package can't accidentally import something only `@ax/core` declares. This catches
  real bugs that npm/yarn workspaces silently allow.
- **Minimal tooling surface.** Less tooling = less to audit. We're a security project;
  every dev dependency is attack surface.
- **Turborepo is additive.** If CI gets slow, Turborepo layers on top of pnpm
  workspaces without restructuring. We can add it later; we can't easily remove Nx.

### 2. Versioning strategy: **Lockstep**

All packages share one version number. Bump once, publish everything.

- All packages are first-party, same repo, same CI, same reviewers. Independent
  versioning buys nothing except a compatibility matrix nobody wants to maintain.
- Users never wonder "does `@ax/provider-llm-anthropic@3.2.1` work with
  `@ax/core@3.1.0`?" — same version = compatible, always.
- Release process stays trivial: one version bump, one publish command.
- Independent versioning only makes sense when external maintainers own packages on
  different cadences — that's a Phase 3 concern at the earliest.
- Migration path: lockstep → independent is straightforward if we outgrow it.
  Independent → lockstep is painful. Start simple.

### 3. Plugin worker sandboxing: **Child processes with existing sandbox providers**

(Phase 3 decision, not blocking Phase 2, but the direction is set.)

- **Worker threads don't provide meaningful isolation.** They share the V8 heap and
  process memory. Running untrusted code in a worker thread is security theater.
- **We already have battle-tested sandbox infrastructure.** The sandbox providers
  (nsjail on Linux, seatbelt on macOS, bwrap as fallback) exist and work. Reuse them.
- **The IPC pattern already exists.** Host ↔ agent communication uses length-prefixed
  JSON over Unix sockets. Plugin ↔ host is the same shape. No new protocol needed.
- **Performance overhead is irrelevant.** Plugin provider calls are already async IPC.
  Adding a process boundary doesn't meaningfully change the latency profile — we're
  talking about LLM calls and database queries, not tight loops.

### 4. Core vs. extra: **Noop/mock in core, standard bundle for batteries-included**

Two-tier packaging:

**`@ax/core` (~3K LOC)** ships with one noop or mock implementation per provider
category, inline. These are minimal stubs that satisfy the interface:

| Category | Core Provider | Notes |
|----------|--------------|-------|
| llm | `mock` | Returns canned responses |
| image | `mock` | Returns placeholder image |
| memory | `file` | Simplest possible, already tiny |
| scanner | `basic` | Regex patterns, no external deps |
| channel | *(none)* | No default channel makes sense |
| web | `none` | Disabled by default |
| browser | `none` | Disabled by default |
| credentials | `env` | Just reads env vars, ~30 LOC |
| skills | `readonly` | File-based, no git deps |
| audit | `file` | JSONL append, tiny |
| sandbox | `subprocess` | No container deps |
| scheduler | `none` | Disabled by default |
| screener | `static` | Static rules, no external deps |

This means `@ax/core` is fully functional for development and testing with **zero
heavy dependencies** (no SQLite native module, no Anthropic SDK, no Slack SDK, etc.).

**`ax` (the main installable package)** is a meta-package that depends on `@ax/core`
plus the standard provider set:

```
ax
├── @ax/core
├── @ax/provider-llm-anthropic
├── @ax/provider-llm-openai
├── @ax/provider-memory-sqlite
├── @ax/provider-sandbox-nsjail
├── @ax/provider-audit-sqlite
├── @ax/provider-scanner-patterns
├── @ax/provider-credentials-encrypted
└── ... (the "batteries included" set)
```

- `npm install ax` gives users a fully working system, same as today.
- `npm install @ax/core @ax/provider-llm-anthropic` lets advanced users pick exactly
  what they need.
- The noop/mock providers double as **reference implementations** for the SDK — each
  one shows the minimum viable provider in ~20-50 LOC.

## Appendix: Current Provider Inventory

For reference, the 13 provider categories and their current implementations:

| Category | Implementations | Likely Package Split |
|----------|----------------|---------------------|
| **llm** | anthropic, openai, openrouter, groq, router, mock | @ax/provider-llm-{name} |
| **image** | openai, gemini, router, mock | @ax/provider-image-{name} |
| **memory** | file, sqlite, memu | @ax/provider-memory-{name} |
| **scanner** | basic, patterns, promptfoo | @ax/provider-scanner-{name} |
| **channel** | slack, whatsapp, telegram, discord | @ax/provider-channel-{name} |
| **web** | none, fetch, tavily | @ax/provider-web-{name} |
| **browser** | none, container | @ax/provider-browser-{name} |
| **credentials** | env, encrypted, keychain | @ax/provider-credentials-{name} |
| **skills** | readonly, git | @ax/provider-skills-{name} |
| **audit** | file, sqlite | @ax/provider-audit-{name} |
| **sandbox** | subprocess, seatbelt, nsjail, bwrap, docker | @ax/provider-sandbox-{name} |
| **scheduler** | none, cron, full | @ax/provider-scheduler-{name} |
| **screener** | static, none | @ax/provider-screener-{name} |

**Total: ~35 packages** (including @ax/core and @ax/provider-sdk).
