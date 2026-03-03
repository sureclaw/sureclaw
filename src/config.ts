import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Config } from './types.js';
import { configPath as defaultConfigPath } from './paths.js';
import { PROFILE_NAMES } from './onboarding/prompts.js';
import { PROVIDER_MAP } from './host/provider-map.js';

const AGENT_TYPES = ['pi-coding-agent', 'claude-code'] as const;

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
  agent: z.enum(AGENT_TYPES).optional().default('pi-coding-agent'),
  models: z.strictObject({
    default: z.array(z.string().min(1)).min(1).optional(),
    fast: z.array(z.string().min(1)).min(1).optional(),
    thinking: z.array(z.string().min(1)).min(1).optional(),
    coding: z.array(z.string().min(1)).min(1).optional(),
    image: z.array(z.string().min(1)).min(1).optional(),
  }).optional(),
  profile: z.enum(PROFILE_NAMES),
  providers: z.strictObject({
    memory: providerEnum('memory'),
    scanner: providerEnum('scanner'),
    channels: z.array(providerEnum('channel')),
    web: providerEnum('web'),
    browser: providerEnum('browser'),
    credentials: z.union([providerEnum('credentials'), z.literal('env')])
      .transform((val) => {
        if (val === 'env') {
          // eslint-disable-next-line no-console
          console.warn('[ax] Deprecation: credentials: "env" is no longer supported. Remapping to "keychain".');
          return 'keychain' as const;
        }
        return val;
      }),
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
    summarize: z.boolean().default(false),
    summarize_threshold: z.number().int().min(10).max(10000).default(40),
    summarize_keep_recent: z.number().int().min(4).max(100).default(10),
    memory_recall: z.boolean().default(false),
    memory_recall_limit: z.number().int().min(1).max(20).default(5),
    memory_recall_scope: z.string().default('*'),
  }).default({ max_turns: 50, thread_context_turns: 5, summarize: false, summarize_threshold: 40, summarize_keep_recent: 10, memory_recall: false, memory_recall_limit: 5, memory_recall_scope: '*' }),
  delegation: z.strictObject({
    max_concurrent: z.number().int().min(1).max(10).default(3),
    max_depth: z.number().int().min(1).max(5).default(2),
  }).optional(),
});

export function loadConfig(path?: string): Config {
  const configPath = resolve(path ?? defaultConfigPath());
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  // The Zod schema enforces the same provider-name constraints at runtime,
  // but providerEnum() builds enums from PROVIDER_MAP's loosely-typed keys
  // so TypeScript can't narrow the output to the literal union types Config
  // expects.  The assertion is safe — invalid names are caught by parse().
  return ConfigSchema.parse(parsed) as unknown as Config;
}
