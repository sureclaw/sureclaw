# Security

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
