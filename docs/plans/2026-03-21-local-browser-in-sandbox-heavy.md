# Local Browser in Sandbox-Heavy

**Date:** 2026-03-21
**Status:** Design

## Motivation

Browser automation currently runs Playwright/Chromium in the **host process**, with 7 IPC actions proxying every browser operation from the agent sandbox to the host. This creates:

1. **Unnecessary complexity** — every click, navigate, and snapshot requires an IPC round-trip through the host
2. **Scalability bottleneck** — multiple agents contend on a single host-side Chromium instance

## Design

Move Playwright/Chromium into the **sandbox-heavy container image**. Browser runs locally in the agent process. No host involvement, no IPC for browser operations.

### Container Image

Single `container/agent/Dockerfile` with a `BUILD_VARIANT` build arg:

- **Light** (`BUILD_VARIANT=light`): `node:22-slim` + git. Same as today. No Playwright.
- **Heavy** (`BUILD_VARIANT=heavy`): `mcr.microsoft.com/playwright` base image + same agent dependencies. Includes Chromium.

### Agent Browser Flow

1. Agent wants to use browser → tries `import('playwright')`
2. **If available** (heavy sandbox): browser tools registered, all operations (navigate, click, snapshot, type, screenshot, close) run in-process
3. **If not available** (light sandbox): sends `browser_launch` IPC to host → host triggers escalation to heavy sandbox → agent resumes with Playwright available

### Sandbox Escalation (Light → Heavy)

When a light sandbox agent needs browser access:

1. Agent tries `import('playwright')` → fails (not installed)
2. Agent sends `browser_launch` IPC action to host
3. Host receives `browser_launch` from a light sandbox → recognizes as escalation request
4. Host spawns heavy sandbox with same workspace volume
5. Host waits for heavy sandbox readiness + agent bootstrap handshake
6. Host switches routing/session to heavy sandbox
7. Host terminates light sandbox
8. If heavy bootstrap fails, keep light sandbox alive and surface escalation error
9. All subsequent browser operations are local — no more IPC

The cold-start delay for escalation only happens once per session, and only when the agent actually needs browser.

### Network Access

Chromium in the heavy sandbox routes outbound traffic through the **existing web proxy** on the host — the same proxy that CLI tools already use for network access. No new network infrastructure needed.

### Dev/Subprocess Mode

In local development with `sandbox: subprocess`, browser availability depends on whether the developer has Playwright installed locally (`npx playwright install`). If not installed, browser tools are simply unavailable. No fallback to host-side browser.

## Changes

### Removed

- **6 of 7 browser IPC actions**: `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_screenshot`, `browser_close` — all removed from `src/ipc-schemas.ts` and `src/host/ipc-handlers/browser.ts`
- **Host-side browser provider loading** — removed from `src/host/registry.ts` and `src/host/provider-map.ts`
- **`config.providers.browser` config option** — no longer needed (browser availability is determined by Playwright presence, not config)
- **`container/browser/Dockerfile`** — unused, cleanup

### Repurposed

- **`browser_launch` IPC action** — kept, but repurposed as escalation trigger (light → heavy sandbox)
- **`src/providers/browser/container.ts`** — same code, loaded agent-side instead of host-side
- **`src/providers/browser/none.ts`** — returned when Playwright is not available

### Added

- **`BUILD_VARIANT` arg in `container/agent/Dockerfile`** — controls light vs heavy image build
- **Escalation handler in host** — `browser_launch` from light sandbox triggers respawn as heavy
- **Agent-side browser tool registration** — auto-detects Playwright at startup, registers local browser tools if available
- **Fallback in agent browser tool** — if Playwright not available, sends `browser_launch` IPC to trigger escalation

## Files Affected

### Container
- `container/agent/Dockerfile` — add `BUILD_VARIANT` arg, conditional Playwright base
- `container/browser/Dockerfile` — delete

### Agent-side
- `src/agent/` — new local browser tool that loads `src/providers/browser/container.ts` directly
- `src/providers/browser/container.ts` — minor changes to work agent-side (proxy config for Chromium)

### Host-side
- `src/host/ipc-handlers/browser.ts` — replace with escalation handler (only handles `browser_launch`)
- `src/ipc-schemas.ts` — remove 6 browser action schemas
- `src/host/provider-map.ts` — remove `browser` entry
- `src/host/registry.ts` — remove browser provider loading

### Config
- `src/onboarding/prompts.ts` — remove browser provider selection
- `charts/ax/values.yaml` — remove `providers.browser` config, update heavy tier image reference

### Cleanup
- `tests/providers/browser/container.test.ts` — update to test agent-side loading
