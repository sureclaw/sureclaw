import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z, ZodError } from 'zod';
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
  }).optional(),
  profile: z.enum(PROFILE_NAMES),
  providers: z.strictObject({
    memory: providerEnum('memory'),
    security: providerEnum('security'),
    channels: z.array(providerEnum('channel')),
    web: z.strictObject({
      extract: providerEnum('web_extract'),
      search: providerEnum('web_search'),
    }),
    credentials: z.union([providerEnum('credentials'), z.literal('env')])
      .transform((val) => {
        if (val === 'env') {
          // eslint-disable-next-line no-console
          console.warn('[ax] Deprecation: credentials: "env" is no longer supported. Remapping to "keychain".');
          return 'keychain' as const;
        }
        return val;
      }),
    skills: z.string().optional(), // deprecated — skills are now filesystem-based
    audit: providerEnum('audit'),
    sandbox: providerEnum('sandbox'),
    scheduler: providerEnum('scheduler'),
    database: providerEnum('database').optional().default('sqlite'),
    storage: providerEnum('storage').optional().default('database'),
    eventbus: providerEnum('eventbus').optional().default('inprocess'),
    mcp: providerEnum('mcp').optional(),
    auth: z.array(providerEnum('auth')).optional(),
    workspace: providerEnum('workspace').optional(),
  }),
  channel_config: z.record(z.string(), ChannelAccessConfigSchema).optional(),
  max_tokens: z.number().int().min(256).max(200_000).optional().default(8192),
  sandbox: z.strictObject({
    timeout_sec: z.number().int().min(1).max(3600),
    idle_timeout_sec: z.number().int().min(60).max(7200).optional(),
    clean_idle_timeout_sec: z.number().int().min(60).max(7200).optional(),
    memory_mb: z.number().int().min(64).max(8192),
    tiers: z.strictObject({
      default: z.strictObject({
        memory_mb: z.number().int().min(64).max(8192).default(256),
        cpus: z.number().min(0.5).max(16).default(1),
      }).default({ memory_mb: 256, cpus: 1 }),
      heavy: z.strictObject({
        memory_mb: z.number().int().min(64).max(8192).default(2048),
        cpus: z.number().min(0.5).max(16).default(4),
      }).default({ memory_mb: 2048, cpus: 4 }),
    }).optional(),
  }),
  scheduler: z.strictObject({
    active_hours: z.strictObject({
      start: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
      end: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
      timezone: z.string(),
    }),
    max_token_budget: z.number().int().min(1),
    heartbeat_interval_min: z.number().int().min(1),
    timeout_sec: z.number().int().min(1).max(3600).optional(),
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
    embedding_model: z.string().default('text-embedding-3-small'),
    embedding_dimensions: z.number().int().min(64).max(4096).default(1536),
  }).default({ max_turns: 50, thread_context_turns: 5, summarize: false, summarize_threshold: 40, summarize_keep_recent: 10, memory_recall: false, memory_recall_limit: 5, memory_recall_scope: '*', embedding_model: 'text-embedding-3-small', embedding_dimensions: 1536 }),
  delegation: z.strictObject({
    max_concurrent: z.number().int().min(1).max(10).default(3),
    max_depth: z.number().int().min(1).max(5).default(2),
  }).optional(),
  webhooks: z.strictObject({
    enabled: z.boolean(),
    token: z.string().min(1),
    path: z.string().optional(),
    max_body_bytes: z.number().int().positive().optional(),
    model: z.string().optional(),
    allowed_agent_ids: z.array(z.string().min(1)).optional(),
  }).optional(),
  admin: z.strictObject({
    enabled: z.boolean().default(true),
    token: z.string().optional(),
    port: z.number().int().min(1).max(65535).default(8080),
    disable_auth: z.boolean().optional(),
  }).default({ enabled: true, port: 8080 }),
  auth: z.strictObject({
    better_auth: z.strictObject({
      google: z.strictObject({
        client_id: z.string().min(1),
        client_secret: z.string().min(1),
      }).optional(),
      allowed_domains: z.array(z.string().min(1)).optional(),
    }).optional(),
  }).optional(),
  gitServer: z.strictObject({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    httpPort: z.number().int().min(1).max(65535).default(8000).optional(),
    user: z.string().min(1).default('git'),
    repoBasePath: z.string().min(1).default('/var/git/repos'),
  }).optional(),
  gcs: z.strictObject({
    bucket: z.string().min(1),
    prefix: z.string().default(''),
  }).optional(),
  web_proxy: z.boolean().optional(),
  namespace: z.string().optional(),
  url_rewrites: z.record(z.string(), z.string()).optional(),
  plugins: z.array(z.strictObject({
    source: z.string().min(1).max(1000),
    agents: z.array(z.string().min(1).max(100)).min(1),
  })).optional(),
  shared_agents: z.array(z.strictObject({
    id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
    display_name: z.string().min(1).max(200),
    agent: z.enum(['pi-coding-agent', 'claude-code']).optional(),
    models: z.strictObject({
      default: z.array(z.string()).optional(),
      fast: z.array(z.string()).optional(),
      thinking: z.array(z.string()).optional(),
      coding: z.array(z.string()).optional(),
    }).optional(),
    slack_bot_token_env: z.string().min(1).optional(),
    slack_app_token_env: z.string().min(1).optional(),
    admins: z.array(z.string().min(1)).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    description: z.string().optional(),
  })).optional(),
});

/**
 * Dig into a parsed config object using a Zod issue path to find
 * the value the user actually wrote.
 */
function getValueAtPath(obj: unknown, path: PropertyKey[]): unknown {
  let cur = obj;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[String(seg)];
  }
  return cur;
}

/**
 * Format a ZodError into a human-readable config error message.
 *
 * Instead of dumping raw JSON, we produce one clear line per issue
 * with the config path, what's wrong, and how to fix it.
 */
function formatConfigError(err: ZodError, configPath: string, parsed: unknown): string {
  const lines: string[] = [`Configuration error in ${configPath}:\n`];

  for (const issue of err.issues) {
    const path = issue.path.join('.');

    if (issue.code === 'invalid_value') {
      const received = getValueAtPath(parsed, issue.path);
      const options = (issue as unknown as { values: string[] }).values
        .map((o: string) => `"${o}"`).join(', ');
      lines.push(`  ${path}: "${String(received)}" is not a valid option`);
      lines.push(`    Valid values: ${options}`);
    } else if (issue.code === 'unrecognized_keys') {
      const keys = (issue as unknown as { keys: string[] }).keys.join(', ');
      lines.push(`  ${path}: unknown field(s): ${keys}`);
      lines.push(`    Remove or rename these fields`);
    } else if (issue.code === 'invalid_type') {
      const received = getValueAtPath(parsed, issue.path);
      lines.push(`  ${path}: expected ${issue.expected}, got ${typeof received} (${JSON.stringify(received)})`);
    } else {
      lines.push(`  ${path}: ${issue.message}`);
    }
  }

  lines.push('');
  lines.push(`Edit your config: ${configPath}`);
  return lines.join('\n');
}

export function loadConfig(path?: string): Config {
  const configPath = resolve(path ?? defaultConfigPath());
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  try {
    // The Zod schema enforces the same provider-name constraints at runtime,
    // but providerEnum() builds enums from PROVIDER_MAP's loosely-typed keys
    // so TypeScript can't narrow the output to the literal union types Config
    // expects.  The assertion is safe — invalid names are caught by parse().
    const config = ConfigSchema.parse(parsed) as unknown as Config;

    // Container sandboxes have no outbound network and no OS keychain.
    // Default web_proxy to true (needed for HTTP access, credential injection,
    // and skill installs) and credentials to database (keychain falls back to
    // ephemeral plaintext files that are lost on pod restart).
    const containerSandboxes = new Set(['docker', 'apple', 'k8s']);
    if (containerSandboxes.has(config.providers.sandbox)) {
      if (config.web_proxy === undefined) {
        (config as { web_proxy: boolean }).web_proxy = true;
      }
      if (config.providers.credentials === 'keychain') {
        (config.providers as { credentials: string }).credentials = 'database';
      }
    }

    return config;
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(formatConfigError(err, configPath, parsed));
    }
    throw err;
  }
}
