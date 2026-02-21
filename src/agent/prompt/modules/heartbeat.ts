// src/agent/prompt/modules/heartbeat.ts
import { BasePromptModule } from '../base-module.js';
import { isBootstrapMode } from '../types.js';
import type { PromptContext } from '../types.js';

/**
 * Heartbeat module: tells the agent how to handle heartbeat messages
 * and how to use scheduler tools. Priority 80 — after skills, before runtime.
 * Optional — only included when HEARTBEAT.md has content.
 */
export class HeartbeatModule extends BasePromptModule {
  readonly name = 'heartbeat';
  readonly priority = 80;
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    if (isBootstrapMode(ctx)) return false;
    return !!ctx.identityFiles.heartbeat?.trim();
  }

  render(ctx: PromptContext): string[] {
    return [
      '## Heartbeat & Scheduling',
      '',
      'You receive periodic **heartbeat** messages. When one arrives:',
      '1. Review the checklist below',
      '2. For each overdue item, take the appropriate action',
      '3. If nothing needs attention, respond with exactly: `HEARTBEAT_OK`',
      '',
      '### Your Heartbeat Checklist',
      '',
      ctx.identityFiles.heartbeat,
      '',
      '### Scheduling Tools',
      '',
      'You can manage scheduled tasks:',
      '- `scheduler_add_cron` — schedule a recurring task (5-field cron expression)',
      '- `scheduler_run_at` — schedule a **one-shot** task at a specific date/time (ISO 8601). You MUST call this tool to schedule one-time tasks — do not just say you scheduled it.',
      '- `scheduler_remove_cron` — remove a scheduled task by ID',
      '- `scheduler_list_jobs` — list all your scheduled tasks',
      '',
      'Examples:',
      '- Recurring: `scheduler_add_cron({ schedule: "0 9 * * 1-5", prompt: "Check and summarize new emails" })`',
      '- One-shot: `scheduler_run_at({ datetime: "2026-02-21T19:30:00", prompt: "Remind user about the meeting" })`',
    ];
  }

  renderMinimal(ctx: PromptContext): string[] {
    return [
      '## Heartbeat',
      'On heartbeat messages: check the list, act on overdue items, respond HEARTBEAT_OK if nothing needed.',
      ctx.identityFiles.heartbeat,
    ];
  }
}
