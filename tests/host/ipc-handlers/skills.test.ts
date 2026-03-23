/**
 * Tests for the skill_install IPC handler.
 *
 * Verifies the host-controlled skill installation flow:
 * download from ClawHub, parse SKILL.md, generate manifest,
 * write files to disk, and add domains to the proxy allowlist.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initLogger } from '../../../src/logger.js';

// Silence logger in tests
initLogger({ file: false, level: 'silent' });

// ── Mocks ──

vi.mock('../../../src/clawhub/registry-client.js', () => ({
  search: vi.fn(),
  fetchSkillPackage: vi.fn(),
}));

// Mock paths to use temp directory
let testAxHome: string;

vi.mock('../../../src/paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/paths.js')>();
  return {
    ...original,
    userSkillsDir: (agentId: string, userId: string) =>
      join(testAxHome, 'agents', agentId, 'users', userId, 'skills'),
  };
});

import * as clawhub from '../../../src/clawhub/registry-client.js';
import { createSkillsHandlers } from '../../../src/host/ipc-handlers/skills.js';
import { ProxyDomainList } from '../../../src/host/proxy-domain-list.js';
import type { ProviderRegistry } from '../../../src/types.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';

// ── Helpers ──

function makeCtx(overrides: Partial<IPCContext> = {}): IPCContext {
  return {
    sessionId: 'test-session-' + randomUUID(),
    agentId: 'main',
    userId: 'testuser',
    ...overrides,
  };
}

function makeProviders(): ProviderRegistry {
  return {
    audit: {
      log: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    },
    credentials: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ProviderRegistry;
}

const SKILL_MD_CONTENT = `---
name: Test Skill
description: A test skill for unit tests
metadata:
  openclaw:
    install:
      - run: "npm install -g test-tool"
        bin: test-tool
    requires:
      env:
        - TEST_API_KEY
---

# Test Skill

This skill fetches data from https://api.example.com/v1/data
and sends it to https://webhook.example.com/hook.
`;

function makeSkillPackage(slug: string, files?: Array<{ path: string; content: string }>) {
  return {
    slug,
    displayName: slug.replace(/-/g, ' '),
    files: files ?? [
      { path: 'SKILL.md', content: SKILL_MD_CONTENT },
      { path: 'scripts/run.sh', content: '#!/bin/bash\necho hello' },
    ],
    requiresEnv: ['TEST_API_KEY'],
  };
}

// ── Tests ──

describe('skill_install handler', () => {
  beforeEach(() => {
    testAxHome = join(tmpdir(), `ax-test-skill-install-${randomUUID()}`);
    mkdirSync(testAxHome, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(testAxHome, { recursive: true, force: true });
  });

  test('installs skill by slug: downloads, parses, writes files, generates manifest, adds domains', async () => {
    const slug = 'test-skill';
    const pkg = makeSkillPackage(slug);
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue(pkg);

    const providers = makeProviders();
    const domainList = new ProxyDomainList();
    const handlers = createSkillsHandlers(providers, { domainList });
    const ctx = makeCtx();

    const result = await handlers.skill_install({ slug }, ctx);

    expect(result.installed).toBe(true);
    expect(result.name).toBe('Test Skill');
    expect(result.slug).toBe(slug);
    expect(result.requiresEnv).toEqual(['TEST_API_KEY']);
    expect(result.domains).toContain('api.example.com');
    expect(result.domains).toContain('webhook.example.com');
    expect(result.installSteps).toBe(1);

    // Verify files were written
    const skillDir = join(testAxHome, 'agents', 'main', 'users', 'testuser', 'skills', slug);
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir, 'scripts', 'run.sh'))).toBe(true);
    expect(readFileSync(join(skillDir, 'scripts', 'run.sh'), 'utf-8')).toBe('#!/bin/bash\necho hello');

    // Verify domains were added to proxy allowlist
    expect(domainList.isAllowed('api.example.com')).toBe(true);
    expect(domainList.isAllowed('webhook.example.com')).toBe(true);

    // Verify audit log was called
    expect(providers.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'skill_install',
        sessionId: ctx.sessionId,
        result: 'success',
      }),
    );
  });

  test('installs skill by query: searches ClawHub first, then installs', async () => {
    const slug = 'found-skill';
    vi.mocked(clawhub.search).mockResolvedValue([
      { slug, displayName: 'Found Skill', summary: null, version: null },
    ]);
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue(makeSkillPackage(slug));

    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({ query: 'found' }, ctx);

    expect(clawhub.search).toHaveBeenCalledWith('found', 5);
    expect(clawhub.fetchSkillPackage).toHaveBeenCalledWith(slug);
    expect(result.installed).toBe(true);
    expect(result.slug).toBe(slug);
  });

  test('returns not installed when search yields no results', async () => {
    vi.mocked(clawhub.search).mockResolvedValue([]);

    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({ query: 'nonexistent' }, ctx);

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('No matching skills found');
  });

  test('returns not installed when neither query nor slug provided', async () => {
    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({}, ctx);

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('Provide query or slug');
  });

  test('rejects README.md when no SKILL.md is present', async () => {
    const slug = 'readme-only';
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue({
      slug,
      displayName: 'Readme Only',
      files: [
        { path: 'README.md', content: '# Just a readme' },
      ],
      requiresEnv: [],
    });

    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({ slug }, ctx);

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('No SKILL.md found in package');
  });

  test('returns not installed when package has no SKILL.md', async () => {
    const slug = 'no-skill-md';
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue({
      slug,
      displayName: 'No Skill MD',
      files: [
        { path: 'README.txt', content: 'No SKILL.md here' },
      ],
      requiresEnv: [],
    });

    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({ slug }, ctx);

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('No SKILL.md found in package');
  });

  test('does not add domains when domainList is not provided', async () => {
    const slug = 'no-domain-list';
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue(makeSkillPackage(slug));

    const providers = makeProviders();
    // No domainList in opts
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({ slug }, ctx);

    // Should still succeed — just no domain registration
    expect(result.installed).toBe(true);
    expect(result.domains).toContain('api.example.com');
  });

  test('uses fallback userId when ctx.userId is not set', async () => {
    const slug = 'fallback-user';
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue(makeSkillPackage(slug));

    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx({ userId: undefined });

    const result = await handlers.skill_install({ slug }, ctx);

    expect(result.installed).toBe(true);
    // Files should be written under 'default' user
    const skillDir = join(testAxHome, 'agents', 'main', 'users', 'default', 'skills', slug);
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
  });

  test('skill with no domains does not call addSkillDomains', async () => {
    const slug = 'no-domains';
    const simpleSkillMd = `---
name: Simple Skill
---

# Simple Skill

Just does local stuff.
`;
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue({
      slug,
      displayName: 'Simple Skill',
      files: [{ path: 'SKILL.md', content: simpleSkillMd }],
      requiresEnv: [],
    });

    const providers = makeProviders();
    const domainList = new ProxyDomainList();
    const addSpy = vi.spyOn(domainList, 'addSkillDomains');
    const handlers = createSkillsHandlers(providers, { domainList });
    const ctx = makeCtx();

    const result = await handlers.skill_install({ slug }, ctx);

    expect(result.installed).toBe(true);
    expect(result.domains).toEqual([]);
    expect(addSpy).not.toHaveBeenCalled();
  });

  test('uses skill name from parsed SKILL.md, falls back to slug', async () => {
    const slug = 'unnamed-skill';
    const noNameSkillMd = `---
description: no name field
---

# Instructions

Do stuff.
`;
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue({
      slug,
      displayName: 'Unnamed',
      files: [{ path: 'SKILL.md', content: noNameSkillMd }],
      requiresEnv: [],
    });

    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({ slug }, ctx);

    expect(result.installed).toBe(true);
    // name field is empty string from parser, so falls back to slug
    expect(result.name).toBe(slug);
  });

  test('extracts slug from ClawHub URL in query field', async () => {
    const resolvedSlug = 'linear';
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue(makeSkillPackage(resolvedSlug));

    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    // When query is a ClawHub URL, it should extract the slug, NOT search
    const result = await handlers.skill_install(
      { query: 'https://clawhub.ai/ManuelHettich/linear' },
      ctx,
    );

    expect(clawhub.search).not.toHaveBeenCalled();
    expect(clawhub.fetchSkillPackage).toHaveBeenCalledWith('ManuelHettich/linear');
    expect(result.installed).toBe(true);
    expect(result.slug).toBe(resolvedSlug);
  });

  test('extracts slug from ClawHub URL in slug field', async () => {
    const resolvedSlug = 'linear';
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue(makeSkillPackage(resolvedSlug));

    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install(
      { slug: 'https://clawhub.ai/ManuelHettich/linear' },
      ctx,
    );

    expect(clawhub.fetchSkillPackage).toHaveBeenCalledWith('ManuelHettich/linear');
    expect(result.installed).toBe(true);
    expect(result.slug).toBe(resolvedSlug);
  });

  test('blocks path traversal in package file paths', async () => {
    const slug = 'evil-skill';
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue({
      slug,
      displayName: 'Evil Skill',
      files: [
        { path: 'SKILL.md', content: SKILL_MD_CONTENT },
        { path: '../../../etc/evil.txt', content: 'pwned' },
      ],
      requiresEnv: [],
    });

    const providers = makeProviders();
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({ slug }, ctx);

    expect(result.installed).toBe(true);
    // SKILL.md should be written but the traversal file should be skipped
    const skillDir = join(testAxHome, 'agents', 'main', 'users', 'testuser', 'skills', slug);
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    // The evil file should NOT exist outside the skill directory
    expect(existsSync(join(testAxHome, 'etc', 'evil.txt'))).toBe(false);
  });
});
