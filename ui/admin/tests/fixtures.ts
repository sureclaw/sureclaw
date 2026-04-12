import { type Page } from '@playwright/test';

// ── Mock data ──

export const MOCK_TOKEN = 'test-admin-token-abc123';

export const MOCK_STATUS = {
  status: 'ok',
  uptime: 3661,
  profile: 'balanced',
  agents: { active: 2, total: 5 },
};

export const MOCK_AGENTS = [
  {
    id: 'agent-001-abcdef123456',
    name: 'research-bot',
    description: 'Research assistant agent',
    status: 'running',
    agentType: 'pi-session',
    capabilities: ['web-search', 'file-read', 'code-exec'],
    createdAt: '2026-03-06T10:00:00Z',
    updatedAt: '2026-03-06T10:05:00Z',
    createdBy: 'admin',
  },
  {
    id: 'agent-002-defghi456789',
    name: 'code-writer',
    description: 'Code generation agent',
    status: 'running',
    agentType: 'claude-code',
    capabilities: ['file-write', 'terminal'],
    createdAt: '2026-03-06T09:30:00Z',
    updatedAt: '2026-03-06T10:02:00Z',
    createdBy: 'admin',
  },
  {
    id: 'agent-003-ghijkl789012',
    name: 'monitor-agent',
    status: 'idle',
    agentType: 'pi-session',
    capabilities: [],
    createdAt: '2026-03-05T08:00:00Z',
    updatedAt: '2026-03-05T08:00:00Z',
    createdBy: 'system',
  },
  {
    id: 'agent-004-jklmno012345',
    name: 'failed-agent',
    status: 'error',
    agentType: 'pi-session',
    capabilities: ['web-search'],
    createdAt: '2026-03-04T12:00:00Z',
    updatedAt: '2026-03-04T12:01:00Z',
    createdBy: 'admin',
  },
  {
    id: 'agent-005-mnopqr345678',
    name: 'old-agent',
    status: 'stopped',
    agentType: 'claude-code',
    capabilities: [],
    createdAt: '2026-03-01T06:00:00Z',
    updatedAt: '2026-03-02T06:00:00Z',
    createdBy: 'admin',
  },
];

export const MOCK_AGENT_DETAIL = {
  ...MOCK_AGENTS[0],
  children: [
    {
      id: 'child-001',
      name: 'sub-searcher',
      status: 'running',
      agentType: 'pi-session',
      capabilities: [],
      createdAt: '2026-03-06T10:01:00Z',
      updatedAt: '2026-03-06T10:05:00Z',
      createdBy: 'research-bot',
    },
  ],
};

const now = new Date('2026-03-06T10:10:00Z').toISOString();

export const MOCK_AUDIT = [
  {
    timestamp: now,
    sessionId: 'sess-aaa111222333',
    action: 'tool_call',
    args: { tool: 'web-search', query: 'playwright testing' },
    result: 'ok',
    durationMs: 245,
  },
  {
    timestamp: new Date('2026-03-06T10:09:00Z').toISOString(),
    sessionId: 'sess-bbb444555666',
    action: 'llm_request',
    args: { model: 'claude-3' },
    result: 'ok',
    durationMs: 1200,
  },
  {
    timestamp: new Date('2026-03-06T10:08:00Z').toISOString(),
    sessionId: 'sess-ccc777888999',
    action: 'file_write',
    args: { path: '/workspace/output.txt' },
    result: 'blocked',
    durationMs: 5,
  },
  {
    timestamp: new Date('2026-03-06T10:07:00Z').toISOString(),
    sessionId: 'sess-ddd000111222',
    action: 'agent_spawn',
    args: { name: 'sub-agent' },
    result: 'ok',
    durationMs: 350,
  },
  {
    timestamp: new Date('2026-03-06T10:06:00Z').toISOString(),
    sessionId: 'sess-eee333444555',
    action: 'scan',
    args: { type: 'content-scan' },
    result: 'error',
    durationMs: 80,
  },
];

export const MOCK_BLOCKED_AUDIT = [
  {
    timestamp: new Date('2026-03-06T10:08:00Z').toISOString(),
    sessionId: 'sess-ccc777888999',
    action: 'file_write',
    args: { path: '/workspace/output.txt' },
    result: 'blocked',
    durationMs: 5,
  },
  {
    timestamp: new Date('2026-03-06T09:50:00Z').toISOString(),
    sessionId: 'sess-fff666777888',
    action: 'network_access',
    args: { url: 'http://evil.example.com' },
    result: 'blocked',
    durationMs: 2,
  },
];

export const MOCK_SCAN_AUDIT = [
  {
    timestamp: new Date('2026-03-06T10:06:00Z').toISOString(),
    sessionId: 'sess-eee333444555',
    action: 'scan',
    args: { type: 'content-scan' },
    result: 'ok',
    durationMs: 80,
  },
  {
    timestamp: new Date('2026-03-06T09:45:00Z').toISOString(),
    sessionId: 'sess-ggg999000111',
    action: 'scan',
    args: { type: 'dependency-scan' },
    result: 'ok',
    durationMs: 120,
  },
  {
    timestamp: new Date('2026-03-06T09:30:00Z').toISOString(),
    sessionId: 'sess-hhh222333444',
    action: 'scan',
    args: { type: 'binary-scan' },
    result: 'error',
    durationMs: 50,
  },
];

export const MOCK_CONFIG = {
  profile: 'balanced',
  providers: {
    llm: 'anthropic',
    sandbox: 'docker',
    audit: 'sqlite',
  },
  sandbox: {
    type: 'docker',
    timeout: 30000,
  },
  scheduler: {
    maxConcurrent: 3,
    pollInterval: 1000,
  },
};

// ── Route helpers ──

export const MOCK_IDENTITY = [
  { key: 'persona.md', content: 'You are a helpful research assistant.' },
  { key: 'rules.md', content: 'Always cite sources.' },
];

export const MOCK_SKILLS = [
  { name: 'web-search', description: 'Search the web for information', path: '/skills/web-search.md' },
  { name: 'summarize', description: 'Summarize long documents', path: '/skills/summarize.md' },
];

export const MOCK_WORKSPACE_FILES = [
  { path: 'notes.txt', size: 1024 },
  { path: 'output/report.md', size: 4096 },
];

export const MOCK_MEMORY = [
  { id: 'mem-1', scope: 'general', content: 'User prefers concise answers', tags: ['preference'], createdAt: '2026-03-06T10:00:00Z' },
];

/** Set up all standard API mocks for an authenticated dashboard session. */
export async function mockAllAPIs(page: Page) {
  await mockSetupStatus(page, true);
  await mockStatus(page);
  await mockAgents(page);
  await mockAgentTabs(page);
  await mockAudit(page);
  await mockConfig(page);
  await mockSessions(page);
  await mockEvents(page);
}

export async function mockSetupStatus(page: Page, configured: boolean) {
  await page.route('**/admin/api/setup/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured }),
    }),
  );
}

export async function mockStatus(page: Page, data = MOCK_STATUS) {
  await page.route('**/admin/api/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    }),
  );
}

export async function mockAgents(page: Page, data = MOCK_AGENTS) {
  await page.route('**/admin/api/agents', (route) => {
    const url = new URL(route.request().url());
    // Don't match agent detail or kill routes
    if (url.pathname !== '/admin/api/agents') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  });
}

export async function mockAgentDetail(page: Page, id: string, data = MOCK_AGENT_DETAIL) {
  await page.route(`**/admin/api/agents/${id}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    }),
  );
}

export async function mockAgentKill(page: Page, id: string) {
  await page.route(`**/admin/api/agents/${id}/kill`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, agentId: id }),
    }),
  );
}

export async function mockAgentTabs(page: Page) {
  // Mock identity endpoint
  await page.route('**/admin/api/agents/*/identity', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_IDENTITY),
    }),
  );

  // Mock skills list endpoint
  await page.route('**/admin/api/agents/*/skills', (route) => {
    const url = new URL(route.request().url());
    // Only match the skills list, not skills/:name
    const parts = url.pathname.split('/');
    const lastPart = parts[parts.length - 1];
    if (lastPart !== 'skills') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_SKILLS),
    });
  });

  // Mock individual skill content
  await page.route('**/admin/api/agents/*/skills/*', (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/');
    const skillName = parts[parts.length - 1];
    if (skillName === 'skills') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ name: decodeURIComponent(skillName), content: `# ${decodeURIComponent(skillName)} skill content` }),
    });
  });

  // Mock workspace endpoint
  await page.route('**/admin/api/agents/*/workspace**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_WORKSPACE_FILES),
    }),
  );

  // Mock memory endpoint
  await page.route('**/admin/api/agents/*/memory**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_MEMORY),
    }),
  );
}

export async function mockAudit(page: Page, data = MOCK_AUDIT) {
  await page.route('**/admin/api/audit**', (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const result = url.searchParams.get('result');

    if (action === 'scan') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SCAN_AUDIT),
      });
    }
    if (result === 'blocked') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_BLOCKED_AUDIT),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  });
}

export async function mockConfig(page: Page, data = MOCK_CONFIG) {
  await page.route('**/admin/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    }),
  );
}

export async function mockSessions(page: Page) {
  await page.route('**/admin/api/sessions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [] }),
    }),
  );
}

export async function mockEvents(page: Page) {
  await page.route('**/admin/api/events**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: ':connected\n\n',
    }),
  );
}

/** Navigate to the dashboard with a pre-set auth token. */
export async function gotoAuthenticated(page: Page, path = '/admin/') {
  await mockAllAPIs(page);
  // Set token via URL param (the app reads it and stores in localStorage)
  await page.goto(`${path}?token=${MOCK_TOKEN}`);
}
