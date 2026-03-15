# Storage Provider Lessons

### Template seeding must write to BOTH filesystem AND DocumentStore
**Date:** 2026-03-15
**Context:** First-run bootstrap was broken when using GCS-backed DocumentStore — template files were only seeded to filesystem, but identity files are loaded from DocumentStore for agent prompts.
**Lesson:** When seeding template files (BOOTSTRAP.md, AGENTS.md, etc.) on first run, always write to both the filesystem (for `isAgentBootstrapMode()` compat) and the DocumentStore (for `loadIdentityFromDB()`). The DocumentStore is the authoritative source for agent prompt assembly. Any new template seeding code must handle both storage layers.
**Tags:** bootstrap, identity, DocumentStore, GCS, first-run, dual-storage
