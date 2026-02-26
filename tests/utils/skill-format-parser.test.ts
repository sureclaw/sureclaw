import { describe, test, expect } from 'vitest';
import { parseAgentSkill } from '../../src/utils/skill-format-parser.js';

describe('skill-format-parser', () => {
  // ── Standard fields ───────────────────────────────

  describe('standard frontmatter', () => {
    test('parses name and description', () => {
      const skill = parseAgentSkill(`---
name: test-skill
description: A test skill
version: "1.0"
license: MIT
homepage: https://example.com
---
# Test Skill
Body content here.`);

      expect(skill.name).toBe('test-skill');
      expect(skill.description).toBe('A test skill');
      expect(skill.version).toBe('1.0');
      expect(skill.license).toBe('MIT');
      expect(skill.homepage).toBe('https://example.com');
    });

    test('handles missing frontmatter', () => {
      const skill = parseAgentSkill('# Just a markdown file\nNo frontmatter.');
      expect(skill.name).toBe('');
      expect(skill.description).toBeUndefined();
      expect(skill.body).toBe('# Just a markdown file\nNo frontmatter.');
    });
  });

  // ── metadata.openclaw ─────────────────────────────

  describe('metadata.openclaw', () => {
    test('extracts requires.bins and requires.env', () => {
      const skill = parseAgentSkill(`---
name: my-tool
metadata:
  openclaw:
    requires:
      bins:
        - my-tool
        - helper
      env:
        - MY_TOOL_API_KEY
---
# My Tool`);

      expect(skill.requires.bins).toEqual(['my-tool', 'helper']);
      expect(skill.requires.env).toEqual(['MY_TOOL_API_KEY']);
    });

    test('extracts install specs', () => {
      const skill = parseAgentSkill(`---
name: my-tool
metadata:
  openclaw:
    requires:
      bins: [my-tool]
    install:
      - kind: brew
        formula: my-org/tap/my-tool
        bins: [my-tool]
        label: Install my-tool (brew)
      - kind: node
        package: my-tool
        bins: [my-tool]
---
# My Tool`);

      expect(skill.install).toHaveLength(2);
      expect(skill.install[0].kind).toBe('brew');
      expect(skill.install[0].package).toBe('my-org/tap/my-tool');
      expect(skill.install[0].bins).toEqual(['my-tool']);
      expect(skill.install[0].label).toBe('Install my-tool (brew)');
      expect(skill.install[1].kind).toBe('node');
      expect(skill.install[1].package).toBe('my-tool');
    });

    test('extracts os constraints', () => {
      const skill = parseAgentSkill(`---
name: mac-only
metadata:
  openclaw:
    os: [macos]
---
# Mac Only`);

      expect(skill.os).toEqual(['macos']);
    });
  });

  // ── metadata.clawdbot alias ───────────────────────

  describe('metadata.clawdbot alias', () => {
    test('parses gog skill (brew install, clawdbot alias)', () => {
      const skill = parseAgentSkill(`---
name: gog
description: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.
homepage: https://gogcli.sh
metadata:
  clawdbot:
    emoji: 🎮
    requires:
      bins: [gog]
    install:
      - kind: brew
        formula: steipete/tap/gogcli
        bins: [gog]
---
# gog
Use \`gog\` to work with Google Workspace.`);

      expect(skill.name).toBe('gog');
      expect(skill.homepage).toBe('https://gogcli.sh');
      expect(skill.requires.bins).toEqual(['gog']);
      expect(skill.install).toHaveLength(1);
      expect(skill.install[0]).toEqual({
        kind: 'brew',
        package: 'steipete/tap/gogcli',
        bins: ['gog'],
        label: undefined,
        os: undefined,
      });
    });

    test('parses mcporter skill (node install, clawdbot alias)', () => {
      const skill = parseAgentSkill(`---
name: mcporter
description: Use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly.
homepage: http://mcporter.dev
metadata:
  clawdbot:
    requires:
      bins: [mcporter]
    install:
      - kind: node
        package: mcporter
        bins: [mcporter]
---
# mcporter
Use \`mcporter\` to work with MCP servers directly.`);

      expect(skill.name).toBe('mcporter');
      expect(skill.requires.bins).toEqual(['mcporter']);
      expect(skill.install[0]).toEqual({
        kind: 'node',
        package: 'mcporter',
        bins: ['mcporter'],
        label: undefined,
        os: undefined,
      });
    });
  });

  // ── Minimal frontmatter (no metadata block) ──────

  describe('minimal frontmatter', () => {
    test('parses nano-banana-pro (name + description only)', () => {
      const skill = parseAgentSkill(`---
name: nano-banana-pro
description: Generate/edit images with Nano Banana Pro (Gemini 3 Pro Image).
---
# Nano Banana Pro Image Generation

Generate new images or edit existing ones.

\`\`\`bash
uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py --prompt "your image description" --filename "output.png" --api-key KEY
\`\`\``);

      expect(skill.name).toBe('nano-banana-pro');
      expect(skill.requires.bins).toEqual([]);
      expect(skill.requires.env).toEqual([]);
      expect(skill.install).toEqual([]);
      expect(skill.codeBlocks).toHaveLength(1);
      expect(skill.codeBlocks[0]).toContain('uv run');
      expect(skill.codeBlocks[0]).toContain('generate_image.py');
    });
  });

  // ── Flat legacy fields ────────────────────────────

  describe('flat legacy fields', () => {
    test('parses permissions with mapping', () => {
      const skill = parseAgentSkill(`---
name: legacy-skill
permissions:
  - full-disk-access
  - web-access
tags:
  - productivity
  - automation
---
# Legacy`);

      expect(skill.permissions).toEqual(['workspace_write', 'web_fetch']);
      expect(skill.tags).toEqual(['productivity', 'automation']);
    });
  });

  // ── Code block extraction ─────────────────────────

  describe('code block extraction', () => {
    test('extracts multiple code blocks', () => {
      const skill = parseAgentSkill(`---
name: multi-block
---
# Skill

\`\`\`bash
echo "hello"
\`\`\`

Some text.

\`\`\`python
print("world")
\`\`\``);

      expect(skill.codeBlocks).toHaveLength(2);
      expect(skill.codeBlocks[0]).toContain('echo "hello"');
      expect(skill.codeBlocks[1]).toContain('print("world")');
    });

    test('handles no code blocks', () => {
      const skill = parseAgentSkill(`---
name: no-code
---
Just text, no code.`);
      expect(skill.codeBlocks).toEqual([]);
    });
  });

  // ── Edge cases ────────────────────────────────────

  describe('edge cases', () => {
    test('handles empty input', () => {
      const skill = parseAgentSkill('');
      expect(skill.name).toBe('');
      expect(skill.body).toBe('');
    });

    test('handles malformed YAML gracefully', () => {
      const skill = parseAgentSkill(`---
name: broken: yaml: [invalid
---
Body text.`);
      // Should not throw — falls back to empty frontmatter
      expect(skill.body).toContain('Body text.');
    });

    test('handles metadata without any known alias', () => {
      const skill = parseAgentSkill(`---
name: unknown-meta
metadata:
  custom_agent:
    requires:
      bins: [tool]
---
# Body`);
      // Unknown alias, requires should be empty
      expect(skill.requires.bins).toEqual([]);
    });
  });
});
