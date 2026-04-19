import { z } from 'zod';

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

// Hostname per RFC 1035 (labels 1-63 chars, total <=253), no scheme, no path.
// Rejects "not a host", "api.linear.app/path", "HTTPS://example.com", etc.
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// Wildcard hostname: exactly one leading `*.` followed by a normal multi-label
// hostname. Matches the TLS RFC 6125 / browser convention — `*` replaces
// exactly one label at the leftmost position, and the parent still requires
// at least two labels (so `*.com` is rejected as too broad). Used for
// multi-tenant vendors like Salesforce where org-specific subdomains aren't
// knowable up front but should all route to the same parent.
const WILDCARD_HOSTNAME_RE =
  /^\*\.(?=.{1,251}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

const Hostname = z
  .string()
  .min(1)
  .max(253)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => HOSTNAME_RE.test(s) || WILDCARD_HOSTNAME_RE.test(s), {
    message: 'must be a valid hostname or *.wildcard pattern (no scheme, no path)',
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

/** Infer transport from URL path convention: any URL ending in `/sse`
 *  (optionally followed by more path) is the legacy SSE endpoint;
 *  everything else (typically `/mcp`) is Streamable HTTP. Used when the
 *  skill author omits the explicit `transport` field — catches the
 *  common agent-authored pattern where the URL was copied from vendor
 *  docs (e.g., `https://mcp.linear.app/sse`) but the transport field
 *  was left off. An explicit `transport:` in the frontmatter always wins. */
function inferTransportFromUrl(url: string): 'http' | 'sse' {
  try {
    const { pathname } = new URL(url);
    // Match `/sse`, `/sse/`, or `/sse/<anything>` at the path root or nested.
    return /(?:^|\/)sse(?:\/|$)/.test(pathname) ? 'sse' : 'http';
  } catch {
    return 'http';
  }
}

const McpServerSchema = z
  .object({
    name: z.string().min(1).max(100),
    url: z.string().url().startsWith('https://'),
    // `credential` is a STRING reference to an entry in the top-level
    // `credentials:` array — the envName that the host should inject as a
    // Bearer token on this MCP server's calls. Agent-authored skills
    // sometimes mimic the Claude-Desktop config shape and nest a full
    // `{envName, authType, scope}` object here; this custom message catches
    // the mistake with a pointer to the right shape instead of the opaque
    // default "expected string, received object."
    credential: z
      .string({
        error: () =>
          'mcpServers[].credential must be a string envName (e.g. "LINEAR_API_KEY") — a reference to an entry in the top-level credentials[] array. Do NOT nest a {envName, authType, scope} object here; define the credential once in credentials[] and reference its envName as a string.',
      })
      .regex(ENV_NAME)
      .optional(),
    /** Wire protocol the server speaks. `http` is the newer MCP transport
     *  (POST-based, bi-directional via optional SSE streams — what the MCP
     *  spec calls "Streamable HTTP"). `sse` is the legacy transport (GET
     *  for server→client events, POST to a session endpoint for
     *  client→server). Some vendors (e.g., Linear at `mcp.linear.app/sse`)
     *  only speak SSE. When unset, AX infers from the URL path (`/sse`
     *  → sse, else http) so agent-authored skills whose URL was copied
     *  from vendor docs without an explicit transport field still work. */
    transport: z.enum(['http', 'sse']).optional(),
  })
  .strict()
  .transform((s) => ({
    ...s,
    transport: s.transport ?? inferTransportFromUrl(s.url),
  }));

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
