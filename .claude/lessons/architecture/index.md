# Architecture

Design patterns, provider contracts, import hygiene, event bus design, and workspace layout decisions.

## Entries

- Three tool dispatch paths all need sandbox wiring [entries.md](entries.md)
- Anchor fast-path designs at the existing IPC seam [entries.md](entries.md)
- Prefer structural layout fixes over runtime workarounds [entries.md](entries.md)
- Provider contract pattern IS the plugin framework — packaging is the missing piece [entries.md](entries.md)
- Cross-provider imports should go through shared-types.ts, not sibling directories [entries.md](entries.md)
- Shared utilities between routers go in src/providers/router-utils.ts [entries.md](entries.md)
- EventBus should be optional and synchronous to avoid blocking the hot path [entries.md](entries.md)
- Extend the EventBus rather than replacing it for orchestration [entries.md](entries.md)
- Canonical path names should match their semantic role, not implementation [entries.md](entries.md)
- Eliminate redundant mount points rather than documenting differences [entries.md](entries.md)
- AX has two workspace directories — session sandbox vs enterprise user [entries.md](entries.md)
- OverlayFS for merging skill layers with fallback [entries.md](entries.md)
