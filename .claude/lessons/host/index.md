# Host

Host process lessons: IPC server, orchestration, plugin framework, delegation, and server wiring.

## Entries

- In-memory registries need an automatic repopulation trigger on every pod-restart path — don't leave them dependent on a human click [entries.md](entries.md)
- When multiple dispatcher paths do "the same thing", parity drift between them is a latent regression — funnel through a single helper [entries.md](entries.md)
- Codegen JSDoc must match the generated function signature exactly — mismatch causes agent retry spirals [entries.md](entries.md)
- `safePath` guards filesystem paths; use fail-fast segment check for repo-relative commit paths [entries.md](entries.md)
- Don't mark deps optional "for test fixtures" — required-in-production means required [entries.md](entries.md)
- Use empty-string sentinel in composite PKs when "null" needs to participate in the key [entries.md](entries.md)
- One clock not two — DB-side `sqlEpoch(dbType)` for both defaults AND `ON CONFLICT` updates [entries.md](entries.md)
- Cache-hit tests must delete the underlying resource to prove I/O didn't run [entries.md](entries.md)
- Use `Map`-backed LRU in Node — insertion order is guaranteed, no dep needed [entries.md](entries.md)
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
