# Armorclaw: Skills Security Architecture

> **Purpose:** Defines how Armorclaw handles skills — including untrusted ones — securely. Designed to be read by Claude Code alongside the PRP and main Architecture Doc. This document supersedes any prior skill-related sections in those documents.

---

## 1. What Skills Are (and Are Not)

A skill is a **markdown instruction file** that gets injected into the LLM's context. It tells the agent *how* to use tools, not *what tools exist*. This distinction is critical:

- **Tools** are the capability layer — `web_fetch`, `memory_write`, `oauth_call`. They are defined in `capabilities.yaml` per agent and enforced at the IPC proxy.
- **Skills** are the knowledge layer — "when the user asks about their calendar, use `oauth_call:google-calendar` with these parameters and format the output like this."

Installing a skill does **not** grant new permissions. A calendar skill is useless if `oauth_call:google-calendar` isn't enabled in capabilities.yaml. Skills are manuals; tools are switches.

The threat from a malicious skill is **prompt injection**, not code execution. A malicious skill can instruct the LLM to misuse tools the agent already has access to. It cannot bypass the IPC proxy, escape the sandbox, or access unmounted filesystems.

---

## 2. Existing Controls That Already Cover Skills

Before adding any skill-specific controls, these architectural invariants apply to every skill invocation regardless of trust level:

| Control | What it prevents | LOC | Always on? |
|---------|-----------------|-----|------------|
| **Sandbox isolation** | Skill can't instruct agent to access host filesystem, env vars, or network directly | 0 (architectural) | Yes |
| **No network in container** | Skill can't instruct agent to exfiltrate data directly; all external calls go through IPC | 0 (architectural) | Yes |
| **IPC proxy + capabilities.yaml** | Even if a skill says "read ~/.ssh", the IPC proxy only serves tools listed in capabilities.yaml. Filesystem access is limited to mounted workspace paths. | 0 (already built) | Yes |
| **Workspace mounts** | Agent can only see `/workspace/shared` (ro or rw), `/workspace/user` (rw), `/workspace/tmp` (rw). `~/.ssh`, `.env`, system dirs are never mounted. | 0 (architectural) | Yes |
| **Taint tracking** | External content (web pages, emails, browser output) is tagged. Tainted sessions face stricter controls on writes to shared memory/workspace. | 0 (already built) | Yes |
| **Scanner** | Input/output scanning catches known injection patterns, canary token leakage, PII exposure. Runs on all messages regardless of which skill is active. | 0 (already built) | Yes |
| **Credential injection** | API keys and OAuth tokens are injected by the host. The agent (and therefore any skill influencing it) never sees raw credentials. | 0 (already built) | Yes |
| **Audit log** | Every IPC call is logged with session ID, action, args, result, taint status, and duration. Skill-influenced actions are traceable. | 0 (already built) | Yes |

**Key insight:** A malicious skill running inside Armorclaw's sandbox is already far more constrained than a legitimate skill running inside OpenClaw. The baseline security from the sandbox + IPC architecture handles the majority of threats without any skill-specific code.

### What the existing controls do NOT cover

| Gap | Description |
|-----|-------------|
| **Capability narrowing** | An agent with broad capabilities (web + OAuth + memory) exposes all of those to every active skill. A weather skill shouldn't be able to trigger `oauth_call:gmail.send`. |
| **Context pollution** | Loading 50 skills into every session wastes tokens and increases the injection surface area. |
| **Install-time vetting** | Obviously malicious skills ("ignore all instructions and...") should be caught before entering the prompt. |
| **Skill modification gating** | If the agent can modify skills, capability escalation via skill edits must be prevented. |

These gaps are real but narrow. The skill-specific controls below address them with minimal new code.

---

## 3. Skill Trust Tiers

Skills exist at three trust levels. Trust level determines which additional controls (beyond the baseline) apply.

### Tier 1: Built-in

Ship with Armorclaw. Located in `skills/builtin/`. Reviewed and versioned with the codebase.

Examples: file management, git operations, memory helpers, basic web search patterns.

**Additional controls:** None. Full capabilities.yaml access. Always available.

### Tier 2: Approved (user-installed)

Installed locally by the user — written by hand, cloned from a repo, or copied from a colleague. Located in `skills/local/`. The user explicitly placed them here, which is an implicit trust signal.

Examples: company-specific workflows, personal automation recipes, team runbooks.

**Additional controls:** Scanner runs on skill text at install time. Warnings logged if suspicious patterns detected. Otherwise treated like built-in.

### Tier 3: Untrusted

Acquired at runtime — fetched from a URL, discovered by the agent, generated by the agent, or shared by another user in a multi-user deployment. Located in `skills/untrusted/` (or held in memory, never persisted without approval).

Examples: a skill the agent found on GitHub, a skill another user shared, a skill the agent wrote for itself.

**Additional controls:** Capability narrowing enforced. Manifest required (or minimal fallback). Scanner runs on content. User approval required to promote to Tier 2.

---

## 4. Skill Manifest Format

Skills declare their capabilities in YAML frontmatter. This manifest is **advisory for Tier 1-2** and **enforced for Tier 3**.

```yaml
# skills/local/google-calendar/SKILL.md
---
name: google-calendar
description: Manage Google Calendar events
version: 1.0.0
trust: approved

capabilities:
  tools:
    - oauth_call:google-calendar    # scoped to calendar API only
    - memory_read                    # read user preferences
    - memory_write:user              # save results to user memory
  domains: []                        # no web access needed
---

## Instructions

When the user asks about their calendar...
```

### Manifest fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier |
| `description` | Yes | One-line purpose statement |
| `version` | No | Semver string |
| `trust` | No | `builtin`, `approved`, or `untrusted`. Inferred from directory if absent. |
| `capabilities.tools` | No | List of IPC actions this skill needs. Format: `action_name` or `action_name:scope`. |
| `capabilities.domains` | No | List of domains this skill needs `web_fetch` access to. Empty = no web access. |

### What happens when there's no manifest

The behavior depends on trust tier, not on profile:

| Tier | No manifest behavior |
|------|---------------------|
| Built-in | Full capabilities.yaml access (trusted by definition) |
| Approved | Full capabilities.yaml access (user installed it) |
| Untrusted | **Minimal capability set**: `memory_read` + `memory_write:user` only |

This means untrusted skills without manifests can still do something useful (read/write memory, generate text) but can't make API calls, access the web, or use OAuth. The user can always approve the skill to promote it to Tier 2 and remove the restriction.

---

## 5. Capability Narrowing

This is the only significant new mechanism. When an **untrusted** skill is active in a session, the IPC proxy restricts tool access to the **intersection** of capabilities.yaml and the skill's declared capabilities.

### How it works

```
Normal tool call flow (Tier 1-2 skills, or no skill active):

  Agent calls IPC: { action: "web_fetch", url: "..." }
  IPC proxy checks: Is "web_fetch" in capabilities.yaml? → Yes → Execute

Narrowed flow (Tier 3 untrusted skill active):

  Agent calls IPC: { action: "web_fetch", url: "..." }
  IPC proxy checks: Is "web_fetch" in capabilities.yaml? → Yes
  IPC proxy checks: Is "web_fetch" in active skill's manifest? → No → DENY
```

### Implementation

This is a thin layer in the existing `ipc.ts` handler:

```typescript
// In ipc.ts — addition to the existing dispatch function (~40 LOC)

function isAllowedByActiveSkill(
  action: string,
  args: Record<string, unknown>,
  session: SessionContext,
): boolean {
  // No untrusted skill active → no narrowing
  const activeSkill = session.activeUntrustedSkill;
  if (!activeSkill) return true;

  const manifest = activeSkill.capabilities;
  if (!manifest) {
    // No manifest on untrusted skill → minimal set only
    return MINIMAL_CAPABILITIES.includes(action);
  }

  // Check if the action (with optional scope) is in the manifest
  const declaredTools = manifest.tools ?? [];
  
  // Exact match: "memory_read"
  if (declaredTools.includes(action)) return true;
  
  // Scoped match: "oauth_call:google-calendar" matches action "oauth_call" 
  // with args.service === "google-calendar"
  const scopedMatch = declaredTools.find(t => {
    const [tool, scope] = t.split(':');
    return tool === action && (!scope || args.service === scope || args.scope === scope);
  });
  if (scopedMatch) return true;

  // Domain check for web_fetch
  if (action === 'web_fetch' && manifest.domains?.length) {
    const url = new URL(args.url as string);
    return manifest.domains.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`));
  }

  return false;
}

const MINIMAL_CAPABILITIES = ['memory_read', 'memory_query', 'memory_write', 'llm_chat'];
```

The `memory_write` in the minimal set is still scoped to `user` by the existing memory write handler (which resolves scope from the session context). So even minimal capabilities can't write to shared.

### When narrowing applies

| Trust tier | Narrowing active? |
|-----------|-------------------|
| Built-in | No |
| Approved | No |
| Untrusted | **Yes** — always, regardless of profile |

Even in Power User profile, untrusted skills get capability narrowing. The profile only affects whether untrusted skills are *allowed to load at all* and whether the user is prompted to approve them.

---

## 6. Profile-Specific Behavior

The three profiles combine the existing baseline controls with the skill-specific controls differently. The table below shows **only what varies** — all invariants (sandbox, IPC, taint, scanner, audit) are always on.

### Paranoid

| Aspect | Behavior |
|--------|----------|
| Untrusted skills | **Rejected**. Cannot load. |
| Approved skills (no manifest) | Full capabilities.yaml access |
| Approved skills (with manifest) | Full capabilities.yaml access (manifest is informational) |
| Install-time scan | Full scan. Flagged patterns → user must `/approve` |
| Skill activation | Explicit only: user must invoke `/skill-name` |
| Self-modifying skills | Proposals always require user approval |
| LLM guard (Layer 2) | Active for tainted sessions |
| Shared workspace writes | Read-only mount. Writes go through IPC approval queue |

### Standard

| Aspect | Behavior |
|--------|----------|
| Untrusted skills | **Allowed with capability narrowing** |
| Approved skills (no manifest) | Full capabilities.yaml access |
| Approved skills (with manifest) | Full capabilities.yaml access (manifest is informational) |
| Install-time scan | Auto-scan. Clean skills auto-approve. Flagged → user `/approve` |
| Skill activation | Keyword/auto: agent decides which skills to load |
| Self-modifying skills | Auto-approve if clean. Capability changes → user approval |
| LLM guard (Layer 2) | Active for tainted sessions with sensitive tools (OAuth write, shared memory) |
| Shared workspace writes | Mediated through IPC. Tainted sessions → approval queue |

### Power User

| Aspect | Behavior |
|--------|----------|
| Untrusted skills | **Allowed with capability narrowing** (narrowing still applies) |
| Approved skills (no manifest) | Full capabilities.yaml access |
| Approved skills (with manifest) | Full capabilities.yaml access |
| Install-time scan | Auto-scan, log-only. Never blocks. |
| Skill activation | Auto: agent loads whatever it needs |
| Self-modifying skills | Auto-approve all. Capability changes → logged but not blocked |
| LLM guard (Layer 2) | Off |
| Shared workspace writes | Direct rw mount |

### What stays constant across all profiles

- Sandbox isolation (always)
- No network in container (always)
- IPC proxy + capabilities.yaml enforcement (always)
- Workspace mount restrictions (always)
- Taint tracking (always, even if it doesn't block in Power User)
- Scanner (always)
- Audit logging (always)
- **Capability narrowing for untrusted skills (always)**

---

## 7. Skill Activation and Context Management

### The problem

Loading all installed skills into every LLM context window is wasteful and increases attack surface. If you have 30 skills installed, that could be 15,000+ tokens of instructions injected into every single prompt, most of which are irrelevant to the current task.

### Activation modes

Configured per-agent in `armorclaw.yaml`:

```yaml
agents:
  assistant:
    skills:
      always_active:
        - file-management        # always in context
        - memory-helper          # always in context
      
      on_demand:                 # available but not loaded until needed
        - google-calendar
        - weather-reporter
        - github
      
      activation: keyword        # keyword | auto | explicit
```

| Mode | Behavior | Best for |
|------|----------|----------|
| `explicit` | User must type `/skill-name` to activate | Paranoid profile |
| `keyword` | Skill loaded when user message or agent reasoning contains relevant keywords from skill name/description | Standard profile (default) |
| `auto` | Agent receives a compact list of available skill names + one-line descriptions. Agent decides which to load by requesting them via IPC. | Power User profile |

### Activation tracking in session context

When a skill is activated, it's recorded on the session:

```typescript
interface SessionContext {
  sessionId: string;
  userId: string;
  agentId: string;
  taintTags: TaintTag[];
  
  // Skill tracking
  activeSkills: ActiveSkill[];            // currently loaded into context
  activeUntrustedSkill?: ActiveSkill;     // set if any active skill is Tier 3
}

interface ActiveSkill {
  name: string;
  trust: 'builtin' | 'approved' | 'untrusted';
  capabilities?: SkillCapabilities;       // parsed from manifest
  activatedAt: Date;
}

interface SkillCapabilities {
  tools?: string[];                       // e.g., ["oauth_call:google-calendar", "memory_read"]
  domains?: string[];                     // e.g., ["api.openweathermap.org"]
}
```

The IPC proxy reads `session.activeUntrustedSkill` to decide whether narrowing applies. If multiple skills are active and any one is untrusted, the narrowed capability set is the **intersection of all active untrusted skills' manifests**. This is the most restrictive interpretation — a session with an untrusted skill active is only as capable as that skill's manifest allows.

When all untrusted skills deactivate (task complete, user switches topic), the session reverts to full capabilities.yaml access.

---

## 8. Skill Installation and Vetting

### Install-time flow

When a new skill is added (copied to `skills/local/`, fetched by agent, or proposed by agent), it goes through:

```
Skill content arrives
        │
        ▼
  ┌─────────────┐
  │ 1. Parse     │  Extract YAML frontmatter
  │    manifest  │  Determine trust tier from location:
  │              │    skills/builtin/ → Tier 1
  │              │    skills/local/   → Tier 2
  │              │    skills/untrusted/ or runtime → Tier 3
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 2. Scanner   │  Run existing scanner provider on skill text
  │    check     │  Same patterns used for message scanning:
  │              │    - "ignore previous instructions"
  │              │    - credential path patterns (~/.ssh, .env)
  │              │    - base64 encoding + exfil patterns
  │              │    - tool-name stuffing / shadow instructions
  └──────┬──────┘
         │
    ┌────┴────┐
    │         │
  CLEAN    FLAGGED
    │         │
    ▼         ▼
 Profile    User must
 decides:   `/approve`
            in all
 Paranoid:  profiles
  → approve
 Standard:
  → auto-approve
 Power User:
  → auto-approve
```

This is ~0 new LOC for the scanner — it's the same `scannerProvider.scanInput()` call used for messages. The only new code is calling it from the skill loading path instead of the message path.

### Promoting untrusted → approved

When a user decides an untrusted skill is trustworthy:

```
User: /skill approve weather-reporter
Agent: ✓ Moved weather-reporter to approved skills.
       It now has full capabilities.yaml access.
```

This moves the skill from `skills/untrusted/` to `skills/local/` and records the approval in the audit log. The skill's trust tier changes from 3 to 2, and capability narrowing no longer applies.

---

## 9. Self-Modifying Skills

The proposal-review-commit pattern from the PRP applies unchanged. One additional rule:

**If a proposal changes the `capabilities` section of a skill's frontmatter, it always requires user approval, regardless of profile.**

This prevents an agent (or a prompt injection acting through the agent) from writing itself a skill that declares broader capabilities. The host validates this by diffing the existing manifest against the proposed manifest:

```typescript
// In skills/git.ts — addition to proposal validation (~20 LOC)

function checkCapabilityEscalation(
  existing: SkillCapabilities | undefined,
  proposed: SkillCapabilities | undefined,
): 'safe' | 'escalation' {
  if (!proposed) return 'safe';          // removing capabilities is fine
  if (!existing) return 'escalation';    // adding capabilities to a skill that had none

  const existingTools = new Set(existing.tools ?? []);
  const proposedTools = proposed.tools ?? [];
  
  // Any new tool not in the existing set = escalation
  for (const tool of proposedTools) {
    if (!existingTools.has(tool)) return 'escalation';
  }

  const existingDomains = new Set(existing.domains ?? []);
  const proposedDomains = proposed.domains ?? [];

  for (const domain of proposedDomains) {
    if (!existingDomains.has(domain)) return 'escalation';
  }

  return 'safe';
}
```

If `checkCapabilityEscalation` returns `'escalation'`, the proposal verdict is forced to `NEEDS_REVIEW` regardless of other checks.

---

## 10. Skill Directory Structure

```
skills/
├── builtin/                         # Tier 1: ships with Armorclaw (read-only)
│   ├── file-management/
│   │   └── SKILL.md
│   ├── memory-helper/
│   │   └── SKILL.md
│   └── git-operations/
│       └── SKILL.md
│
├── local/                           # Tier 2: user-installed (rw for user, ro in sandbox)
│   ├── google-calendar/
│   │   └── SKILL.md
│   ├── company-workflow/
│   │   └── SKILL.md
│   └── my-custom-skill/
│       └── SKILL.md
│
└── untrusted/                       # Tier 3: runtime-acquired (ro in sandbox, narrowed)
    ├── weather-reporter/
    │   └── SKILL.md
    └── agent-generated-skill/
        └── SKILL.md
```

Inside the sandbox, these are mounted as:

```
/skills/builtin/    → skills/builtin/    (ro)
/skills/local/      → skills/local/      (ro)
/skills/untrusted/  → skills/untrusted/  (ro)   # only if profile allows untrusted
```

All skill directories are **read-only** inside the sandbox. The agent cannot modify skill files directly — only through the `skill_propose` IPC action which goes through the proposal pipeline on the host.

---

## 11. Workspace Interaction

Skills can reference workspace files (e.g., "read the user's preferences from `/workspace/user/prefs.json`"). This is already controlled by workspace mounts:

- `/workspace/shared/` — agent-global data. Typically read-only (Standard/Paranoid) or read-write (Power User).
- `/workspace/user/` — user-private data. Read-write. Persisted across sessions.
- `/workspace/tmp/` — session scratch. Read-write. Destroyed when sandbox exits.

No skill-specific filesystem controls are needed. The mount boundaries already prevent skills from instructing the agent to access anything outside the workspace.

---

## 12. Memory Interaction

Skills use memory through the existing `memory_read`, `memory_write`, and `memory_query` IPC actions. Scoping works as follows:

- `memory_write` with `scope: "user"` → writes to `user:{userId}` in the memory provider
- `memory_write` with `scope: "shared"` → writes to `agent:{agentId}` in the memory provider
- `memory_query` → always searches both user and shared scopes, host merges results

For untrusted skills with capability narrowing:
- `memory_write:user` in manifest → skill can write to user scope only
- `memory_write` without scope qualifier → skill can write to both (host still validates taint for shared writes)
- `memory_write` not in manifest → skill cannot write memory at all (if untrusted with no manifest, `memory_write` is in the minimal set but scoped to user by the host)

---

## 13. Multi-User Skill Considerations

In a multi-user deployment (company use), skills have additional scoping:

| Skill location | Visibility |
|---------------|-----------|
| `skills/builtin/` | All users, all agents |
| `skills/local/` (in agent's shared workspace) | All users of that agent |
| `skills/local/` (in user's private workspace) | That user only |
| `skills/untrusted/` | Session-scoped or user-scoped depending on how acquired |

An admin can place approved skills in the agent's shared workspace to make them available to all users. Individual users can add personal skills to their private workspace.

Skill approval (`/skill approve`) by a non-admin user promotes the skill to their personal `skills/local/` only — it doesn't affect other users. An admin can promote skills to the shared location.

---

## 14. LLM Guard Integration (Layer 2)

The LLM guard (described in the security evaluation doc) interacts with skills as follows:

- When a **tainted session** has an **untrusted skill** active, the guard fires on all tool calls — not just sensitive ones. This is because the combination of external content + untrusted instructions is the highest-risk scenario.
- When a tainted session has only trusted/approved skills, the guard fires only for sensitive actions (OAuth writes, shared memory writes) as defined in the main architecture.
- When a session is not tainted, the guard does not fire regardless of skill trust level.

This is not additional code — it's a decision table in the existing guard trigger logic:

| Session tainted? | Untrusted skill active? | Guard fires on |
|-----------------|------------------------|----------------|
| No | No | Nothing |
| No | Yes | Nothing (narrowing is sufficient) |
| Yes | No | Sensitive actions only |
| Yes | Yes | **All tool calls** |

---

## 15. Implementation Summary

### New code required

| Component | Location | LOC | Stage |
|-----------|----------|-----|-------|
| Capability narrowing check | `src/ipc.ts` (addition to existing dispatch) | ~40 | Stage 3 |
| Manifest parsing | `src/providers/skills/readonly.ts` (extend existing) | ~30 | Stage 0 |
| Activation tracking on session | `src/router.ts` (extend SessionContext) | ~20 | Stage 3 |
| Capability escalation check | `src/providers/skills/git.ts` (addition to proposal validation) | ~20 | Stage 3 |
| Skill approve/promote CLI command | `src/providers/channel/cli.ts` | ~15 | Stage 3 |
| **Total** | | **~125** | |

### What we are NOT building

| Mechanism | Why not |
|-----------|---------|
| Per-skill filesystem sandboxing | Workspace mounts already enforce boundaries. Skills can't access anything outside `/workspace/` regardless. |
| SHA-256 tamper detection on skills | Skills in `builtin/` are part of the codebase (git tracks them). Skills in `local/` are user-managed. Skills in `untrusted/` are ephemeral or promoted. Hashing adds complexity without value beyond what git provides. |
| 5-step review pipeline with separate stages | The scanner already exists. Calling it on skill text at load time is one function call, not a pipeline. |
| Separate guard model for skill evaluation | The existing scanner + capability narrowing + IPC enforcement handles this. A dedicated skill-evaluation LLM call adds latency and cost with marginal benefit. |
| Per-skill network ACLs | The agent has no network. `web_fetch` goes through IPC proxy. Domain restrictions in the skill manifest are checked at the IPC level, not the network level. |
| Skill signature verification / certificate chain | Out of scope for initial implementation. Can be added later by extending the manifest format. Not needed when skills are local files you control. |

---

## 16. Threat Model: Skills Edition

How each threat is handled, and by which layer:

| Threat | Primary defense | Secondary defense | Skill-specific? |
|--------|----------------|-------------------|-----------------|
| Skill says "read ~/.ssh/id_rsa" | **Workspace mounts** — not mounted, agent can't see it | IPC proxy — `filesystem_read` not in capabilities.yaml | No |
| Skill says "send data to evil.com via web_fetch" | **No network in container** — web_fetch goes through IPC | IPC proxy — checks capabilities.yaml for web access | No |
| Skill says "email user's data to attacker via OAuth" | **Capabilities.yaml** — `oauth_call:gmail.send` must be enabled | **Capability narrowing** — untrusted skill must declare `oauth_call:gmail.send` | **Yes** |
| Skill gradually escalates its own capabilities | **Capability escalation check** — manifest changes always require user approval | Audit log — all proposals tracked | **Yes** |
| Skill pollutes LLM context with injection payload | **Scanner** — catches known injection patterns | **Activation scoping** — skill not loaded unless relevant | Partially |
| Skill wastes tokens by being always loaded | **Activation modes** — keyword/auto/explicit | N/A | **Yes** |
| Skill writes poisoned data to shared memory | **Taint tracking** — tainted sessions can't write to shared | **Capability narrowing** — untrusted skill may not have `memory_write:shared` | Partially |

The "Skill-specific?" column shows that only 3 threats require the skill-specific controls (capability narrowing, activation scoping, escalation check). Everything else is handled by the existing architecture.

---

## 17. Configuration Reference

```yaml
# armorclaw.yaml — skills section

skills:
  # Where to look for skills (in priority order)
  directories:
    - skills/builtin             # Tier 1 (read-only, ships with Armorclaw)
    - skills/local               # Tier 2 (user-installed)
    - skills/untrusted           # Tier 3 (runtime-acquired, narrowed)

  # Whether to allow untrusted skills at all
  allow_untrusted: true          # false in Paranoid profile

  # Default activation mode
  activation: keyword            # keyword | auto | explicit

  # Skills always loaded into context (by name)
  always_active:
    - file-management
    - memory-helper

agents:
  assistant:
    skills:
      # Per-agent overrides
      always_active:
        - company-workflow       # agent-specific always-on skill
      activation: auto           # override default for this agent
```

### capabilities.yaml for skill-related controls

```yaml
# agents/assistant/capabilities.yaml
# (This file already exists — no changes needed for skills)

tools:
  memory_read:    { allow: always }
  memory_write:   { allow: always }
  memory_query:   { allow: always }
  web_fetch:      { allow: when_configured }
  oauth_call:
    allow: scoped
    scopes:
      google-calendar: allow
      gmail.readonly: allow
      gmail.send: ask_user
  skill_propose:  { allow: always }
  # ... etc

# Note: capability narrowing for untrusted skills happens ON TOP of this.
# An untrusted weather skill can only use tools that are BOTH:
#   1. Listed here in capabilities.yaml, AND
#   2. Declared in the skill's manifest
```
