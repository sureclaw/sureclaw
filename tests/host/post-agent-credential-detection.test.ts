/**
 * Tests for post-agent credential detection logic.
 *
 * Verifies that `parseAgentSkill` correctly surfaces `requires.env` entries
 * from SKILL.md frontmatter. The host uses this to prompt for credentials
 * after a skill is added to `.ax/skills/`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('collectSkillCredentialRequirements detects requires.env', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `ax-test-skills-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('detects requires.env from SKILL.md frontmatter', async () => {
    // Create a skill directory with proper frontmatter (metadata.openclaw.requires.env format)
    const skillDir = join(testDir, 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    const raw = `---
name: My Skill
metadata:
  openclaw:
    requires:
      env:
        - MY_API_KEY
        - MY_SECRET
---

# My Skill
Does stuff.
`;
    writeFileSync(join(skillDir, 'SKILL.md'), raw);

    const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');
    const parsed = parseAgentSkill(raw);
    expect(parsed.requires.env).toContain('MY_API_KEY');
    expect(parsed.requires.env).toContain('MY_SECRET');
  });

  test('missing requires.env returns empty array', async () => {
    const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');
    const raw = `# My Skill\nDoes stuff.\n`;
    const parsed = parseAgentSkill(raw);
    expect(parsed.requires.env).toEqual([]);
  });
});
