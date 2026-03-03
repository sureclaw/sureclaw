# Security

Security patterns: import resolution, static allowlist design, and safe path handling.

## Entries

- import.meta.resolve() is the secure way to resolve package names [entries.md](entries.md)
- Static allowlist (SC-SEC-002) can point to package names, not just relative paths [entries.md](entries.md)
- Allowlist guards must cover the "no value" case, not just "wrong value" [entries.md](entries.md)
- safePath() treats its arguments as individual path segments, not relative paths [entries.md](entries.md)
