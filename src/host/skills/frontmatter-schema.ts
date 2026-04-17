import { z } from 'zod';

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

// Hostname per RFC 1035 (labels 1-63 chars, total <=253), no scheme, no path.
// Rejects "not a host", "api.linear.app/path", "HTTPS://example.com", etc.
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

const Hostname = z
  .string()
  .min(1)
  .max(253)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => HOSTNAME_RE.test(s), {
    message: 'must be a valid hostname (no scheme, no path)',
  });

const OAuthBlockSchema = z
  .object({
    provider: z.string().min(1).max(100),
    clientId: z.string().min(1).max(500),
    authorizationUrl: z.string().url().startsWith('https://'),
    tokenUrl: z.string().url().startsWith('https://'),
    scopes: z.array(z.string().min(1)).default([]),
  })
  .strict();

const CredentialSchema = z
  .object({
    envName: z.string().regex(ENV_NAME),
    authType: z.enum(['api_key', 'oauth']).default('api_key'),
    scope: z.enum(['user', 'agent']).default('user'),
    oauth: OAuthBlockSchema.optional(),
  })
  .strict()
  .refine(
    (c) => c.authType !== 'oauth' || c.oauth !== undefined,
    { message: 'oauth authType requires an oauth block' },
  );

const McpServerSchema = z
  .object({
    name: z.string().min(1).max(100),
    url: z.string().url().startsWith('https://'),
    credential: z.string().regex(ENV_NAME).optional(),
  })
  .strict();

const SourceSchema = z
  .object({
    url: z.string().url(),
    version: z.string().min(1).max(200).optional(),
  })
  .strict();

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
    source: SourceSchema.optional(),
    credentials: z.array(CredentialSchema).default([]),
    mcpServers: z.array(McpServerSchema).default([]),
    domains: z.array(Hostname).default([]),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
export type SkillCredential = z.infer<typeof CredentialSchema>;
export type SkillMcpServer = z.infer<typeof McpServerSchema>;
