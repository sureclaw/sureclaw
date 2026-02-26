# OpenClaw vs AX: Skills Architecture Comparison & Safe Executable Skills Design

**Date:** 2026-02-25
**Scope:** Compare how OpenClaw and AX handle skills, analyze OpenClaw's security failures, and design how AX can safely support user-installable skills that execute scripts/binaries — without becoming the next ClawHavoc headline.

---

## 1. The Stakes

OpenClaw's skill ecosystem is its killer feature. 5,705+ community skills on ClawHub, covering everything from email management to GitHub workflows to smart home control. Skills can bundle binaries, inject environment variables, and execute arbitrary scripts. This is why people use OpenClaw.

It's also why 341+ malicious skills delivered the Atomic macOS Stealer to thousands of users in February 2026, why 135,000+ OpenClaw instances were found exposed on the internet, and why security researchers are calling it "a security nightmare."

AX's position: skills are markdown instruction files. They can't execute code. They can only tell the LLM how to use existing IPC tools. This is secure. It's also limiting. If AX wants to compete, it needs to allow skills to do real work — run scripts, invoke binaries, automate system tasks — without opening the same attack surface that burned OpenClaw.

This document lays out exactly how.

---

## 2. Architecture Comparison

### 2.1 OpenClaw's Skills Architecture

**What a skill is:**
A folder containing `SKILL.md` (YAML frontmatter + markdown instructions) plus optional scripts, templates, and binaries in a `bins/` subdirectory.

**How skills execute:**
- The LLM decides which skills are relevant to the current turn
- Skill instructions are injected into the prompt
- Skills can bundle binaries in `bins/` — these are **added to the agent's PATH**
- Skills can inject environment variables via `skill.json` or YAML frontmatter
- Skills can declare requirements (binaries, env vars, OS constraints)
- Execution happens on the host with the agent's full privileges

**How skills are distributed:**
- ClawHub: public registry, anyone with a 1-week-old GitHub account can publish
- No code signing, no security review, no sandbox by default
- CLI install: `openclaw skill install <name>`
- Manual: clone/copy to `~/.openclaw/skills/`

**The permissions model:**
- Skills declare `permissions` in frontmatter (e.g., `filesystem:read`, `network:outbound`, `shell.execute`)
- Permissions are **advisory** — the skill loads even if it declares permissions the agent doesn't have
- If the agent's tool policy blocks an action, the skill fails at runtime
- There is no capability narrowing — skills inherit ALL agent permissions
- There is no tiered trust system

**What went wrong (ClawHavoc, Feb 2026):**

| Metric | Number |
|--------|--------|
| Malicious skills discovered (initial audit) | 341 of 2,857 (12%) |
| Malicious skills (latest count, Feb 16) | 824+ of 10,700+ (~8%) |
| Extended estimates (Bitdefender) | ~900 malicious, ~1,184 in ClawHavoc campaign |
| Internet-exposed OpenClaw instances | 135,000+ |
| Directly exploitable instances (pre-patch) | 12,800+ |
| Primary payload | Atomic macOS Stealer (AMOS) |
| Attack vector | `SKILL.md` containing obfuscated `curl | bash` or fake "prerequisites" |
| Barrier to publish | GitHub account ≥ 1 week old |

Root causes:
1. **No sandbox.** Skills execute on the host with full user privileges.
2. **No screening.** ClawHub had zero automated security review at launch.
3. **Markdown as installer.** `SKILL.md` instructions can trick both humans and LLMs into running malicious commands.
4. **No capability narrowing.** Every skill gets every permission the agent has.
5. **No binary provenance.** Binaries in `bins/` have no signatures, no hashes, no verification.
6. **PATH injection.** Skill binaries are prepended to PATH, enabling binary substitution attacks.

Post-incident response:
- VirusTotal scanning partnership (reactive, after 341 skills already deployed)
- Community reporting (3 reports = auto-hide)
- Still no sandbox, no capability narrowing, no binary signing

### 2.2 AX's Skills Architecture (Current)

**What a skill is:**
A markdown instruction file (`.md`) with optional YAML frontmatter. Injected into LLM context. Skills are "manuals" — they tell the agent how to use existing tools. They cannot execute code directly.

**How skills execute:**
- Skills are stored as `.md` files in `~/.ax/agents/{agentId}/agent/workspace/skills/`
- Only skill summaries (name + description) are loaded into context (progressive disclosure)
- Agent calls `skill_read` via IPC to load full content on demand
- Skills instruct the LLM to use existing IPC tools (`web_fetch`, `memory_write`, `oauth_call`, etc.)
- All tool execution goes through the IPC proxy on the host, validated against `capabilities.yaml`

**Security layers (always on, not skill-specific):**

| Layer | What It Prevents |
|-------|-----------------|
| Sandbox isolation (nsjail/seatbelt) | Direct host access |
| No network in container | Direct data exfiltration |
| IPC proxy + capabilities.yaml | Unauthorized tool use |
| Workspace mounts (shared/user/tmp) | Filesystem escape |
| Taint tracking | Poisoned data propagation |
| Scanner | Injection pattern detection |
| Credential injection | Credential exposure to agent |
| Audit logging | Untracked actions |

**Skill-specific controls:**

| Control | Description |
|---------|------------|
| Three trust tiers | Builtin (Tier 1), Approved (Tier 2), Untrusted (Tier 3) |
| Capability narrowing | Untrusted skills restricted to intersection of capabilities.yaml ∩ skill manifest |
| Hard-reject patterns | eval(), exec(), spawn(), child_process, base64, fetch() → never allowed in skill text |
| Git-backed versioning | Every skill change committed, audited, revertible |
| Proposal-review-commit | Agent can't modify skills without host-side validation |
| Capability escalation check | Manifest changes always require user approval |

**What AX can't do today:**
- Skills cannot bundle or execute binaries
- Skills cannot run scripts
- Skills cannot invoke system commands directly
- Skills cannot install dependencies
- Skills are purely instructional — they influence LLM behavior, nothing more

### 2.3 Side-by-Side

| Dimension | OpenClaw | AX |
|-----------|----------|-----|
| **Skill format** | SKILL.md + scripts + `bins/` | `.md` only |
| **Execution model** | Host-direct, full privileges | IPC-mediated, sandboxed |
| **Binary bundling** | Yes, added to PATH | No |
| **Script execution** | Yes, arbitrary | No |
| **Env var injection** | Yes, skill-controlled | No |
| **Sandbox** | Optional Docker (not default) | Mandatory (nsjail/seatbelt) |
| **Network access** | Full | None in container |
| **Credential exposure** | Agent sees credentials | Host-side proxy injection |
| **Capability narrowing** | None | Yes (Tier 3 skills) |
| **Binary verification** | None | N/A (no binaries) |
| **Distribution** | ClawHub (open upload) | Local only |
| **Install-time screening** | VirusTotal (post-incident) | Hard-reject patterns + scanner |
| **Skill versioning** | None (plain files) | Git-backed with revert |
| **Supply chain attacks** | 824+ malicious skills | N/A (no marketplace) |

---

## 3. The Gap: What AX Needs

AX's current skills are safe but limited. You can't build a "deploy my app" skill that runs `docker build && docker push`. You can't build a "format my code" skill that runs `prettier`. You can't build a "manage my Git" skill that invokes `gh pr create`. These are the skills that make OpenClaw useful for real work.

The question is: **how do you allow skill-bundled script/binary execution without becoming OpenClaw?**

The answer is that AX already has most of the infrastructure. The sandbox, IPC proxy, capabilities.yaml, taint tracking, and audit logging form a defense-in-depth stack that OpenClaw doesn't have. The missing piece is a controlled bridge from "skills as instructions" to "skills as executable packages" — one that routes all execution through the existing security boundary.

---

## 4. Design: Safe Executable Skills for AX

### 4.1 Core Principle: The Sandbox Is the Skill Runtime

OpenClaw's fatal flaw is that skills execute on the host. AX's key insight: **skill binaries run inside the sandbox, not on the host.** The sandbox already prevents network access, credential exposure, and filesystem escape. We're not adding a new security boundary — we're extending the existing one to cover skill-bundled executables.

For the small set of cases where a skill genuinely needs host-side execution (invoking `gh`, `docker`, `kubectl`), that goes through a new IPC action with strict allowlisting. The agent never runs host binaries directly.

### 4.2 Skill Package Format

Extend the current `.md` skill format to support a directory structure:

```
skills/local/deploy-app/
├── SKILL.md              # Instructions + YAML frontmatter (unchanged)
├── bins/                 # Executable binaries (new)
│   ├── linux-x64/
│   │   └── deploy-helper
│   └── darwin-arm64/
│       └── deploy-helper
├── scripts/              # Shell/Python scripts (new)
│   ├── build.sh
│   └── validate.py
├── templates/            # Templates, configs (new)
│   └── Dockerfile.tmpl
└── MANIFEST.yaml         # Package manifest with hashes (new)
```

**Backward compatible:** A skill that's just a `.md` file continues to work exactly as before. The directory format is opt-in.

### 4.3 MANIFEST.yaml

Every executable skill MUST include a manifest. No manifest = no execution. The manifest is validated by the host before the skill is installed.

```yaml
# MANIFEST.yaml
name: deploy-app
version: 1.2.0
description: Build and deploy containerized applications
author: team@example.com
trust: approved               # builtin | approved | untrusted

# What this skill needs to do its job
capabilities:
  tools:                       # IPC actions this skill uses
    - exec_sandboxed           # run binaries inside sandbox
    - filesystem_read          # read workspace files
    - filesystem_write:user    # write to user workspace only
  host_commands:               # host-side commands (strict allowlist)
    - name: docker
      args_pattern: "build|push|tag"     # regex for allowed subcommands
      reason: "Build and push container images"
    - name: gh
      args_pattern: "pr create|pr list"
      reason: "Create GitHub pull requests"
  domains: []                  # no web access needed

# What this skill bundles
executables:
  - path: bins/linux-x64/deploy-helper
    sha256: a1b2c3d4e5f6...    # REQUIRED for all binaries
    platform: linux-x64
    description: "Deployment orchestration binary"
  - path: scripts/build.sh
    sha256: f6e5d4c3b2a1...
    platform: any
    description: "Container build script"

# Requirements
requires:
  bins: [docker, gh]           # must exist on host PATH
  env: [DOCKER_REGISTRY]       # must be set in environment

# Installation hooks (run on host, user-approved)
install:
  steps:
    - description: "Verify Docker is installed"
      check: "docker --version"
    - description: "Authenticate with registry"
      command: "docker login $DOCKER_REGISTRY"
      approval: required        # always prompts user
```

### 4.4 Execution Model: Three Tiers

#### Tier A: Sandboxed Execution (Default, No Extra Approval)

Skill scripts and binaries run **inside the agent sandbox**. This is the default and requires no special approval beyond the skill being installed.

```
Agent receives user request
    → Agent reads skill instructions (skill_read)
    → Agent decides to run skill script
    → Agent calls IPC: { action: "exec_sandboxed", binary: "deploy-helper", args: [...] }
    → Host validates:
        1. Is "exec_sandboxed" in capabilities.yaml? ✓
        2. Is this binary declared in MANIFEST.yaml? ✓
        3. Does SHA-256 match? ✓
        4. Is the binary inside the skill's directory? ✓ (safePath check)
    → Host copies binary into sandbox (if not already mounted)
    → Binary executes inside sandbox with:
        - No network
        - No credentials
        - Workspace mounts only
        - stdout/stderr captured and returned via IPC
    → Agent receives output, continues
```

**Security properties:**
- Binary can't phone home (no network)
- Binary can't steal credentials (not in sandbox)
- Binary can't escape filesystem (sandbox + safePath)
- Binary is integrity-verified (SHA-256)
- Execution is audited (IPC log)

#### Tier B: Host-Proxied Commands (Requires User Approval)

For skills that need to invoke host-installed tools (docker, gh, kubectl, npm), a new IPC action routes commands through the host with strict allowlisting.

```
Agent calls IPC: { action: "host_exec", command: "docker", args: ["build", "-t", "myapp", "."] }
    → Host validates:
        1. Is "host_exec" in capabilities.yaml? ✓
        2. Is "docker" in the skill's MANIFEST.yaml host_commands? ✓
        3. Do args match the declared args_pattern? ✓ ("build" matches /build|push|tag/)
        4. Is the working directory inside the workspace? ✓ (safePath)
    → Host checks approval:
        - Profile is Paranoid → prompt user for each invocation
        - Profile is Standard → prompt on first use, then auto-approve matching pattern
        - Profile is Power User → auto-approve if in manifest
    → Host executes command in restricted subprocess:
        - Inherits only declared env vars (not full environment)
        - Working directory constrained to workspace
        - Timeout enforced (configurable, default 5 minutes)
        - stdout/stderr captured
    → Result returned to agent via IPC
    → Execution logged to audit trail
```

**Security properties:**
- Command must be declared in manifest (no arbitrary execution)
- Arguments must match declared pattern (no injection)
- Working directory is confined (no path traversal)
- Environment is filtered (no credential leakage)
- User approval gated by profile
- Every invocation audited

#### Tier C: Installation Hooks (Always Requires User Approval)

Some skills need one-time setup: installing a dependency, authenticating a service, generating config. These run on the host but ALWAYS require explicit user approval, regardless of profile.

```
User: /skill install deploy-app
    → Host parses MANIFEST.yaml
    → Host shows install steps to user:
        "This skill wants to run:
         1. docker --version (verify Docker)
         2. docker login $DOCKER_REGISTRY (authenticate)
         Approve? [y/N]"
    → User approves
    → Each step runs individually with output shown
    → Skill installed to skills/local/deploy-app/
    → Git commit: "skill: install deploy-app (user-approved)"
```

**Security properties:**
- User sees exactly what will run before it runs
- Each step runs individually (not batched)
- No silent installation
- Audit trail records approval

### 4.5 Trust Tier Integration

The three trust tiers from `armorclaw-skills-security.md` map directly:

| Trust Tier | Sandboxed Exec (A) | Host Commands (B) | Install Hooks (C) |
|-----------|--------------------|--------------------|-------------------|
| **Tier 1: Builtin** | Allowed | Allowed (per capabilities.yaml) | N/A (shipped with AX) |
| **Tier 2: Approved** | Allowed | Allowed (per manifest + profile) | User approval always |
| **Tier 3: Untrusted** | **Denied** | **Denied** | **Denied** |

**Critical rule: Untrusted skills CANNOT execute binaries or scripts.** Period. An untrusted skill is markdown instructions only, capability-narrowed, and scanner-verified. To run executables, the user must promote the skill to Tier 2 (`/skill approve`), which is a conscious trust decision.

This is the bright line that separates AX from OpenClaw. OpenClaw lets any ClawHub skill run binaries on your host. AX requires you to explicitly approve a skill before it can run anything.

### 4.6 Binary Provenance and Integrity

Every executable in a skill MUST have a SHA-256 hash in `MANIFEST.yaml`. The host verifies hashes at:

1. **Install time** — hash computed and stored
2. **Load time** — hash re-verified before mounting into sandbox
3. **Execution time** — hash checked before `exec_sandboxed` or `host_exec`

If any hash doesn't match, the skill is quarantined and the user is notified.

```typescript
// In the skill loader (host-side)
async function verifyExecutable(skillDir: string, entry: ManifestExecutable): Promise<boolean> {
  const fullPath = safePath(skillDir, entry.path);
  const hash = await computeSha256(fullPath);
  if (hash !== entry.sha256) {
    await audit.log({
      action: 'skill_integrity_violation',
      args: { skill: skillDir, file: entry.path, expected: entry.sha256, actual: hash },
    });
    return false;
  }
  return true;
}
```

**Future extension:** Optional GPG signature verification for skill packages from known publishers. Not required for v1 — SHA-256 hashes cover the integrity use case. Signatures add authenticity, which matters more when/if AX has a marketplace.

### 4.7 New IPC Actions

```typescript
// In src/ipc-schemas.ts

// Execute a binary inside the sandbox
export const ExecSandboxedSchema = ipcAction('exec_sandboxed', {
  skill: safeString(200),           // which skill owns this binary
  binary: safeString(500),          // relative path within skill dir
  args: z.array(safeString(2000)).max(50),
  workdir: safeString(500).optional(),  // relative to workspace
  timeout: z.number().int().min(1000).max(600_000).optional(),
});

// Execute a host command (proxied through host)
export const HostExecSchema = ipcAction('host_exec', {
  skill: safeString(200),
  command: safeString(200),
  args: z.array(safeString(2000)).max(50),
  workdir: safeString(500).optional(),
  env: z.record(safeString(200), safeString(2000)).optional(),
  timeout: z.number().int().min(1000).max(600_000).optional(),
});

// Install a skill package
export const SkillInstallSchema = ipcAction('skill_install', {
  source: safeString(2000),  // local path, git URL, or clawhub:name
  trust: z.enum(['approved', 'untrusted']).default('untrusted'),
});
```

### 4.8 Profile Behavior

| Profile | Sandboxed Exec | Host Commands | Install Hooks | Untrusted Skills |
|---------|---------------|---------------|---------------|-----------------|
| **Paranoid** | Allowed (approved only) | Prompt every invocation | User approval | Rejected entirely |
| **Standard** | Allowed (approved only) | Prompt first use, then auto per pattern | User approval | Markdown only (no exec) |
| **Power User** | Allowed (approved only) | Auto-approve if in manifest | User approval | Markdown only (no exec) |

Note that **install hooks always require user approval** regardless of profile. We never silently run install scripts. Even in Power User mode. We're paranoid about this, and that's the point.

---

## 5. How This Compares to OpenClaw

### What AX gets that OpenClaw has:

| Feature | OpenClaw | AX (with this design) |
|---------|----------|----------------------|
| Skills that run scripts | Yes (host-direct) | Yes (sandboxed or host-proxied) |
| Skills that bundle binaries | Yes (PATH injection) | Yes (SHA-256 verified, sandboxed) |
| Skills that invoke system tools | Yes (unrestricted) | Yes (allowlisted, pattern-matched) |
| Skills that install dependencies | Yes (arbitrary) | Yes (user-approved, audited) |
| Community skills ecosystem | ClawHub (10,700+) | ClawHub import + screening (future) |

### What AX gets that OpenClaw doesn't:

| AX Advantage | Why It Matters |
|-------------|---------------|
| **Mandatory sandbox** | Skill binaries can't phone home, steal credentials, or escape filesystem |
| **Binary integrity verification** | SHA-256 hashes prevent tampering and substitution |
| **Capability narrowing** | Untrusted skills can't access tools they didn't declare |
| **Trust-gated execution** | Only user-approved skills can run executables |
| **Host command allowlisting** | Skill declares exactly which host commands it needs; pattern-matched args |
| **Filtered environment** | Host commands don't inherit full env; only declared vars |
| **Audit trail** | Every execution logged with skill, command, args, result |
| **Git-backed versioning** | Every skill change tracked, diffable, revertible |
| **No marketplace (yet)** | No open-upload attack surface. When we add one, skills are screened first. |

### The key architectural difference:

```
OpenClaw:
  Skill → Agent → Host OS (full privileges)

  The skill IS the code. It runs directly. The agent is a pass-through.

AX:
  Skill → Agent → IPC → Host (validates) → Sandbox (executes)

  The skill is INSTRUCTIONS + DECLARED EXECUTABLES.
  The host validates everything. Execution is contained.
```

---

## 6. Implementation Roadmap

### Wave 1: Sandboxed Execution (~200 LOC new code)

**What:** Allow approved skills to bundle scripts/binaries that execute inside the sandbox.

1. Extend skill directory format to support `bins/`, `scripts/`, `MANIFEST.yaml`
2. Add `MANIFEST.yaml` parser with Zod validation
3. Add SHA-256 integrity verification for executables
4. Add `exec_sandboxed` IPC action + handler
5. Mount skill executables into sandbox (read-only)
6. Extend `git.ts` proposal validation to handle executable skills

**Files to create:**
- `src/providers/skills/manifest.ts` — MANIFEST.yaml parser
- `src/providers/skills/integrity.ts` — SHA-256 verification
- `src/host/ipc-handlers/exec-sandboxed.ts` — IPC handler

**Files to modify:**
- `src/ipc-schemas.ts` — add ExecSandboxedSchema
- `src/providers/skills/git.ts` — handle directory-format skills
- `src/host/provider-map.ts` — wire up new handler
- Sandbox providers — mount skill bins

### Wave 2: Host-Proxied Commands (~150 LOC new code)

**What:** Allow approved skills to invoke host-installed tools through a controlled proxy.

1. Add `host_exec` IPC action + handler
2. Implement command allowlist validation against MANIFEST.yaml
3. Implement args pattern matching
4. Implement environment filtering
5. Add profile-based approval flow (Paranoid: always ask, Standard: ask once, Power User: auto)

**Files to create:**
- `src/host/ipc-handlers/host-exec.ts` — proxied command execution
- `src/host/command-allowlist.ts` — validation logic

**Files to modify:**
- `src/ipc-schemas.ts` — add HostExecSchema
- `src/host/provider-map.ts` — wire up handler

### Wave 3: Install Hooks + ClawHub Import (~200 LOC new code)

**What:** User-approved installation workflows + ability to import OpenClaw skills.

1. Add `skill_install` IPC action
2. Implement install hook execution (always user-approved)
3. Add ClawHub skill parser (convert SKILL.md → AX format)
4. Run skill screener on imported skills
5. Generate MANIFEST.yaml from ClawHub skill metadata

**Files to create:**
- `src/providers/skills/installer.ts` — install workflow
- `src/providers/skills/clawhub-parser.ts` — SKILL.md format parser

**Files to modify:**
- `src/ipc-schemas.ts` — add SkillInstallSchema
- `src/providers/skills/git.ts` — handle installs

### Wave 4: Skill Screener for Executables (~100 LOC new code)

**What:** Extend the planned SkillScreenerProvider to analyze bundled executables.

1. Static analysis of shell scripts (detect `curl | bash`, obfuscated payloads, etc.)
2. Binary entropy analysis (detect packed/encrypted executables)
3. Permission manifest validation (declared vs. actual behavior)
4. Integration with existing scanner provider patterns

---

## 7. Threat Model: Executable Skills Edition

| Threat | OpenClaw Defense | AX Defense |
|--------|-----------------|------------|
| Skill binary phones home with stolen data | None (full network) | **No network in sandbox** |
| Skill binary reads ~/.ssh/id_rsa | None (full filesystem) | **Workspace mounts only** |
| Skill binary reads credentials from env | None (full env access) | **Credentials never in container** |
| Malicious binary replaces system tool | PATH injection possible | **SHA-256 verification + read-only mount** |
| Skill host command runs `rm -rf /` | Agent has full privileges | **Args pattern matching + workspace confinement** |
| Untrusted skill runs malicious binary | Allowed by default | **Untrusted skills cannot execute** |
| Supply chain: tampered binary in update | No integrity checking | **SHA-256 verification on every load** |
| Install script runs malicious commands | Silent execution possible | **User sees and approves each step** |
| Skill escalates its own permissions | No capability system | **Manifest changes require user approval** |
| Prompt injection via skill instructions | No scanning | **Scanner + hard-reject patterns + taint tracking** |

---

## 8. The Competitive Pitch

> "Install any skill. Run any binary. We just make sure it can't steal your credentials, phone home, or escape its sandbox first."

OpenClaw proved that community skills are incredibly useful. It also proved that running them without guardrails is catastrophically dangerous. AX's approach is to give users the same power — executable skills, bundled binaries, system tool integration — but route everything through a security architecture that was designed for zero trust from day one.

The sandbox isn't optional. The integrity verification isn't optional. The capability narrowing isn't optional. The audit trail isn't optional.

We're the nervous crab that also knows how to deploy your Docker containers.

---

## 9. Open Questions

1. **Should AX have a curated skill registry?** Not an open-upload marketplace like ClawHub, but a vetted collection of community skills with mandatory screening. Think "app store" not "npm."

2. **Should sandboxed binaries get limited network?** Some legitimate use cases (API clients, download tools) need network. Could allow skill-declared domains, routed through the IPC web proxy with domain filtering. This is a meaningful security trade-off.

3. **Should AX support the AgentSkills open standard?** Claude Code, Cursor, and OpenClaw are converging on `SKILL.md` + YAML frontmatter. Compatibility would let AX import skills from multiple ecosystems, not just OpenClaw. The format is close to what we have.

4. **WASM as an alternative to native binaries?** Running skill executables as WASM modules (via Wasmtime) would give us a second sandbox layer with memory safety guarantees. More restrictive than native binaries, but much harder to exploit. Worth investigating as a future option.

---

## Appendix A: Claude Code (Anthropic) Comparison

For completeness, Claude Code's extensibility model is also relevant:

| Extension Point | How It Works |
|----------------|-------------|
| **Slash commands** | User-invoked, single markdown file in `.claude/commands/` |
| **Skills** | Model-invoked, markdown in `.claude/skills/` |
| **Hooks** | Shell commands triggered by events (PostToolUse, etc.) |
| **MCP Servers** | External tool servers via Model Context Protocol |
| **Subagents** | Isolated context windows for delegated tasks |
| **Plugins** | Bundles of the above, shareable as packages |

Claude Code skills are similar to AX's current model — markdown instructions, no binary execution. Hooks provide deterministic shell execution but aren't skill-specific. MCP servers are the primary mechanism for adding executable capabilities, running as separate processes.

**Key difference from both OpenClaw and AX:** Claude Code doesn't have a sandbox in the same sense. It runs on your machine with your permissions. The security model relies on user approval of tool use, not architectural isolation. MCP servers run as trusted local processes.

AX's advantage over Claude Code: even if an MCP server is compromised, AX's sandbox prevents the agent from being used as an attack vector. Claude Code's model assumes the local environment is trusted.
