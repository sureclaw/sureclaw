# Acceptance Tests: OpenClaw Switcher — Slack Experience

**Plan document(s):** N/A (derived from OpenClaw feature parity analysis)
**Date designed:** 2026-03-06
**Total tests:** 17 (ST: 8, BT: 6, IT: 3)

## Context

OpenClaw's messaging-first users interact with their AI agent through Slack (or Telegram/Discord/WhatsApp). Their core expectations:

1. **Heartbeat notifications** — The agent wakes up on a schedule, checks its task list, and proactively messages them in Slack
2. **Persistent memory** — The agent remembers preferences and facts across sessions, recallable via Slack conversation
3. **Skill execution** — The agent can list, read, and execute skills when asked through Slack

This test validates that AX delivers all three through the Slack channel, proving an OpenClaw user would feel at home.

## Summary of Acceptance Criteria

1. Slack channel provider loads and connects via Socket Mode with bot and app tokens
2. Inbound Slack messages (DMs and @mentions) are routed to the agent and produce responses
3. Agent responses are delivered back to the correct Slack session (DM or thread)
4. Heartbeat scheduler fires on interval and reads HEARTBEAT.md
5. Heartbeat responses with `delivery.target = 'last'` resolve to the most recent Slack session
6. Heartbeat notifications arrive in Slack when the agent has something to report
7. Agent can store memories via the `memory` tool during a Slack conversation
8. Stored memories persist across sessions and are recallable
9. Automatic memory recall injects relevant memories into new conversation context
10. Agent can list and read skills via the `skill` tool during a Slack conversation
11. Agent follows skill instructions and returns results through Slack
12. Scheduler tools (add_cron, run_at, list, remove) are available when HEARTBEAT.md exists
13. Session tracking records Slack sessions for "last" delivery target resolution
14. Memory userId scoping works correctly in Slack DM context (user-isolated)
15. The end-to-end flow works: user chats in Slack, agent remembers, heartbeat fires, agent notifies in Slack referencing the memory

---

## Structural Tests

### ST-1: Slack channel provider is registered in provider-map

**Criterion:** Slack must be a loadable channel provider via the static allowlist (AC-1)
**Plan reference:** ax-architecture-doc.md, provider-map.ts

**Verification steps:**
1. Read `src/host/provider-map.ts` and check that `channel.slack` entry exists
2. Verify the path points to `../providers/channel/slack.js`
3. Read `src/providers/channel/slack.ts` and verify it exports a `create(config)` function

**Expected outcome:**
- [ ] `channel.slack` exists in provider map with correct path
- [ ] `slack.ts` exports `create` function matching ChannelProvider contract

**Pass/Fail:** _pending_

---

### ST-2: Slack provider implements full ChannelProvider interface

**Criterion:** Slack provider must implement connect, onMessage, shouldRespond, send, addReaction, removeReaction, fetchThreadHistory, downloadAttachment (AC-1, AC-2, AC-3)
**Plan reference:** src/providers/channel/types.ts

**Verification steps:**
1. Read `src/providers/channel/types.ts` to get the ChannelProvider interface methods
2. Read `src/providers/channel/slack.ts` and check that all interface methods are implemented
3. Verify `send()` handles text chunking (4000 char limit) and file uploads

**Expected outcome:**
- [ ] All required ChannelProvider methods are implemented
- [ ] Optional methods (addReaction, removeReaction, fetchThreadHistory, downloadAttachment) are implemented
- [ ] send() chunks text at 4000 chars

**Pass/Fail:** _pending_

---

### ST-3: Heartbeat prompt module includes scheduler tool instructions

**Criterion:** When HEARTBEAT.md exists, the agent prompt must include heartbeat check instructions and scheduler tools (AC-4, AC-12)
**Plan reference:** src/agent/prompt/modules/heartbeat.ts

**Verification steps:**
1. Read `src/agent/prompt/modules/heartbeat.ts` and verify:
   a. `shouldInclude()` gates on `ctx.identityFiles.heartbeat?.trim()`
   b. Content teaches agent about HEARTBEAT_OK and SILENT_REPLY responses
   c. Content describes scheduler tool types: add_cron, run_at, remove, list
2. Read `src/agent/tool-catalog.ts` and verify scheduler tools are registered with correct IPC action mappings
3. Verify scheduler tools are only included when `ctx.hasHeartbeat` is true

**Expected outcome:**
- [ ] Heartbeat module gates on HEARTBEAT.md content
- [ ] Prompt includes HEARTBEAT_OK and SILENT_REPLY guidance
- [ ] Scheduler tool types (add_cron, run_at, remove, list) are documented in prompt
- [ ] Scheduler tools are conditionally included based on hasHeartbeat flag

**Pass/Fail:** _pending_

---

### ST-4: Delivery resolver supports 'last' target for channel delivery

**Criterion:** Heartbeat/cron responses must resolve `delivery.target = 'last'` to the most recent Slack session (AC-5, AC-13)
**Plan reference:** src/host/delivery.ts

**Verification steps:**
1. Read `src/host/delivery.ts` and verify:
   a. `resolveDelivery()` handles `target === 'last'` case
   b. It calls `sessionStore.getLastChannelSession(agentId)` for resolution
   c. Returns NONE when no last session exists
2. Read `src/host/server-channels.ts` and verify `sessionStore.trackSession()` is called after successful channel responses
3. Read `src/host/server.ts` (scheduler handler, lines ~899-965) and verify delivery resolution is called after completion

**Expected outcome:**
- [ ] delivery.ts handles 'last' target by querying sessionStore
- [ ] server-channels.ts tracks sessions after successful responses
- [ ] server.ts scheduler handler calls resolveDelivery and dispatches to channel

**Pass/Fail:** _pending_

---

### ST-5: Memory tools are available and map to correct IPC actions

**Criterion:** Agent must have memory tools (write, query, read, delete, list) for storing and recalling information (AC-7, AC-8)
**Plan reference:** src/agent/tool-catalog.ts, src/ipc-schemas.ts

**Verification steps:**
1. Read `src/agent/tool-catalog.ts` and verify memory tool definition with all 5 action types
2. Verify action map: write→memory_write, query→memory_query, read→memory_read, delete→memory_delete, list→memory_list
3. Read `src/ipc-schemas.ts` and verify all 5 memory schemas exist with strict validation
4. Read `src/host/ipc-handlers/memory.ts` and verify userId injection for DM context

**Expected outcome:**
- [ ] Memory tool registered with all 5 operation types
- [ ] IPC schemas exist for all 5 memory actions
- [ ] Handlers inject userId when sessionScope is 'dm' or undefined
- [ ] Memory writes in DM context are user-scoped

**Pass/Fail:** _pending_

---

### ST-6: Skill tools are available and map to correct IPC actions

**Criterion:** Agent must have skill tools (list, read, propose, import, search, install) for discovering and executing skills (AC-10, AC-11)
**Plan reference:** src/agent/tool-catalog.ts, src/ipc-schemas.ts

**Verification steps:**
1. Read `src/agent/tool-catalog.ts` and verify skill tool definition with all action types
2. Verify action map: list→skill_list, read→skill_read, propose→skill_propose, import→skill_import, search→skill_search, install→skill_install, install_status→skill_install_status
3. Read `src/ipc-schemas.ts` and verify all skill schemas exist
4. Verify SkillsModule in `src/agent/prompt/modules/skills.ts` renders skill summaries in system prompt

**Expected outcome:**
- [ ] Skill tool registered with all 7 operation types
- [ ] IPC schemas exist for all skill actions
- [ ] SkillsModule renders available skills in system prompt

**Pass/Fail:** _pending_

---

### ST-7: Memory recall module auto-injects relevant memories into conversation

**Criterion:** When memory_recall is enabled, relevant memories should be prepended to conversation context automatically (AC-9)
**Plan reference:** src/host/memory-recall.ts, src/agent/prompt/modules/memory-recall.ts

**Verification steps:**
1. Read `src/host/memory-recall.ts` and verify:
   a. `recallMemoryForMessage()` exists and performs embedding-based or keyword search
   b. Results are formatted as context turn pairs prepended to conversation
   c. userId scoping respects DM vs channel context
2. Read `src/agent/prompt/modules/memory-recall.ts` and verify the prompt teaches agent about memory usage

**Expected outcome:**
- [ ] Memory recall function searches by embedding (preferred) or keyword (fallback)
- [ ] Matching memories formatted as turn pairs in conversation history
- [ ] userId scoping applied in DM context

**Pass/Fail:** _pending_

---

### ST-8: Channel handler pipeline includes session tracking and delivery wiring

**Criterion:** The channel handler must track sessions for delivery and wire heartbeat responses to channels (AC-5, AC-6, AC-13)
**Plan reference:** src/host/server-channels.ts, src/host/server.ts

**Verification steps:**
1. Read `src/host/server-channels.ts` and verify the full pipeline:
   a. shouldRespond() → deduplicate → thread gating → thread backfill → bootstrap gate
   b. addReaction('eyes') → router.processInbound → processCompletion → send → removeReaction
   c. sessionStore.trackSession() called after successful send
2. Read `src/host/server.ts` scheduler callback and verify:
   a. processCompletion() called for heartbeat/cron messages
   b. resolveDelivery() determines target channel
   c. channel.send() dispatches notification

**Expected outcome:**
- [ ] Channel handler has complete 12-step pipeline
- [ ] Session tracked after each successful channel response
- [ ] Scheduler callback routes through completion → delivery → channel send

**Pass/Fail:** _pending_

---

## Behavioral Tests

### BT-1: Agent responds to a Slack DM with conversational reply

**Criterion:** A message sent via Slack DM should route to the agent and produce a meaningful response (AC-2, AC-3)
**Plan reference:** Slack channel provider, server-channels.ts

**Setup:**
- AX server running with Slack channel configured
- SLACK_BOT_TOKEN and SLACK_APP_TOKEN set
- Test Slack workspace with a DM to the bot

**Chat script:**
1. Send (via Slack DM): `Hello, I'm testing AX. Can you confirm you're receiving this?`
   Expected behavior: Agent acknowledges the message and responds conversationally
   Structural check: Audit log contains an entry for the inbound Slack message with scope=dm

**Expected outcome:**
- [ ] Agent response appears in Slack DM within 60 seconds
- [ ] Response is conversational and acknowledges the message
- [ ] Audit log records the interaction

**Pass/Fail:** _pending_

---

### BT-2: Agent stores a user preference in memory during Slack conversation

**Criterion:** When a user states a preference in Slack, the agent should use the memory tool to store it (AC-7, AC-14)
**Plan reference:** Memory cortex, memory-recall prompt module

**Setup:**
- AX server running with Slack channel and memory provider (cortex)
- Fresh session (no prior memories)

**Chat script:**
1. Send (via Slack DM): `I always prefer morning meetings before 10am. Please remember this.`
   Expected behavior: Agent acknowledges and calls memory({ type: 'write' }) to store the preference
   Structural check: Memory DB contains an entry about morning meeting preference

2. Send (via Slack DM): `What are my preferences that you remember?`
   Expected behavior: Agent uses memory({ type: 'query' }) or memory({ type: 'list' }) and mentions the morning meeting preference
   Structural check: Memory query IPC action logged in audit

**Expected outcome:**
- [ ] Agent stores preference using memory tool (verified in memory DB)
- [ ] Agent can recall the preference when asked in same session
- [ ] Memory entry has correct userId (DM-scoped)

**Pass/Fail:** _pending_

---

### BT-3: Agent recalls a memory from a previous session via Slack

**Criterion:** Memories persist across sessions and are automatically recalled or queryable (AC-8, AC-9)
**Plan reference:** Memory cortex, memory-recall.ts

**Setup:**
- AX server running with Slack channel and memory provider
- BT-2 must have completed (memory already stored)
- Use a NEW session ID (different from BT-2)

**Chat script:**
1. Send (via Slack DM, new session): `When do I prefer to have meetings?`
   Expected behavior: Agent recalls the morning meeting preference (either via auto-recall injection or by querying memory)
   Structural check: Either memory_recall injected prior context OR agent called memory({ type: 'query' })

**Expected outcome:**
- [ ] Agent correctly states the user prefers morning meetings before 10am
- [ ] Memory was either auto-recalled or explicitly queried
- [ ] Cross-session persistence confirmed

**Pass/Fail:** _pending_

---

### BT-4: Agent lists and reads a skill when asked via Slack

**Criterion:** User can ask the agent to find and read skills through Slack conversation (AC-10)
**Plan reference:** Skills provider, skills prompt module

**Setup:**
- AX server running with Slack channel and skills provider (git)
- At least one test skill installed in agent skills directory (e.g., `weekly-report.md`)
- Test skill content:
  ```markdown
  # Weekly Report
  ---
  name: weekly-report
  description: Generate a weekly status summary
  ---

  When asked to generate a weekly report:
  1. Summarize what was accomplished this week
  2. List any blockers or issues
  3. Outline priorities for next week

  Format the report with clear headers and bullet points.
  ```

**Chat script:**
1. Send (via Slack DM): `What skills do you have available?`
   Expected behavior: Agent calls skill({ type: 'list' }) and reports available skills including weekly-report
   Structural check: skill_list IPC action in audit log

2. Send (via Slack DM): `Read the weekly-report skill and tell me what it does`
   Expected behavior: Agent calls skill({ type: 'read', name: 'weekly-report' }) and summarizes it
   Structural check: skill_read IPC action with name='weekly-report' in audit log

**Expected outcome:**
- [ ] Agent lists available skills including weekly-report
- [ ] Agent reads and accurately summarizes the weekly-report skill
- [ ] Both skill_list and skill_read IPC actions logged

**Pass/Fail:** _pending_

---

### BT-5: Agent executes a skill's instructions when asked via Slack

**Criterion:** User can trigger skill execution through Slack and receive formatted results (AC-11)
**Plan reference:** Skills provider, agent runners

**Setup:**
- AX server running with Slack channel and skills provider
- weekly-report skill installed (from BT-4 setup)

**Chat script:**
1. Send (via Slack DM): `Run the weekly report skill for me. This week I fixed a login bug, updated the API docs, and started the new dashboard feature. No blockers.`
   Expected behavior: Agent reads the skill, follows its instructions, and generates a formatted weekly report in Slack
   Structural check: skill_read IPC action followed by a well-formatted response in Slack

**Expected outcome:**
- [ ] Agent reads the skill before executing
- [ ] Response contains clear headers and bullet points (matching skill format guidance)
- [ ] Report includes the three accomplishments and no-blockers status
- [ ] Response appears in Slack DM with reasonable formatting

**Pass/Fail:** _pending_

---

### BT-6: Heartbeat fires and delivers notification to Slack

**Criterion:** When heartbeat fires, agent evaluates HEARTBEAT.md and sends proactive notification to last Slack session (AC-4, AC-5, AC-6)
**Plan reference:** Scheduler provider, delivery.ts, server.ts

**Setup:**
- AX server running with Slack channel, scheduler (plainjob), and memory provider
- HEARTBEAT.md installed with a check that's always actionable:
  ```markdown
  ## Checks

  - **greeting** (every 1m): Send a brief greeting to the user confirming the heartbeat system is working
  ```
- `heartbeat_interval_min` set to 1 (for testing — fire every minute)
- `defaultDelivery` configured as `{ mode: 'channel', target: 'last' }`
- A Slack DM session must have been established first (so 'last' resolves)

**Chat script:**
1. Send (via Slack DM): `Hello, I'm here. Please confirm when your next heartbeat fires.`
   Expected behavior: Agent responds, establishing the session as the "last" channel session

2. Wait up to 2 minutes for heartbeat to fire
   Expected behavior: Agent proactively sends a greeting message to Slack DM (without user prompting)
   Structural check: Audit log contains heartbeat trigger + delivery to Slack session

**Expected outcome:**
- [ ] Heartbeat fires within 2 minutes
- [ ] Agent sends a proactive greeting to Slack DM
- [ ] Notification arrives without user prompting (truly proactive)
- [ ] Audit log confirms heartbeat trigger and channel delivery

**Pass/Fail:** _pending_

---

## Integration Tests

### IT-1: Memory persistence + cross-session recall via Slack

**Criterion:** Full memory lifecycle: store in one Slack session, recall in another, with userId isolation (AC-7, AC-8, AC-9, AC-14)
**Plan reference:** Memory cortex, memory-recall.ts, Slack channel

**Setup:**
- AX server running with Slack channel and memory provider
- Session ID: `acceptance:openclaw-switcher:it1-store`
- Second session ID: `acceptance:openclaw-switcher:it1-recall`

**Sequence:**
1. [Store preference]
   Action: Send via Slack DM (session it1-store): `I'm a backend engineer who works primarily in TypeScript and Go. Remember this about me.`
   Verify: Memory DB contains entry about backend engineer + TypeScript + Go with correct userId

2. [Store another preference]
   Action: Send via Slack DM (session it1-store): `I prefer dark mode in all my tools and I use vim keybindings. Please remember these preferences.`
   Verify: Memory DB contains entries about dark mode and vim keybindings

3. [New session — recall]
   Action: Send via Slack DM (session it1-recall): `What do you know about my development setup and preferences?`
   Verify: Agent mentions TypeScript, Go, dark mode, and vim keybindings (from memory recall or explicit query)

4. [Verify userId isolation]
   Action: Query memory DB directly — all entries should have the Slack user's userId
   Verify: No entries exist without userId (confirming DM scoping)

**Expected final state:**
- [ ] At least 3 memory entries stored with correct userId
- [ ] Cross-session recall works (agent references stored facts)
- [ ] All entries userId-scoped (DM isolation)

**Pass/Fail:** _pending_

---

### IT-2: Skill discovery + execution + memory storage via Slack

**Criterion:** User asks about skills, executes one, and the result/context is remembered (AC-7, AC-10, AC-11)
**Plan reference:** Skills provider, memory cortex, Slack channel

**Setup:**
- AX server running with Slack channel, skills provider, and memory provider
- Test skill `code-review-checklist` installed:
  ```markdown
  # Code Review Checklist
  ---
  name: code-review-checklist
  description: Generate a code review checklist for a PR
  ---

  When asked to create a code review checklist:
  1. Ask what language/framework the PR is in (or use known preferences)
  2. Generate a checklist covering: correctness, security, performance, readability, tests
  3. Tailor the checklist to the language/framework

  Always include these universal checks:
  - [ ] No hardcoded secrets or credentials
  - [ ] Error handling covers edge cases
  - [ ] Tests cover the happy path and at least one failure case
  ```
- Session ID: `acceptance:openclaw-switcher:it2`

**Sequence:**
1. [Discover skills]
   Action: Send via Slack DM: `What skills do you have?`
   Verify: Agent lists skills including code-review-checklist

2. [Execute skill with memory context]
   Action: Send via Slack DM: `Use the code review checklist skill to create a checklist for a TypeScript API endpoint PR`
   Verify: Agent reads skill, generates checklist tailored to TypeScript, includes universal checks

3. [Verify agent remembers context]
   Action: Send via Slack DM: `Remember that I just did a code review for the TypeScript API endpoint PR`
   Verify: Agent stores this in memory

4. [Verify recall in same session]
   Action: Send via Slack DM: `What was the last thing I was working on?`
   Verify: Agent mentions the TypeScript API endpoint code review

**Expected final state:**
- [ ] Skills listed successfully
- [ ] Code review checklist generated with TypeScript-specific items
- [ ] Universal checks present in output
- [ ] Memory entry created about the code review
- [ ] Agent recalls code review context when asked

**Pass/Fail:** _pending_

---

### IT-3: End-to-end OpenClaw switcher flow — chat + memory + heartbeat + Slack delivery

**Criterion:** The complete flow an OpenClaw user expects: chat via Slack, agent remembers, heartbeat fires, agent proactively notifies in Slack referencing a memory (AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-13, AC-15)
**Plan reference:** All subsystems

**Setup:**
- AX server running with Slack channel, memory provider, scheduler (plainjob), and skills provider
- HEARTBEAT.md installed:
  ```markdown
  ## Checks

  - **task-reminder** (every 1m): Check if the user mentioned any upcoming tasks or deadlines. If so, send a brief reminder about the most urgent one.
  ```
- `heartbeat_interval_min`: 1
- `defaultDelivery`: `{ mode: 'channel', target: 'last' }`
- Session ID: `acceptance:openclaw-switcher:it3`

**Sequence:**
1. [Establish Slack session + store a task]
   Action: Send via Slack DM: `I have a deployment scheduled for tomorrow at 3pm. It's critical — the client demo depends on it. Please remember this.`
   Verify: Agent acknowledges and stores in memory (deployment + tomorrow 3pm + critical)

2. [Verify memory stored]
   Action: Query memory DB directly for entries about "deployment" or "3pm"
   Verify: Entry exists with correct content and userId

3. [Wait for heartbeat]
   Action: Wait up to 2 minutes for heartbeat to fire
   Verify: Agent evaluates HEARTBEAT.md task-reminder check

4. [Verify proactive Slack notification]
   Action: Check Slack DM for an unprompted message from the agent
   Verify: Agent sends a reminder about the deployment (referencing stored memory)

5. [Confirm notification references the memory]
   Action: Read the proactive Slack message
   Verify: Message mentions deployment, tomorrow, 3pm, or the critical nature of the task

**Expected final state:**
- [ ] Memory stored about deployment task
- [ ] Heartbeat fired and evaluated task-reminder check
- [ ] Proactive notification delivered to Slack DM without user prompting
- [ ] Notification content references the stored deployment task
- [ ] Full loop complete: user input → memory → heartbeat → Slack delivery

**Pass/Fail:** _pending_
