# IPC

IPC protocol lessons: Zod schema validation, handler registration, response shapes, memory leaks, and Zod v4 migration.

## Entries

- "catalog" grep matches both tool-catalog and catalog-store — different systems [entries.md](entries.md)
- IPC client cannot handle concurrent calls without message ID correlation [entries.md](entries.md)
- IPC schemas use z.strictObject — extra fields cause silent validation failures [entries.md](entries.md)
- ipcAction() auto-registers schemas in IPC_SCHEMAS — just call it at module level [entries.md](entries.md)
- IPC schema enums must use exact values — check ipc-schemas.ts [entries.md](entries.md)
- IPC handler response shapes vary by handler — check the actual handler code [entries.md](entries.md)
- Adding IPC schemas without handlers causes ipc-server tests to fail [entries.md](entries.md)
- onDelegate callback signature changes require updating all test files + harness [entries.md](entries.md)
- Orchestration IPC actions need registration in both sync tests [entries.md](entries.md)
- z.record() in Zod v4 requires key and value schemas [entries.md](entries.md)
- Promise.race timeouts MUST be cleared in finally blocks [entries.md](entries.md)
- Always clean up Map entries in ALL code paths (success AND error) [entries.md](entries.md)
