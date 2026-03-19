# Security

## MITM proxy canary detection must send HTTP response before destroying TLS socket
**Date:** 2026-03-19
**Context:** Implementing canary token scanning on decrypted HTTPS traffic in the MITM proxy
**Lesson:** When detecting a canary in MITM-intercepted TLS traffic, calling `clientTls.destroy()` alone causes the client to see an opaque connection reset, not a meaningful error. Always write an HTTP 403 response to the TLS socket before calling `clientTls.end()` and `targetTls.destroy()`. This lets the client parse a clean 403 status code.
**Tags:** web-proxy, mitm, tls, canary, security

## node-forge SAN for IP addresses requires type 7, not type 2
**Date:** 2026-03-19
**Context:** Generating domain certs for MITM proxy — tests using 127.0.0.1 as hostname
**Lesson:** In node-forge subjectAltName, DNS names use `{ type: 2, value: 'example.com' }` but IP addresses MUST use `{ type: 7, ip: '127.0.0.1' }`. Use `net.isIP()` to detect and switch. Using type 2 for IPs causes "IP is not in the cert's list" errors.
**Tags:** tls, certificates, node-forge, san, ip-address

## Domain cert cache must include CA identity in cache key
**Date:** 2026-03-19
**Context:** MITM proxy tests failing because domain certs were cached across tests using different CAs
**Lesson:** When caching generated domain certs, key the cache by domain + CA hash (e.g., SHA-256 of CA cert), not just domain. Otherwise, a cert signed by CA1 gets returned for a request using CA2, causing "certificate signature failure". Use `createHash('sha256').update(ca.cert).digest('hex').slice(0, 16)` for the CA portion of the cache key.
**Tags:** tls, certificates, caching, testing, mitm

### import.meta.resolve() is the secure way to resolve package names
**Date:** 2026-02-28
**Context:** Analyzing security of monorepo split — switching provider-map from relative paths to @ax/provider-* package names
**Lesson:** When using dynamic `import(packageName)`, Node.js resolves from CWD upward through the node_modules hierarchy. An attacker who controls CWD can shadow any package. Use `import.meta.resolve(packageName)` instead — it resolves from the calling module's location (like `new URL(path, import.meta.url)` does for relative paths). Stable since Node 20.6.
**Tags:** security, import, node-modules, cwd-hijacking, provider-map, SC-SEC-002

### Static allowlist (SC-SEC-002) can point to package names, not just relative paths
**Date:** 2026-02-26
**Context:** Designing how provider-map.ts would work after a monorepo split
**Lesson:** `resolveProviderPath()` currently resolves relative paths via `new URL(relativePath, import.meta.url)`. For npm packages, it can use `import('@ax/provider-llm-anthropic')` instead — this is still a static allowlist (hardcoded package names, not config-derived), so SC-SEC-002 is preserved. The key invariant is "no dynamic path construction from config values," not "paths must be relative."
**Tags:** security, SC-SEC-002, provider-map, npm-packages, static-allowlist

### Allowlist guards must cover the "no value" case, not just "wrong value"
**Date:** 2026-03-03
**Context:** PR review caught that the webhook agent allowlist only checked `if (result.agentId && config.allowedAgentIds)` — so omitting agentId bypassed the check entirely, falling back to the default agent.
**Lesson:** When guarding with an allowlist, always check for the case where the value is absent, not just when it's present but wrong. Pattern: `if (allowlist) { if (!value || !allowlist.includes(value)) reject(); }` — check the allowlist existence first (outer), then require the value to be present AND in the list (inner).
**Tags:** security, allowlist, authorization, webhook, defense-in-depth

### safePath() treats its arguments as individual path segments, not relative paths
**Date:** 2026-02-22
**Context:** Workspace handler was producing flat filenames like `deep_nested_file.txt` instead of nested paths
**Lesson:** `safePath(base, 'deep/nested/file.txt')` treats the second arg as a single segment and replaces `/` with `_`. For relative paths from user input, split on `/` and `\` first: `safePath(base, ...relativePath.split(/[/\\]/).filter(Boolean))`. Created `safePathFromRelative()` helper for this pattern.
**Tags:** safePath, security, SC-SEC-004, path-traversal, workspace
