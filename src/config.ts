import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Config } from './types.js';
import { configPath as defaultConfigPath } from './paths.js';
import { PROFILE_NAMES } from './onboarding/prompts.js';
import { PROVIDER_MAP } from './host/provider-map.js';

const AGENT_TYPES = ['pi-agent-core', 'pi-coding-agent', 'claude-code'] as const;

// Derive Zod enums from PROVIDER_MAP keys for compile-time + runtime validation.
const providerEnum = (kind: string) => {
  const names = Object.keys(PROVIDER_MAP[kind] ?? {}) as [string, ...string[]];
  return z.enum(names);
};

const ChannelAccessConfigSchema = z.object({
  dm_policy: z.enum(['open', 'allowlist', 'disabled']).optional(),
  dmPolicy: z.enum(['open', 'allowlist', 'disabled']).optional(),
  allowed_users: z.array(z.string()).optional(),
  allowedUsers: z.array(z.string()).optional(),
  require_mention: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  mention_patterns: z.array(z.string()).optional(),
  mentionPatterns: z.array(z.string()).optional(),
  max_attachment_bytes: z.number().int().positive().optional(),
  maxAttachmentBytes: z.number().int().positive().optional(),
  allowed_mime_types: z.array(z.string()).optional(),
  allowedMimeTypes: z.array(z.string()).optional(),
});

const ConfigSchema = z.strictObject({
  agent: z.enum(AGENT_TYPES).optional().default('pi-agent-core'),
  model: z.string().optional(),
  model_fallbacks: z.array(z.string()).optional(),
  profile: z.enum(PROFILE_NAMES),
  providers: z.strictObject({
    memory: providerEnum('memory'),
    scanner: providerEnum('scanner'),
    channels: z.array(providerEnum('channel')),
    web: providerEnum('web'),
    browser: providerEnum('browser'),
    credentials: providerEnum('credentials'),
    skills: providerEnum('skills'),
    audit: providerEnum('audit'),
    sandbox: providerEnum('sandbox'),
    scheduler: providerEnum('scheduler'),
    skillScreener: z.string().optional(),
  }),
  channel_config: z.record(z.string(), ChannelAccessConfigSchema).optional(),
  max_tokens: z.number().int().min(256).max(200_000).optional().default(8192),
  sandbox: z.strictObject({
    timeout_sec: z.number().int().min(1).max(3600),
    memory_mb: z.number().int().min(64).max(8192),
  }),
  scheduler: z.strictObject({
    active_hours: z.strictObject({
      start: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
      end: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
      timezone: z.string(),
    }),
    max_token_budget: z.number().int().min(1),
    heartbeat_interval_min: z.number().int().min(1),
    agent_dir: z.string().optional(),
    defaultDelivery: z.strictObject({
      mode: z.enum(['channel', 'none']),
      target: z.union([
        z.literal('last'),
        z.strictObject({
          provider: z.string(),
          scope: z.enum(['dm', 'channel', 'thread', 'group']),
          identifiers: z.strictObject({
            workspace: z.string().optional(),
            channel: z.string().optional(),
            thread: z.string().optional(),
            peer: z.string().optional(),
          }),
        }),
      ]).optional(),
    }).optional(),
  }),
  history: z.strictObject({
    max_turns: z.number().int().min(0).max(10000).default(50),
    thread_context_turns: z.number().int().min(0).max(50).default(5),
  }).default({ max_turns: 50, thread_context_turns: 5 }),
});

export function loadConfig(path?: string): Config {
  const configPath = resolve(path ?? defaultConfigPath());
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  return ConfigSchema.parse(parsed);
}
