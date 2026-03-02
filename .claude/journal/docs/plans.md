# Docs: Plans

Architecture analysis, gap analysis, design documents, implementation plans.

## [2026-03-02 12:00] — Create MemoryFS v2 plan (files-first, memU-inspired)

**Task:** Summarize conversation decisions about memory architecture and create a revised plan
**What I did:** Reviewed conversation about git tracking (rejected), SQLite-as-source-of-truth (rejected), and markdown-files-as-source-of-truth (chosen). Incorporated memU's architecture: three-layer data model (Resource→Item→Category), inline processing (memorize extracts+categorizes in one call), reinforcement instead of decay, no background processes. Wrote comprehensive v2 plan with 3 phases: Phase 1 (core memory, zero SQLite), Phase 2 (FTS5+embeddings search index), Phase 3 (richer history options).
**Files touched:** docs/plans/2026-03-02-memoryfs-v2-plan.md (new)
**Outcome:** Success — plan written, not yet committed
**Notes:** Key removals vs v1: Reconciler, Decayer, Monitor, Anticipator, Git Worker, two-phase writes, trigger files. SQLite is now a derived search index only — blow it away and rebuild from files. Reinforcement (access count [×N] inline in files) replaces timer-based decay.

## [2026-02-22 20:30] — OpenClaw gap analysis

**Task:** Identify major functionality gaps between AX and OpenClaw
**What I did:** Researched OpenClaw's full feature set (12+ channels, ClawHub marketplace with 3,286+ skills, voice support, Canvas visual workspace, native apps, Semantic Snapshots browser automation, Lobster workflow shell, webhook triggers, embedding-based memory search) and mapped it against AX's actual implementation state. Produced a prioritized gap analysis document with 15 identified gaps, categorized by priority and whether they're intentional design decisions.
**Files touched:** docs/plans/2026-02-22-openclaw-gap-analysis.md (created), .claude/journal.md (modified)
**Outcome:** Success — comprehensive gap analysis with prioritized recommendations
**Notes:** Key findings: (1) Channel coverage is the #1 adoption blocker — only Slack is implemented, WhatsApp/Telegram/Discord files don't exist despite being in provider-map.ts. (2) Phase 3 competitive strategy (ClawHub compatibility, skill screener, security officer) is entirely unimplemented. (3) AX has genuine security advantages that OpenClaw lacks (kernel sandbox, credential proxy, taint tracking). (4) Several gaps are intentional architectural decisions (no web UI, no marketplace).
