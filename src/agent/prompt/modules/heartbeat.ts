// src/agent/prompt/modules/heartbeat.ts
import { BasePromptModule } from '../base-module.js';
import { isBootstrapMode } from '../types.js';
import type { PromptContext } from '../types.js';

/**
 * Heartbeat module: tells the agent how to use scheduler tools and,
 * when HEARTBEAT.md is present, how to handle heartbeat messages.
 * Priority 80 — after skills, before runtime. Always included (scheduling
 * tools are always available); heartbeat checklist is conditional.
 */
export class HeartbeatModule extends BasePromptModule {
  readonly name = 'heartbeat';
  readonly priority = 80;
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    if (isBootstrapMode(ctx)) return false;
    return true;
  }

  render(ctx: PromptContext): string[] {
    const lines: string[] = [];
    const hasHeartbeat = !!ctx.identityFiles.heartbeat?.trim();

    if (hasHeartbeat) {
      lines.push(
        '## Heartbeat & Scheduling',
        '',
        'You receive periodic **heartbeat** messages. When one arrives:',
        '1. Review the checklist below',
        '2. For each overdue item, take the appropriate action',
        '3. If nothing needs attention, respond with exactly: `HEARTBEAT_OK`',
        '',
        'If you take an action via a channel tool during the heartbeat (e.g. send a',
        'message, post a notification), respond with `SILENT_REPLY` instead of',
        '`HEARTBEAT_OK` to suppress duplicate output.',
        '',
        '### Your Heartbeat Checklist',
        '',
        ctx.identityFiles.heartbeat,
        '',
      );
    } else {
      lines.push('## Scheduling', '');
    }

    lines.push(
      '### Scheduling Tools',
      '',
      'You can manage scheduled tasks using the `scheduler` tool with a `type` parameter:',
      '- `scheduler({ type: "add_cron", ... })` — schedule a recurring task (5-field cron expression)',
      '- `scheduler({ type: "run_at", ... })` — schedule a **one-shot** task at a specific date/time (ISO 8601, local time, no Z suffix). Use the **Current Time** from your Runtime section to compute the correct datetime. You MUST call this tool to schedule one-time tasks — do not just say you scheduled it.',
      '- `scheduler({ type: "remove", ... })` — remove a scheduled task by ID',
      '- `scheduler({ type: "list", ... })` — list all your scheduled tasks',
      '',
      'Examples:',
      '- Recurring: `scheduler({ type: "add_cron", schedule: "0 9 * * 1-5", prompt: "Check and summarize new emails" })`',
      '- One-shot: `scheduler({ type: "run_at", datetime: "2026-02-21T19:30:00", prompt: "Remind user about the meeting" })`',
    );

    return lines;
  }

  renderMinimal(ctx: PromptContext): string[] {
    const lines: string[] = [];
    const hasHeartbeat = !!ctx.identityFiles.heartbeat?.trim();

    if (hasHeartbeat) {
      lines.push(
        '## Heartbeat & Scheduling',
        'On heartbeat messages: check the list, act on overdue items, respond HEARTBEAT_OK if nothing needed.',
        'If you act via a channel tool, respond SILENT_REPLY instead.',
        ctx.identityFiles.heartbeat,
      );
    } else {
      lines.push('## Scheduling');
    }

    lines.push(
      'Use `scheduler` tool: add_cron (recurring), run_at (one-shot), remove, list.',
    );

    return lines;
  }
}
