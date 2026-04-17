# Host

Host process lessons: IPC server, orchestration, plugin framework, delegation, and server wiring.

## Entries

- Admin auth is bypassed on loopback when BIND_HOST defaults to 127.0.0.1 [entries.md](entries.md)
- Appliers diff desired-state against live runtime with a closure-scoped prior map [entries.md](entries.md)
- Shared resources consumed by both core and server.ts belong in HostCore [entries.md](entries.md)
- Never have two independent timers managing the same resource lifecycle [entries.md](entries.md)
- Admin state is filesystem-based and doesn't sync across k8s pods [entries.md](entries.md)
- Admin TCP port must handle EADDRINUSE gracefully [entries.md](entries.md)
- Tailwind v4 uses @tailwindcss/postcss, not direct tailwindcss plugin [entries.md](entries.md)
- IPC defaultCtx.agentId is 'system', not the configured agent name [entries.md](entries.md)
- Plugin providers use a runtime Map, not the static _PROVIDER_MAP [entries.md](entries.md)
- Child process IPC for plugins: fork() + process.send(), not worker_threads [entries.md](entries.md)
- Orchestrator handle sessionId must match child agent event requestId [entries.md](entries.md)
- enableAutoState() must be called in production code [entries.md](entries.md)
- Session-to-handle mapping must be 1:N [entries.md](entries.md)
- resolveCallerHandle OR vs AND bug pattern [entries.md](entries.md)
- Orchestration handlers now wired into createIPCHandler [entries.md](entries.md)
- Async fire-and-forget needs a collect mechanism, not polling [entries.md](entries.md)
