# Security

### Validate shapes at schema boundaries, not downstream consumers
**Date:** 2026-04-17
**Context:** CodeRabbit flagged `domains: z.array(z.string().min(1).max(253))` in the skill frontmatter schema. The values fed a proxy allowlist (`approvedDomains.has(domain)`) and a reconciler that builds `desired.proxyAllowlist` — exact-string matching means `"not a host"` or `"https://api.linear.app"` would silently land in the allowlist if a later refactor ever used fuzzy matching or URL parsing.
**Lesson:** When a schema field feeds a security-sensitive downstream (allowlist, cred resolution, path building), validate the shape at parse time rather than trusting the consumer to reject bad input. For hostnames in Zod, combine `.transform(s => s.trim().toLowerCase())` with a `.refine()` RFC 1035-style regex (labels 1-63, total ≤253, no scheme/path). Bad entries fail at `parseSkillFile` rather than rippling through to reconciliation.
**Tags:** security, validation, zod, schema, proxy-allowlist, skills

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

### MITM TLS proxies expand trust much more than explicit service proxies
**Date:** 2026-03-19
**Context:** Evaluating whether AX could support env-auth skill CLIs in k8s by terminating TLS on the host and injecting upstream credentials there.
**Lesson:** A MITM proxy can keep the raw API key out of the sandbox, but only by teaching the sandbox to trust a host-controlled root CA. That turns the host into a universal impersonator for any intercepted domain and is a materially broader trust expansion than AX's explicit `/internal/*` proxies. Prefer explicit per-service proxy routes or narrow RPC helpers first; use MITM only as a last resort for unmodifiable binaries, with strict domain/path allowlists and short-lived turn authentication.
**Tags:** security, mitm, proxy, tls, k8s, sandbox, credentials

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
