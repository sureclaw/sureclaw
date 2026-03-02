# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Repository

- **Name:** ax
- **Remote:** git@github.com:ax/ax.git

## Build / Test / Lint Commands

```bash
npm run build     # TypeScript compilation (tsc)
npm test          # Run all tests (vitest on Node.js)
bun test          # Run all tests (Bun native runner)
npm start         # Start AX (tsx src/main.ts)
npm run test:fuzz # Run fuzz tests (vitest --run tests/ipc-fuzz.test.ts)
```

## Architecture Overview

AX uses a **provider contract pattern**. Every subsystem is a TypeScript interface with pluggable implementations. The host process (trusted, `src/host/`) communicates with agent processes (sandboxed, `src/agent/`) via IPC over Unix sockets.

### Directory Structure

- **`src/host/`** — Trusted host-side: server, router, IPC handler, registry, proxy, taint budget, provider map, OAuth
- **`src/agent/`** — Sandboxed agent-side: runner, IPC client/transport, local tools, MCP server
- **`src/agent/runners/`** — Agent type implementations (pi-session, claude-code)
- **`src/providers/`** — Provider implementations, each category in its own subdirectory with co-located `types.ts`
- **`src/types.ts`** — Shared cross-cutting types (Config, ProviderRegistry, Message, TaintTag)
- **`tests/`** — Mirrors `src/` structure exactly (tests/host/, tests/agent/, tests/providers/category/)

### Key Patterns

- **Co-located provider types:** Each provider category has its own `types.ts` (e.g. `src/providers/llm/types.ts`). Shared types live in `src/types.ts`.
- **Provider subdirectories:** `src/providers/llm/anthropic.ts` — each provider category is a subdirectory. Mapped via static allowlist in `src/host/provider-map.ts` (SC-SEC-002).
- **safePath for all file ops:** Every file-based provider MUST use `safePath()` from `src/utils/safe-path.ts` when constructing paths from input.
- **IPC schema validation:** Every IPC action has a Zod schema with `.strict()` mode in `src/ipc-schemas.ts`.
- **Provider loading:** Static allowlist in `src/host/provider-map.ts` — no dynamic path construction.
- **Each provider exports** `create(config: Config)` function.

### Bug Fix Policy

Whenever you fix a bug that wasn't caught by an existing test, you MUST add a test that would have caught it the first time. No exception. The test goes in before the fix is considered done.

### Security Invariants

- No network in agent containers
- Credentials never enter containers
- All external content is taint-tagged
- Everything is audited
- No dynamic imports from config values

### Reference Documents

- `docs/plans/ax-prp.md` — Project requirements, design philosophy
- `docs/plans/ax-architecture-doc.md` — Provider contracts, file structure, data flow
- `docs/plans/ax-security-hardening-spec.md` — SC-SEC-001/002/003/004 specifications

## Voice & Tone for User-Facing Content

When generating or editing any user-facing content (README, SECURITY.md, docs, error messages, CLI output, comments visible to users), use the following voice:

### Personality
- **Self-deprecating but competent.** We joke about our paranoia, not about security itself. We're the friend who triple-checks the door is locked and laughs about it — but the door IS locked.
- **Warm and approachable.** Assume the reader is smart but not necessarily technical. Never gatekeep. Never make someone feel dumb for not knowing what a CVE is.
- **Honest about complexity.** Security is hard. We say so. We don't pretend things are simple when they aren't, but we do our best to make them understandable.
- **Sarcastic toward bad practices, never toward people.** We roast hardcoded API keys, not the person who committed them. We've all been there.

### Writing Guidelines
- Use plain language first, jargon second. If you use a technical term, briefly explain it or link to an explanation.
- Short sentences. Short paragraphs. Walls of text are a security vulnerability for attention spans.
- It's okay to be funny. It's not okay to be funny instead of being clear.
- When discussing actual vulnerabilities, threats, or security configurations, drop the jokes and be direct. Lives and livelihoods depend on this stuff.
- Default to "we" not "you" — we're on the same team as the reader.
- Admit what we don't know. Uncertainty stated clearly is more trustworthy than false confidence.

### Examples

**Good:** "We pin our dependencies because we have trust issues. But also because unpinned dependencies are how supply chain attacks happen, and we'd rather be paranoid than compromised."

**Good:** "This step is optional but recommended. Kind of like locking your car in a safe neighborhood — probably fine if you skip it, but you'll feel better if you don't."

**Bad:** "If you don't understand why this matters, you probably shouldn't be deploying to production."

**Bad:** "Simply configure your TLS mutual authentication with certificate pinning." (nothing about this is "simply")

### The Golden Rule
We're a nervous crab peeking through its claws — but behind those claws, we know exactly what we're doing.

## Journal & Lessons Protocol

You MUST follow this protocol for every task you work on.

### Directory Structure

Journal and lessons are organized by **category** (not by date) in nested directories:

```
.claude/journal/
├── index.md          # Category listing with entry counts
├── host/             # Host process: server, delegation, orchestration, event console
├── agent/            # Agent process: tools, prompt, runner
├── providers/        # Provider implementations: llm, sandbox, channel, etc.
├── testing/          # Test infrastructure, integration, E2E, migrations
├── security/         # Security hardening, vulnerabilities
├── config/           # Configuration, paths, onboarding
├── docs/             # Documentation, plans
├── ipc/              # IPC protocol
└── refactoring/      # Cleanup work

.claude/lessons/
├── index.md          # Key Principles + category listing
├── testing/          # Test patterns, infrastructure, mocking, SQLite
├── architecture/     # Design patterns, provider contracts
├── providers/        # Provider-specific lessons: llm, sandbox, channel, etc.
├── host/             # Host process, orchestration, delegation
├── agent/            # Agent runners, prompt building
├── ipc/              # Zod schemas, handler registration
├── config/           # Configuration, env vars
├── security/         # Import security, safe paths
├── filesystem/       # Symlinks, file I/O
└── workflow/         # CI/CD, GitHub Actions
```

Each directory has an `index.md` with a summary and file listing. Content files within directories hold the actual entries.

### Journal (`.claude/journal/`)

Append an entry to the appropriate **category file** (e.g., `host/orchestration.md`, `providers/llm.md`) every time you complete a meaningful unit of work. Use this exact format:

```
## [YYYY-MM-DD HH:MM] — <short title>

**Task:** What was asked or what I set out to do
**What I did:** Brief description of the actions taken
**Files touched:** List of files created/modified/deleted
**Outcome:** Success, partial, or failed — and why
**Notes:** Anything worth remembering about this change
```

Rules:
- Be concise. Each entry should be 5-10 lines max.
- Log even failed attempts — they have value.
- Never delete or edit past entries. The journal is append-only.
- Place entries in **reverse chronological order** (newest first) within each file.
- If a new category is needed, create the directory with an `index.md`.
- Update the category's `index.md` when adding entries (add to the bullet list).

### Lessons Learned (`.claude/lessons/`)

Append an entry to the appropriate **category file** whenever you:
- Make a mistake and then fix it
- Discover something non-obvious about the codebase
- Find that an approach doesn't work in this project
- Learn a user preference about how they want things done

Use this exact format:

```
### <short descriptive title>
**Date:** YYYY-MM-DD
**Context:** What I was doing when I learned this
**Lesson:** The specific thing to remember (be precise and actionable)
**Tags:** comma, separated, relevant, keywords
```

Rules:
- Before adding a lesson, scan the category file to avoid duplicates.
- Lessons should be **actionable** — written as instructions to your future self.
  - Bad: "The tests were tricky"
  - Good: "Always run `npm test -- --bail` before committing; the test suite fails silently on import errors"
- Keep lessons atomic. One insight per entry.
- If a new category is needed, create the directory with an `index.md` that includes Key Takeaways.

### Workflow Summary

```
START OF TASK:
  1. Read .claude/lessons/index.md Key Principles to inform approach
  2. Plan approach (read relevant category lessons if applicable)
  3. Do the work
  4. Append to appropriate .claude/journal/<category>/<file>.md
  5. If you learned something new → append to appropriate .claude/lessons/<category>/<file>.md
END OF TASK
```

**IMPORTANT:** Steps 4 and 5 MUST happen BEFORE creating any git commit. Never commit without first updating the journal and lessons. The commit should reflect that journal/lessons are already up to date.

### Periodic Maintenance

- If any single lessons file exceeds 30 entries, split it into subcategory files.
- Keep `.claude/lessons/index.md` Key Principles updated with the most important cross-cutting lessons (max ~10).
