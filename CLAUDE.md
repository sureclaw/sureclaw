# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Repository

- **Name:** sureclaw
- **Remote:** git@github.com:sureclaw/sureclaw.git

## Build / Test / Lint Commands

```bash
npm run build     # TypeScript compilation (tsc)
npm test          # Run all tests (vitest)
npm start         # Start Sureclaw (tsx src/host.ts)
npm run test:fuzz # Run fuzz tests (vitest --run tests/ipc-fuzz.test.ts)
```

## Architecture Overview

Sureclaw uses a **provider contract pattern**. Every subsystem is a TypeScript interface (`src/providers/types.ts`) with pluggable implementations. The host process (trusted) communicates with agent containers (untrusted) via IPC over Unix sockets.

### Key Patterns

- **Flat provider naming:** `src/providers/llm-anthropic.ts` (not subdirectories). Mandated by SC-SEC-002 — the provider-map static allowlist uses these exact paths.
- **safePath for all file ops:** Every file-based provider MUST use `safePath()` from `src/utils/safe-path.ts` when constructing paths from input.
- **IPC schema validation:** Every IPC action has a Zod schema with `.strict()` mode in `src/ipc-schemas.ts`.
- **Provider loading:** Static allowlist in `src/provider-map.ts` — no dynamic path construction.
- **Each provider exports** `create(config: Config)` function.

### Security Invariants

- No network in agent containers
- Credentials never enter containers
- All external content is taint-tagged
- Everything is audited
- No dynamic imports from config values

### Reference Documents

- `docs/plans/sureclaw-prp.md` — Project requirements, design philosophy
- `docs/plans/sureclaw-architecture-doc.md` — Provider contracts, file structure, data flow
- `docs/plans/sureclaw-security-hardening-spec.md` — SC-SEC-001/002/003/004 specifications

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
