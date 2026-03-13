---
name: provider-scanner
description: Use when modifying input/output security scanners — regex patterns, canary tokens, or LLM-based detection in src/providers/scanner/
---

## Overview

Scanners check inbound/outbound messages for prompt injection, data leakage, and canary token exposure. They sit in the router pipeline (`router.ts`) -- `scanInput()` gates inbound messages, `scanOutput()` gates agent responses.

## Interface (`src/providers/scanner/types.ts`)

- **`ScanTarget`**: `{ content, source, taint?, sessionId }`
- **`ScanResult`**: `{ verdict: 'PASS' | 'FLAG' | 'BLOCK', reason?, patterns? }`
- **`ScannerProvider`**:
  - `scanInput(msg: ScanTarget): Promise<ScanResult>` -- checks inbound for injection/jailbreak
  - `scanOutput(msg: ScanTarget): Promise<ScanResult>` -- checks outbound for PII/credential leakage
  - `canaryToken(): string` -- generates a `CANARY-<hex>` token
  - `checkCanary(output: string, token: string): boolean` -- returns true if token leaked into output

## Implementations

| Name | File | Detection Method |
|---|---|---|
| patterns | `src/providers/scanner/patterns.ts` | Structured `Pattern[]` with `{ regex, category, severity }`. Worst-severity-wins logic. Categories: `injection:direct`, `injection:persona`, `injection:extraction`, `injection:code`, `injection:shell`, `exfiltration`, `pii:*`, `credential:*`. |
| guardian | `src/providers/scanner/guardian.ts` | Two-layer detection. Layer 1: regex patterns (same structure as patterns.ts). Layer 2: LLM-based classification using the configured fast model. Regex BLOCK skips LLM; LLM can escalate PASS to FLAG/BLOCK. Falls back to regex-only when LLM is unavailable. Accepts `CreateOptions { llm?: LLMProvider }`. |

Note: The `basic` scanner was removed. Use `patterns` for regex-only or `guardian` for regex + LLM.

## Pattern System (`patterns.ts`)

Each `Pattern` has: `regex` (RegExp), `category` (namespaced string like `injection:direct`), `severity` (`INFO | FLAG | BLOCK`). The scanner iterates all patterns, collects matches, and returns the worst severity. Input patterns cover injection, persona hijack, system prompt extraction, code execution, shell injection, and exfiltration. Output patterns cover PII (SSN, credit card, email, phone) and credentials (Anthropic, OpenAI, GitHub, AWS, Slack keys, private keys, JSON/env secrets).

## Canary Tokens

Generated via `randomBytes(16).toString('hex')` prefixed with `CANARY-`. The router injects the token into inbound messages (as an HTML comment). On outbound, `checkCanary()` does `output.includes(token)`. If the canary appears in agent output, the response is fully redacted. Guard: never check with an empty token (`''.includes('')` is always true).

## Common Tasks

**Adding a new scanner pattern:**
1. Add a `Pattern` entry to `INPUT_PATTERNS` or `OUTPUT_PATTERNS` in `patterns.ts`.
2. Choose category (`injection:*`, `pii:*`, `credential:*`, `exfiltration`).
3. Set severity: `BLOCK` for definite threats, `FLAG` for suspicious, `INFO` for informational.
4. Add a test case in `tests/providers/scanner/`.

**Adding a new scanner implementation:**
1. Create `src/providers/scanner/<name>.ts` implementing `ScannerProvider`.
2. Export `create(config: Config)`.
3. Add `(scanner, <name>)` entry to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/scanner/<name>.test.ts`.

## Gotchas

- **Alternation groups too strict**: `(a|b)` fails when input has extra words between matches. Use optional groups `(all\s+)?` or bounded wildcards `.{0,N}`.
- **Greedy `\S+` eats URL chars**: `\S+` consumes `?`, `&`, `=`. Anchor on `[?&]` for URL parameter patterns instead.
- **Multi-word sequences need optional groups**: "forget all your previous instructions" requires each intermediate word as `(all\s+)?(your\s+)?(previous\s+)?`, not a strict alternation.
- **Strip punctuation before keyword matching**: Words like `"system:"` or `"instructions?"` won't match keyword lists. Use `w.replace(/[^a-z0-9]/g, '')`.
- **`''.includes('')` is always true**: Empty canary tokens cause universal redaction. Always guard `token.length > 0`.
- **Guardian LLM fallback**: If no LLM is passed or the LLM call fails, guardian silently falls back to regex-only. Always test both paths.
- **Output scanning is regex-only**: Even in guardian, output scanning doesn't use the LLM — credential/PII patterns are deterministic.
