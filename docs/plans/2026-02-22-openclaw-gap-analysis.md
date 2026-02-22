# OpenClaw Gap Analysis

**Date:** 2026-02-22
**Scope:** Identify major functionality gaps between AX and OpenClaw

## Context

OpenClaw (formerly Clawdbot/Moltbot) is the dominant open-source AI agent platform — 190K+ GitHub stars, 900+ contributors, ~173K LOC. AX is a security-first alternative at ~13,500 LOC. This analysis identifies features OpenClaw ships that AX either lacks entirely, has only in design docs, or has partial implementations of.

This is not a "we should build all of these" list. Some gaps are intentional architectural decisions (no web UI, no marketplace). Others are real competitive weaknesses that limit adoption.

---

## Gap Summary

| # | Gap | OpenClaw | AX Status | Priority | Intentional? |
|---|-----|----------|-----------|----------|-------------|
| 1 | Channel coverage | 12+ platforms | Slack only | **HIGH** | No |
| 2 | Skill marketplace | ClawHub (3,286+ skills) | None | MEDIUM | Yes (security) |
| 3 | Voice support | ElevenLabs voice wake/talk | None | MEDIUM | No |
| 4 | Canvas (visual workspace) | Agent-driven HTML workspace | None | LOW | No |
| 5 | Native apps | macOS, iOS, Android | CLI only | MEDIUM | No |
| 6 | WebChat / browser access | WebChat channel | None | MEDIUM | Partially (no web UI) |
| 7 | Accessibility tree browsing | Semantic Snapshots (ARIA) | Container browser (unknown approach) | MEDIUM | No |
| 8 | ClawHub compatibility | N/A (they own it) | Design only, not implemented | MEDIUM | No |
| 9 | Security officer | N/A | Design only, not implemented | LOW | No |
| 10 | Skill screener | N/A (VirusTotal partnership) | Design only, not implemented | MEDIUM | No |
| 11 | Camera/screen capture | Built-in tools | None | LOW | No |
| 12 | Workflow shell (Lobster) | Typed macro engine | None | LOW | No |
| 13 | Webhook triggers | Built-in tool | None | MEDIUM | No |
| 14 | Multi-workspace routing | Full isolation per agent | Partial (agent-registry exists) | LOW | No |
| 15 | Vector/embedding memory search | Embedding + FTS5 | FTS5 only (sqlite), no embedding search | MEDIUM | No |

---

## Detailed Analysis

### Gap 1: Channel Coverage (HIGH)

**OpenClaw ships:** WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles (iMessage), Microsoft Teams, Matrix, Zalo, WebChat, plus native macOS/iOS/Android apps.

**AX has:** Slack (`src/providers/channel/slack.ts`).

**AX's provider map lists** WhatsApp, Telegram, and Discord — but the implementation files don't exist. Only `slack.ts` and `types.ts` are in `src/providers/channel/`. The `ChannelProvider` interface and typed `SessionAddress` system are well-designed and platform-agnostic, so adding adapters is architecturally straightforward.

**Impact:** This is the largest adoption blocker. OpenClaw's multi-channel reach is its killer feature. Users who communicate via WhatsApp or Telegram — which is most of the world — cannot use AX today.

**Recommendation:** Prioritize WhatsApp and Telegram adapters. They represent the bulk of OpenClaw's non-developer user base. Discord covers the developer/community use case.

---

### Gap 2: Skill Marketplace (MEDIUM — Intentionally Absent)

**OpenClaw ships:** ClawHub — a public skill registry with 3,286+ community skills, vector search, semver versioning, stars/comments, CLI install/publish. Anyone with a week-old GitHub account can publish.

**AX has:** Local-only skills with git-backed versioning (`skills/git.ts`) and a proposal-review-commit workflow. The Phase 3 competitive strategy doc (`2026-02-09-phase3-competitive-strategy.md`) designs ClawHub *compatibility* (parser, registry client, screening pipeline) but none of it is implemented — no `src/clawhub/` directory, no `src/providers/screener/` directory, no `src/utils/clawhub-parser.ts`.

**AX's position:** "ClawHub's open-upload model led to 341 malicious skills. Skills are local files you write or vet yourself." This is a deliberate design choice, not a missing feature. However, the ClawHavoc incident (341 malicious skills, 2,419 suspicious) validates AX's paranoia while also demonstrating that community skills have massive utility when they're not trying to steal your credentials.

**Impact:** Power users who want to quickly add capabilities (Spotify, smart home, GitHub management) have to write skills from scratch. AX's skill self-authoring helps but doesn't replace a library of battle-tested community skills.

**Recommendation:** Implement the Phase 3 ClawHub compatibility layer — import OpenClaw skills with mandatory screening. This gives AX access to the community ecosystem while maintaining the security posture. The design already exists; it needs implementation.

---

### Gap 3: Voice Support (MEDIUM)

**OpenClaw ships:** Voice Wake + Talk Mode — always-on speech for macOS, iOS, Android via ElevenLabs. Users can speak to their agent and hear responses.

**AX has:** Nothing. No voice input, no text-to-speech, no audio channel.

**Impact:** Voice is a differentiating UX for OpenClaw, especially on mobile. It transforms the agent from a text tool to a conversational assistant. However, voice requires native apps (Gap 5) as a prerequisite.

**Recommendation:** Defer until native apps exist. Voice without a native client is impractical.

---

### Gap 4: Canvas / Visual Workspace (LOW)

**OpenClaw ships:** Canvas — a separate server (port 18793) where the agent pushes interactive HTML to browser clients. The agent can create dashboards, visualizations, forms.

**AX has:** Nothing equivalent.

**Impact:** Canvas is impressive but niche. Most agent interactions are text-based. This is a "nice to have" that doesn't block core adoption.

**Recommendation:** Defer. If demand emerges, this could be a standalone provider.

---

### Gap 5: Native Mobile/Desktop Apps (MEDIUM)

**OpenClaw ships:** Native macOS, iOS, and Android apps with push notifications and voice.

**AX has:** CLI (`ax chat`, `ax send`) and Slack integration.

**Impact:** Without native apps, AX can't reach non-technical users. The CLI is great for developers; Slack is great for teams; but for personal assistant use cases, a native app is the expected form factor.

**Recommendation:** Consider a lightweight Telegram bot as a bridge — it gives mobile users push notifications and a chat interface without building native apps. A WebSocket-based terminal client could also work for power users.

---

### Gap 6: WebChat / Browser Access (MEDIUM — Partially Intentional)

**OpenClaw ships:** WebChat channel — access the agent from any browser.

**AX has:** Nothing. The "No web UI" principle eliminates the dashboard attack vector but also eliminates browser-based access.

**Impact:** AX's security rationale is sound — OpenClaw's web dashboard was CVE-2026-25253's attack vector. But a read-only, authenticated WebChat is different from a full admin dashboard. Users who want to talk to their agent from a laptop browser cannot.

**Recommendation:** Consider a minimal, authenticated WebSocket chat (no admin controls, no config UI). The attack surface of a text-only chat endpoint is orders of magnitude smaller than a full dashboard. The `ChannelProvider` interface already supports this — it would just be another adapter.

---

### Gap 7: Accessibility Tree Browser Automation (MEDIUM)

**OpenClaw ships:** Semantic Snapshots — converts web pages to structured text via the Accessibility Tree (ARIA). A 5MB screenshot becomes ~50KB of structured text with higher precision.

**AX has:** `src/providers/browser/container.ts` — a containerized Playwright browser. The exact approach (screenshots vs. accessibility tree) needs verification.

**Impact:** Semantic Snapshots are significantly more token-efficient and accurate than screenshot-based browsing. If AX uses screenshots, it's burning tokens and getting worse results.

**Recommendation:** Verify AX's browser implementation approach. If it's screenshot-based, adopt accessibility tree extraction. This is a meaningful efficiency and accuracy improvement.

---

### Gap 8: ClawHub Compatibility Layer (MEDIUM)

**OpenClaw ships:** N/A — this is about AX being able to consume OpenClaw's ecosystem.

**AX has:** A comprehensive Phase 3 design (`2026-02-09-phase3-competitive-strategy.md`) covering:
- `ClawHubSkill` parser for `SKILL.md` format
- `ClawHubRegistryClient` with caching and safePath
- Permission mapping (OpenClaw → AX)
- `SkillScreenerProvider` with 5 analysis layers (hard-reject, exfiltration, prompt injection, external deps, permission manifest)
- `SecurityOfficer` with anomaly detection

**None of this is implemented.** No `src/clawhub/`, no `src/providers/screener/`, no `src/security-officer.ts`, no `src/utils/clawhub-parser.ts`.

**Impact:** Without this, AX can't import any of the 3,286+ community skills from ClawHub. Users must write everything from scratch.

**Recommendation:** This is the highest-leverage unimplemented design. The security screening pipeline is the key differentiator — "import OpenClaw skills, but actually screen them" is a compelling pitch.

---

### Gap 9: Webhook / Event Triggers (MEDIUM)

**OpenClaw ships:** Webhook triggers as a built-in tool. External systems can poke the agent via HTTP webhooks, triggering actions.

**AX has:** Cron scheduling and heartbeats, but no inbound webhook trigger mechanism. The scheduler has `cron` and `full` providers, but webhooks aren't a distinct capability.

**Impact:** Webhooks enable integration with CI/CD, monitoring, home automation, and other event-driven systems. Without them, AX can only act on schedules or direct messages.

**Recommendation:** Add a webhook channel provider or extend the scheduler. The `ChannelProvider` interface could model webhooks as a channel with structured `InboundMessage`s.

---

### Gap 10: Skill Screener (MEDIUM)

**OpenClaw ships:** Post-ClawHavoc, OpenClaw partnered with VirusTotal for automatic malware scanning of ClawHub skills.

**AX has:** The `SkillScreenerProvider` interface exists only in the Phase 3 design doc. The git skills provider (`src/providers/skills/git.ts`) has inline hard-reject patterns (eval, exec, spawn, etc.) and capability detection, but there's no standalone screener provider.

**Impact:** The inline screening in git.ts provides baseline protection, but a dedicated screener with configurable layers (as designed in Phase 3) would be more robust, especially for ClawHub imports.

**Recommendation:** Implement the static screener from Phase 3. It's well-designed and relatively small (~100 lines of detection logic).

---

### Gap 11: Vector/Embedding Memory Search (MEDIUM)

**OpenClaw ships:** Dual retrieval — vector search (embedding-based semantic recall) plus keyword matching (SQLite FTS5). This means the agent can find memories by meaning, not just by keyword overlap.

**AX has:** Three memory providers:
- `file` (markdown + grep) — keyword only
- `sqlite` (likely FTS5) — keyword only
- `memu` (knowledge graph) — unclear if it includes embedding search

**Impact:** Without embedding-based search, the agent can only find memories that share exact keywords with the query. "What did we discuss about the project timeline?" won't find a memory stored as "deadline is March 15" unless it contains the word "timeline."

**Recommendation:** Add an embedding provider (or embed in the sqlite provider). OpenAI and Anthropic both offer embedding APIs; local models (via Ollama) work too. This is a meaningful recall quality improvement.

---

### Gap 12: Camera/Screen Capture (LOW)

**OpenClaw ships:** Camera and screen recording as built-in tools.

**AX has:** Nothing.

**Impact:** Niche use case. Most agent interactions don't need camera or screen capture.

**Recommendation:** Defer unless specific user demand emerges.

---

### Gap 13: Workflow Shell / Lobster (LOW)

**OpenClaw ships:** Lobster — a typed, local-first macro engine for composable pipelines and safe automations.

**AX has:** Nothing equivalent. Skills provide behavioral instructions but not a typed pipeline engine.

**Impact:** Lobster is a power-user tool for complex automation. Most users don't need it.

**Recommendation:** Defer. AX's skill system + scheduler covers most of the same use cases.

---

## What AX Has That OpenClaw Doesn't (or Does Better)

Not all gaps favor OpenClaw. AX has genuine advantages:

| AX Advantage | Detail |
|---|---|
| **Kernel-level sandbox isolation** | nsjail/bwrap/seatbelt with no network. OpenClaw's Docker sandbox is optional and Gateway-only. |
| **Credentials never enter containers** | Host-side proxy injection. OpenClaw exposes credentials to the agent runtime. |
| **Taint tracking** | External content tagged and tracked. Taint budget gates sensitive actions based on external content ratio. |
| **Auditability** | ~13,500 LOC vs ~173,000. Entire codebase readable in a weekend. |
| **No web dashboard attack surface** | OpenClaw's CVE-2026-25253 came from the web UI. AX doesn't have one. |
| **Git-backed skill versioning** | Proposal-review-commit with full git history and revert. OpenClaw skills are plain files. |
| **Modular system prompts** | Composable prompt modules with token budget tracking. OpenClaw uses layered markdown files. |
| **Static provider allowlist** | SC-SEC-002 prevents dynamic import path injection. OpenClaw's module loading is more permissive. |
| **Security profiles** | Paranoid/Standard/Power User dial with architectural invariants that hold at all levels. |
| **Bootstrap ritual** | Agent identity discovery through conversation, gated by security profile. Inspired by OpenClaw but secured by IPC trust boundary. |

---

## Prioritized Recommendations

### Tier 1: Adoption Blockers (do these first)

1. **WhatsApp channel adapter** — Largest non-developer user base
2. **Telegram channel adapter** — Second largest; strong developer/power-user overlap
3. **Discord channel adapter** — Community/team use case

### Tier 2: Competitive Differentiation (the AX pitch)

4. **ClawHub compatibility + skill screener** — "Import OpenClaw skills, but actually screened." Phase 3 design exists; needs implementation.
5. **Embedding-based memory search** — Meaningful recall quality improvement.
6. **Webhook triggers** — Enables event-driven automation integrations.

### Tier 3: Experience Polish

7. **Accessibility tree browser snapshots** — Token efficiency + accuracy. Verify current approach first.
8. **WebChat channel (authenticated, minimal)** — Browser access without the dashboard attack surface.
9. **Native app or lightweight mobile bridge** — Telegram bot may serve as interim solution.

### Tier 4: Defer

10. Voice support (needs native apps first)
11. Canvas/visual workspace (niche)
12. Camera/screen capture (niche)
13. Lobster/workflow shell (skills cover most cases)
