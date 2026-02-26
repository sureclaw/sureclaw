import { describe, test, expect } from 'vitest';
import { parseAgentSkill } from '../../src/utils/skill-format-parser.js';
import { generateManifest } from '../../src/utils/manifest-generator.js';

function manifestFrom(raw: string) {
  return generateManifest(parseAgentSkill(raw));
}

describe('manifest-generator', () => {
  // ── Basic mapping ─────────────────────────────────

  describe('metadata mapping', () => {
    test('maps requires.bins to host_commands and requires.bins', () => {
      const m = manifestFrom(`---
name: my-tool
metadata:
  openclaw:
    requires:
      bins: [my-tool, helper]
      env: [MY_API_KEY]
    os: [linux, macos]
---
# My Tool`);

      expect(m.name).toBe('my-tool');
      expect(m.requires.bins).toEqual(['my-tool', 'helper']);
      expect(m.requires.env).toContain('MY_API_KEY');
      expect(m.requires.os).toEqual(['linux', 'macos']);
      expect(m.capabilities.host_commands).toContain('my-tool');
      expect(m.capabilities.host_commands).toContain('helper');
    });

    test('maps install specs with approval: required', () => {
      const m = manifestFrom(`---
name: tool
metadata:
  openclaw:
    install:
      - kind: brew
        formula: org/tap/tool
        bins: [tool]
      - kind: node
        package: tool-cli
        bins: [tool]
---
# Tool`);

      expect(m.install.steps).toHaveLength(2);
      expect(m.install.steps[0]).toEqual({
        kind: 'brew',
        package: 'org/tap/tool',
        bins: ['tool'],
        approval: 'required',
      });
      expect(m.install.steps[1]).toEqual({
        kind: 'node',
        package: 'tool-cli',
        bins: ['tool'],
        approval: 'required',
      });
    });
  });

  // ── Static analysis: host commands ────────────────

  describe('static analysis — host commands', () => {
    test('detects docker in body', () => {
      const m = manifestFrom(`---
name: docker-skill
---
# Docker Skill
Run \`docker build -t myapp .\` to build the image.`);

      expect(m.capabilities.host_commands).toContain('docker');
    });

    test('detects uv in code block', () => {
      const m = manifestFrom(`---
name: uv-skill
---
# UV Skill
\`\`\`bash
uv run scripts/main.py
\`\`\``);

      expect(m.capabilities.host_commands).toContain('uv');
    });

    test('detects multiple commands', () => {
      const m = manifestFrom(`---
name: multi
---
# Multi
Use \`npm install\` and then \`docker compose up\`.`);

      expect(m.capabilities.host_commands).toContain('npm');
      expect(m.capabilities.host_commands).toContain('docker');
    });
  });

  // ── Static analysis: env vars ─────────────────────

  describe('static analysis — env vars', () => {
    test('detects GEMINI_API_KEY in body', () => {
      const m = manifestFrom(`---
name: image-gen
---
# Image Gen
Set GEMINI_API_KEY or pass --api-key.`);

      expect(m.requires.env).toContain('GEMINI_API_KEY');
    });

    test('detects multiple env vars', () => {
      const m = manifestFrom(`---
name: multi-env
---
# Multi
Configure OPENAI_API_KEY and GITHUB_TOKEN.`);

      expect(m.requires.env).toContain('OPENAI_API_KEY');
      expect(m.requires.env).toContain('GITHUB_TOKEN');
    });

    test('does not false-positive on common words', () => {
      const m = manifestFrom(`---
name: clean
---
# README
NOTE: Use GET and POST methods via the URL.`);

      expect(m.requires.env).toEqual([]);
    });
  });

  // ── Static analysis: domains ──────────────────────

  describe('static analysis — domains', () => {
    test('extracts domains from URLs', () => {
      const m = manifestFrom(`---
name: web-skill
---
# Web Skill
Fetch data from https://api.example.com/v1/data and https://cdn.other.org/lib.js.`);

      expect(m.capabilities.domains).toContain('api.example.com');
      expect(m.capabilities.domains).toContain('cdn.other.org');
    });
  });

  // ── Static analysis: script paths ─────────────────

  describe('static analysis — script paths', () => {
    test('detects scripts/ paths', () => {
      const m = manifestFrom(`---
name: scripted
---
# Scripted
\`\`\`bash
uv run scripts/generate_image.py --prompt "test"
\`\`\``);

      expect(m.executables.some(e => e.path === 'scripts/generate_image.py')).toBe(true);
    });
  });

  // ── Static analysis: IPC tools ────────────────────

  describe('static analysis — IPC tools', () => {
    test('detects web_fetch reference', () => {
      const m = manifestFrom(`---
name: web-tool
---
# Web Tool
Use the web_fetch tool to retrieve data.`);

      expect(m.capabilities.tools).toContain('web_fetch');
    });
  });

  // ── Real-world skill: gog ─────────────────────────

  describe('real-world: gog', () => {
    test('generates correct manifest for gog', () => {
      const m = manifestFrom(`---
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
Use \`gog\` to work with Google Workspace.
## Quick start
\`gog mail list\`
\`gog cal list\``);

      expect(m.name).toBe('gog');
      expect(m.requires.bins).toEqual(['gog']);
      expect(m.capabilities.host_commands).toContain('gog');
      expect(m.install.steps).toHaveLength(1);
      expect(m.install.steps[0].kind).toBe('brew');
      expect(m.install.steps[0].package).toBe('steipete/tap/gogcli');
    });
  });

  // ── Real-world skill: nano-banana-pro ─────────────

  describe('real-world: nano-banana-pro', () => {
    test('generates manifest from body analysis (no metadata)', () => {
      const m = manifestFrom(`---
name: nano-banana-pro
description: Generate/edit images with Nano Banana Pro (Gemini 3 Pro Image).
---
# Nano Banana Pro Image Generation

Generate new images or edit existing ones using Google's Nano Banana Pro API.

## Usage

\`\`\`bash
uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py --prompt "your image description" --filename "output.png" --resolution 1K --api-key KEY
\`\`\`

Set GEMINI_API_KEY for authentication.`);

      // No metadata block — all from static analysis
      expect(m.requires.bins).toEqual([]);
      expect(m.capabilities.host_commands).toContain('uv');
      expect(m.requires.env).toContain('GEMINI_API_KEY');
      expect(m.executables.some(e => e.path === 'scripts/generate_image.py')).toBe(true);
    });
  });

  // ── Real-world skill: mcporter ────────────────────

  describe('real-world: mcporter', () => {
    test('generates correct manifest for mcporter', () => {
      const m = manifestFrom(`---
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
Use \`mcporter\` to work with MCP servers directly.
\`mcporter list\`
\`mcporter call <server.tool> key=value\``);

      expect(m.name).toBe('mcporter');
      expect(m.requires.bins).toEqual(['mcporter']);
      expect(m.capabilities.host_commands).toContain('mcporter');
      expect(m.install.steps[0].kind).toBe('node');
      expect(m.install.steps[0].package).toBe('mcporter');
    });
  });

  // ── Edge cases ────────────────────────────────────

  describe('edge cases', () => {
    test('handles empty skill', () => {
      const m = manifestFrom('');
      expect(m.name).toBe('');
      expect(m.requires.bins).toEqual([]);
      expect(m.capabilities.tools).toEqual([]);
    });

    test('deduplicates host_commands', () => {
      const m = manifestFrom(`---
name: dup
metadata:
  openclaw:
    requires:
      bins: [docker]
---
Run \`docker build\` and \`docker push\`.`);

      const dockerCount = m.capabilities.host_commands.filter(c => c === 'docker').length;
      expect(dockerCount).toBe(1);
    });
  });
});
