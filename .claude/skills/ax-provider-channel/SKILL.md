---
name: ax-provider-channel
description: Use when modifying message channel providers — Slack integration, session addressing, or adding new channels (Discord, Telegram) in src/providers/channel/
---

## Overview

Channel providers handle message ingress/egress between external platforms and the AX host, using session addressing to maintain separate conversations across DM, channel, thread, and group scopes. Each implements `ChannelProvider` from `src/providers/channel/types.ts` and exports `create(config)`.

## Interface

**SessionAddress** -- `provider` (platform name), `scope` (`dm|channel|thread|group`), `identifiers` (`{ workspace?, channel?, thread?, peer?, dmChannel? }`), `parent?` (links threads to channels). `canonicalize()` serializes to a colon-delimited map key. Note: `dmChannel` is stored for reactions API but not included in `canonicalize()`.

**Messages** -- `InboundMessage`: `id`, `session`, `sender`, `content`, `attachments`, `timestamp`, `replyTo?`, `raw?`, `isMention?`. `OutboundMessage`: `content`, `attachments?`, `replyTo?`.

**Attachment** -- `filename`, `mimeType`, `size`, `content?` (Buffer for inline data), `url?` (provider URL for lazy download).

**ChannelProvider** methods:

| Method                      | Purpose                              |
|-----------------------------|--------------------------------------|
| `connect()`                 | Establish platform connection        |
| `onMessage()`               | Register inbound handler             |
| `shouldRespond()`           | Access control gate                  |
| `send()`                    | Send outbound message (text + files) |
| `disconnect()`              | Tear down connection                 |
| `addReaction?` (optional)   | Add emoji reaction to message        |
| `removeReaction?` (optional)| Remove emoji reaction                |
| `fetchThreadHistory?`       | Retrieve thread message history      |
| `downloadAttachment?`       | Fetch attachment content with auth   |

**ChannelAccessConfig** -- DM policy (`open`/`allowlist`/`disabled`), mention gating, attachment filtering (size & MIME types). Set in `ax.yaml` under `channel_config.<name>`.

## Slack Implementation

- `@slack/bolt` + `SocketModeReceiver`, dynamically imported. Requires `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`.
- `app.message()` handles DMs/group DMs/thread replies; `app.event('app_mention')` handles channel mentions. Prevents duplicates.
- Strips `<@BOT_ID>` from text. Chunks long messages at newlines (4000 char limit).
- **Socket disconnect crash fix:** Disables library auto-reconnect (has unhandled promise rejection bug). Runs own health-check loop with exponential backoff (30s interval, 5s-5m backoff).
- **Image pipeline:** Uses `files.uploadV2()` for binary attachments. Sends text as `initial_comment` on first upload to combine text + image as single message. Downloads lazy attachments with bearer token auth via `downloadAttachment()`.
- **Multi-agent Slack UX:** `createWithTokens(config, { botToken, appToken }, providerName?)` creates a Slack provider with injected tokens (used by shared agents). Each shared agent gets its own Slack bot identity. The `providerName` parameter defaults to 'slack' but shared agents use `slack:{agentId}` for distinct logging.

## Session Addressing

| Scope     | Identifiers                  | Notes                                  |
|-----------|------------------------------|----------------------------------------|
| `dm`      | `{ peer, dmChannel? }`       | One session per user; stores DM channel ID for reactions |
| `channel` | `{ channel }`                | Shared across all users                |
| `thread`  | `{ channel, thread }`        | Own session; `parent` links to channel |
| `group`   | `{ channel }`                | Multi-party DM (Slack `mpim`), scoped per group |

## Adding a New Channel Provider

1. Create `src/providers/channel/<name>.ts` implementing `ChannelProvider`.
2. Export `create(config: Config): Promise<ChannelProvider>`.
3. Add `(channel, <name>)` to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Map platform events to `SessionAddress` scopes in a `buildSession()` helper.
5. Implement `shouldRespond()` with `ChannelAccessConfig`.
6. For file support: implement `send()` with attachment handling (lazy download or inline buffers) and optional `downloadAttachment()`.
7. Add `channel_config.<name>` to the Zod `ConfigSchema` in `src/types.ts`.
8. Add tests in `tests/providers/channel/<name>.test.ts`.

## Gotchas

- **No `peer` in channel/thread keys.** Fragments shared conversations into per-user sessions.
- **Workspace ID unnecessary.** Bot tokens are already workspace-scoped.
- **Group DMs need special handling.** Slack `channel_type: 'mpim'`; scope as `group`, not `channel`.
- **Bolt dual-fires for @mentions.** Guard `app.message()` to DMs only or get duplicates.
- **Socket-mode reconnect silently dies.** Disable library auto-reconnect; use external health-check loop with exponential backoff (not linear).
- **Event deduplication required.** Track in-flight message IDs in a `Set`.
- **Attachment uploads use uploadV2().** Always use `files.uploadV2()`. Pass `initial_comment` for text on first upload.
- **Attachment downloads need auth.** Bearer token in `Authorization` header; cache content in `Attachment.content` to avoid re-fetching.
- **`dmChannel` is not part of session identity.** Stored for reactions API but excluded from `canonicalize()`.
- **`channel_config` needs both TS type and Zod schema.** Use `strictObject` to reject unknown keys.
