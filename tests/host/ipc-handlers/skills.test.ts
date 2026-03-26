/**
 * Tests for the skill_install IPC handler.
 *
 * Verifies the host-controlled skill installation flow:
 * download from ClawHub, parse SKILL.md, generate manifest,
 * store in DB, and add domains to the proxy allowlist.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initLogger } from '../../../src/logger.js';

// Silence logger in tests
initLogger({ file: false, level: 'silent' });

// ── Mocks ──

vi.mock('../../../src/clawhub/registry-client.js', () => ({
  search: vi.fn(),
  fetchSkillPackage: vi.fn(),
}));

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

function makeMockDocuments() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (_col: string, key: string) => store.get(key) ?? null),
    put: vi.fn(async (_col: string, key: string, val: string) => { store.set(key, val); }),
    delete: vi.fn(async (_col: string, key: string) => store.delete(key)),
    list: vi.fn(async () => [...store.keys()]),
    _store: store,
  };
}

function makeProviders(docs = makeMockDocuments()): ProviderRegistry {
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
    storage: {
      documents: docs,
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
    vi.clearAllMocks();
  });

  test('installs skill by slug: downloads, parses, stores in DB, generates manifest, adds domains', async () => {
    const slug = 'test-skill';
    const pkg = makeSkillPackage(slug);
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue(pkg);

    const docs = makeMockDocuments();
    const providers = makeProviders(docs);
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

    // Verify skill was stored in DB
    expect(docs.put).toHaveBeenCalledWith(
      'skills',
      `main/${slug}`,
      expect.stringContaining('"id":"test-skill"'),
    );

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

  test('returns not installed when no storage provider', async () => {
    const slug = 'no-storage';
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue(makeSkillPackage(slug));

    // No storage.documents
    const providers = {
      audit: { log: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue([]) },
      credentials: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), list: vi.fn(), delete: vi.fn() },
    } as unknown as ProviderRegistry;
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({ slug }, ctx);

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('No storage provider available');
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

  test('stores all files in DB record', async () => {
    const slug = 'multi-file';
    const files = [
      { path: 'SKILL.md', content: SKILL_MD_CONTENT },
      { path: 'scripts/run.sh', content: '#!/bin/bash\necho hello' },
      { path: '../../../etc/evil.txt', content: 'pwned' },
    ];
    vi.mocked(clawhub.fetchSkillPackage).mockResolvedValue({
      slug,
      displayName: 'Multi File',
      files,
      requiresEnv: [],
    });

    const docs = makeMockDocuments();
    const providers = makeProviders(docs);
    const handlers = createSkillsHandlers(providers);
    const ctx = makeCtx();

    const result = await handlers.skill_install({ slug }, ctx);

    expect(result.installed).toBe(true);
    // All files (including traversal paths) are stored in DB — DB is not path-sensitive
    const stored = JSON.parse(docs._store.get(`main/${slug}`)!);
    expect(stored.files).toHaveLength(3);
  });
});
