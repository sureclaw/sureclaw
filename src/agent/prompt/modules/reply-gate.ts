// src/agent/prompt/modules/reply-gate.ts
import type { PromptContext, PromptModule } from '../types.js';

/**
 * When the host signals that a reply is optional (non-mention messages in DMs,
 * groups, or threads the bot is participating in), this module instructs the
 * agent that it may choose to stay silent.
 */
export class ReplyGateModule implements PromptModule {
  readonly name = 'reply-gate';
  readonly priority = 95;  // near end, after runtime
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    return ctx.replyOptional === true;
  }

  render(_ctx: PromptContext): string[] {
    return [
      '<reply-gate>',
      'You may choose not to reply to this message. You were NOT directly @mentioned.',
      'Reply ONLY if:',
      '- The message seems directly addressed to you (by name or role)',
      '- You are asked a question or for help',
      '- The message references something you said earlier',
      '- You have genuinely useful information to contribute',
      '',
      'Stay SILENT (respond with exactly an empty message) if:',
      '- The message is an acknowledgment ("ok", "thanks", "got it")',
      '- It is a side conversation between other people',
      '- The message is clearly directed at someone else',
      '- It is an emotional reaction ("lol", "wow", "nice", emoji-only)',
      '- You would just be echoing or restating what was already said',
      '',
      'When in doubt, stay silent. Only speak when you add real value.',
      'To stay silent, output nothing (empty response).',
      '</reply-gate>',
    ];
  }

  estimateTokens(_ctx: PromptContext): number {
    return 200;
  }
}
