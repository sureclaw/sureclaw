import { describe, test, expect, afterEach } from 'vitest';
import { rmSync, readFileSync } from 'node:fs';

describe('collectSkillEnvRequirements', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
    dirs.length = 0;
  });

  test('source handles both file-based and directory-based skills', () => {
    // Verify the implementation pattern in server-completions.ts
    const source = readFileSync(
      new URL('../../src/host/server-completions.ts', import.meta.url), 'utf-8',
    );
    // Must use withFileTypes to distinguish files from directories
    expect(source).toContain("readdirSync(dir, { withFileTypes: true })");
    // Must check for directory-based skills (SKILL.md inside subdirectory)
    expect(source).toContain("entry.isDirectory()");
    expect(source).toContain("SKILL.md");
    // Must handle OAuth requirements
    expect(source).toContain("requires.oauth");
    expect(source).toContain("oauth.required");
  });

  test('parseAgentSkill extracts requires.oauth from skill frontmatter', async () => {
    const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');

    const skill = `---
name: linear-bot
metadata:
  openclaw:
    requires:
      env:
        - SLACK_TOKEN
      oauth:
        - name: LINEAR_API_KEY
          authorize_url: https://linear.app/oauth/authorize
          token_url: https://linear.app/oauth/token
          scopes:
            - read
            - write
          client_id: abc123
          client_secret_env: LINEAR_OAUTH_CLIENT_SECRET
---
Linear integration.`;

    const parsed = parseAgentSkill(skill);
    expect(parsed.requires.oauth).toHaveLength(1);
    expect(parsed.requires.oauth![0]).toEqual({
      name: 'LINEAR_API_KEY',
      authorize_url: 'https://linear.app/oauth/authorize',
      token_url: 'https://linear.app/oauth/token',
      scopes: ['read', 'write'],
      client_id: 'abc123',
      client_secret_env: 'LINEAR_OAUTH_CLIENT_SECRET',
    });
    // Plain env still parsed
    expect(parsed.requires.env).toContain('SLACK_TOKEN');
  });

  test('parseAgentSkill returns empty oauth array when not declared', async () => {
    const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');

    const skill = `---
name: simple
metadata:
  openclaw:
    requires:
      env:
        - API_KEY
---
Simple skill.`;

    const parsed = parseAgentSkill(skill);
    expect(parsed.requires.oauth).toEqual([]);
  });

  test('parseAgentSkill handles oauth without client_secret_env (PKCE-only)', async () => {
    const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');

    const skill = `---
name: github-bot
metadata:
  openclaw:
    requires:
      oauth:
        - name: GITHUB_TOKEN
          authorize_url: https://github.com/login/oauth/authorize
          token_url: https://github.com/login/oauth/access_token
          scopes: [repo, user]
          client_id: gh-client-123
---
GitHub integration.`;

    const parsed = parseAgentSkill(skill);
    expect(parsed.requires.oauth).toHaveLength(1);
    expect(parsed.requires.oauth![0].client_secret_env).toBeUndefined();
    expect(parsed.requires.oauth![0].client_id).toBe('gh-client-123');
  });

  test('parseAgentSkill extracts requires.env from both skill formats', async () => {
    const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');

    // File-based skill with metadata.openclaw.requires.env
    const fileSkill = `---
name: linear-bot
metadata:
  openclaw:
    requires:
      env:
        - LINEAR_API_KEY
---
Linear integration skill.`;

    const parsed = parseAgentSkill(fileSkill);
    expect(parsed.requires.env).toContain('LINEAR_API_KEY');

    // Same format works from directory-based SKILL.md
    const dirSkill = `---
name: deploy
metadata:
  openclaw:
    requires:
      env:
        - GITHUB_TOKEN
        - AWS_ACCESS_KEY_ID
---
Deploy skill.`;

    const parsed2 = parseAgentSkill(dirSkill);
    expect(parsed2.requires.env).toContain('GITHUB_TOKEN');
    expect(parsed2.requires.env).toContain('AWS_ACCESS_KEY_ID');
  });
});
