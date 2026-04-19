import { test, expect } from '@playwright/test';
import {
  gotoAuthenticated,
  mockSkillsSetup,
  mockSkillsSetupWithOAuth,
  MOCK_SKILL_SETUP,
  MOCK_SKILL_SETUP_WITH_OAUTH,
  MOCK_TOKEN,
} from './fixtures';

test.describe('Approvals Page', () => {
  test('renders heading and empty state when nothing is pending', async ({ page }) => {
    // Install empty-response overrides AFTER gotoAuthenticated so they take
    // precedence over the defaults installed by mockAllAPIs (Playwright applies
    // the most-recently registered matching route first).
    await mockSkillsSetup(page, { agents: [] });
    await gotoAuthenticated(page, '/admin/?page=approvals');
    // Re-install the empty overrides after the default mockAllAPIs ran inside
    // gotoAuthenticated, so the hooks fetch the empty response.
    await mockSkillsSetup(page, { agents: [] });
    // The app strips ?page= from history on boot (so reloads don't pin the
    // page). Re-navigate with the param so the reloaded state still renders
    // the Approvals page and picks up the empty-response overrides above.
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
    await expect(page.getByText(/Nothing to approve/i)).toBeVisible();
  });

  test('renders a setup card with name, description, domains, credentials and MCP URLs', async ({ page }) => {
    await gotoAuthenticated(page, '/admin/?page=approvals');

    // Agent group heading
    await expect(page.getByText('research-bot')).toBeVisible();

    // Skill card name + description
    await expect(
      page.getByRole('heading', { name: 'linear-tracker' })
    ).toBeVisible();
    await expect(page.getByText('Read and update Linear issues.')).toBeVisible();

    // Domain checkbox
    await expect(page.getByText('api.linear.app')).toBeVisible();
    const domainCheckbox = page.getByRole('checkbox').first();
    await expect(domainCheckbox).toBeChecked();

    // Credential label (includes scope) — scoped to the linear-tracker card
    const linearCard = page.locator('[data-testid="setup-card-linear-tracker"]');
    await expect(linearCard.getByText('LINEAR_TOKEN')).toBeVisible();
    await expect(linearCard.getByText('(user-scoped)')).toBeVisible();

    // MCP server URL rendered
    await expect(page.getByText('linear-mcp')).toBeVisible();
    await expect(page.getByText('https://mcp.linear.app/sse')).toBeVisible();
  });

  test('approve click POSTs expected body and shows success UI', async ({ page }) => {
    let approveBody: unknown = null;
    await page.route('**/admin/api/skills/setup/approve', (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      try {
        approveBody = JSON.parse(req.postData() ?? '{}');
      } catch {
        approveBody = {};
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          state: { name: 'linear-tracker', kind: 'enabled' },
        }),
      });
    });

    await gotoAuthenticated(page, '/admin/?page=approvals');

    // Fill the linear token
    const tokenInput = page.locator('#cred-agent-001-abcdef123456-linear-tracker-LINEAR_TOKEN');
    await tokenInput.fill('secret-token-value');

    // Approve
    await page
      .locator('[data-testid="setup-card-linear-tracker"]')
      .getByRole('button', { name: /approve & enable/i })
      .click();

    // Success chip
    await expect(page.getByText('Enabled', { exact: true })).toBeVisible();

    // Verify request body
    expect(approveBody).toMatchObject({
      agentId: 'agent-001-abcdef123456',
      skillName: 'linear-tracker',
      credentials: [{ envName: 'LINEAR_TOKEN', value: 'secret-token-value' }],
      approveDomains: ['api.linear.app'],
    });

    // Approve + Dismiss stay visible during the 1.5s refresh window. They
    // MUST be disabled so a second click can't fire a duplicate /approve
    // (which would 404 once reconcile drops the setup row) or a stray dismiss.
    const card = page.locator('[data-testid="setup-card-linear-tracker"]');
    await expect(card.getByRole('button', { name: /approve & enable/i })).toBeDisabled();
    await expect(card.getByRole('button', { name: /dismiss/i })).toBeDisabled();
  });

  test('approve surfaces both error and details when the server rejects', async ({ page }) => {
    await page.route('**/admin/api/skills/setup/approve', (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Request does not match pending setup' },
          details: 'Unexpected credential: EVIL_KEY',
        }),
      });
    });

    await gotoAuthenticated(page, '/admin/?page=approvals');

    // Fill the linear token so the Approve button is enabled
    const tokenInput = page.locator('#cred-agent-001-abcdef123456-linear-tracker-LINEAR_TOKEN');
    await tokenInput.fill('secret-token-value');

    await page
      .locator('[data-testid="setup-card-linear-tracker"]')
      .getByRole('button', { name: /approve & enable/i })
      .click();

    // Both strings render — the message from `error.message` and the
    // structured `details` string from the envelope.
    await expect(
      page.getByText('Request does not match pending setup')
    ).toBeVisible();
    await expect(page.getByText('Unexpected credential: EVIL_KEY')).toBeVisible();
  });

  test('dismiss uses confirm-click pattern and calls DELETE', async ({ page }) => {
    let dismissCalled = false;
    await page.route(
      '**/admin/api/skills/setup/agent-001-abcdef123456/linear-tracker',
      (route) => {
        const req = route.request();
        if (req.method() !== 'DELETE') return route.fallback();
        dismissCalled = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, removed: true }),
        });
      }
    );

    await gotoAuthenticated(page, '/admin/?page=approvals');

    const card = page.locator('[data-testid="setup-card-linear-tracker"]');
    const dismissBtn = card.getByRole('button', { name: /dismiss/i });

    // First click — shows confirm
    await dismissBtn.click();
    await expect(card.getByRole('button', { name: /confirm dismiss\?/i })).toBeVisible();

    // Second click — fires DELETE
    await card.getByRole('button', { name: /confirm dismiss\?/i }).click();

    await expect.poll(() => dismissCalled).toBeTruthy();
  });

  test('OAuth credential disables Approve button', async ({ page }) => {
    await gotoAuthenticated(page, '/admin/?page=approvals');

    const gcalCard = page.locator('[data-testid="setup-card-gcal-helper"]');
    // Phase 6 replaces the stub with a real Connect button.
    await expect(
      gcalCard.getByRole('button', { name: /connect with google/i })
    ).toBeVisible();

    const approveBtn = gcalCard.getByRole('button', { name: /approve & enable/i });
    await expect(approveBtn).toBeDisabled();
  });

  test('OAuth credential shows Connect with <provider> button', async ({ page }) => {
    // Install the OAuth-variant response BEFORE gotoAuthenticated so that
    // mockAllAPIs' default MOCK_SKILL_SETUP route is later-registered and
    // takes precedence during boot. Then re-install after and re-navigate
    // (the app strips ?page= on boot so page.reload() lands on Overview).
    await mockSkillsSetupWithOAuth(page);
    await gotoAuthenticated(page, '/admin/?page=approvals');
    await mockSkillsSetupWithOAuth(page);
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await expect(
      card.getByRole('button', { name: /connect with linear/i })
    ).toBeVisible();
    // Approve disabled because OAuth cred is unconnected.
    await expect(
      card.getByRole('button', { name: /approve & enable/i })
    ).toBeDisabled();
  });

  test('Connect click POSTs start and opens authUrl in new tab', async ({ page }) => {
    let startBody: unknown = null;
    await page.route('**/admin/api/skills/oauth/start', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      try {
        startBody = JSON.parse(route.request().postData() ?? '{}');
      } catch {
        startBody = {};
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authUrl: 'https://linear.app/oauth/authorize?client_id=x',
          state: 'abc',
        }),
      });
    });

    // Capture window.open calls. Install BEFORE the app boots so the override
    // sticks when the real Connect handler runs.
    await page.addInitScript(() => {
      (window as unknown as { __opened: string[] }).__opened = [];
      window.open = ((url: string) => {
        (window as unknown as { __opened: string[] }).__opened.push(url);
        return { closed: false } as unknown as Window;
      }) as typeof window.open;
    });

    await mockSkillsSetupWithOAuth(page);
    await gotoAuthenticated(page, '/admin/?page=approvals');
    await mockSkillsSetupWithOAuth(page);
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await card.getByRole('button', { name: /connect with linear/i }).click();

    await expect.poll(() => startBody).toMatchObject({
      agentId: 'agent-001-abcdef123456',
      skillName: 'linear-oauth',
      envName: 'LINEAR_TOKEN',
    });

    const opened = await page.evaluate(
      () => (window as unknown as { __opened: string[] }).__opened
    );
    expect(opened).toContain('https://linear.app/oauth/authorize?client_id=x');
  });

  test('Approve enables when OAuth credential disappears from missingCredentials', async ({
    page,
  }) => {
    // Mock setup to return a card where LINEAR_TOKEN is already connected
    // (empty missingCredentials). Registered AFTER gotoAuthenticated so the
    // override wins over the default mockAllAPIs route.
    await page.route('**/admin/api/skills/setup', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            {
              agentId: 'agent-001-abcdef123456',
              agentName: 'research-bot',
              cards: [
                {
                  skillName: 'linear-oauth',
                  description: 'Linear via OAuth',
                  missingCredentials: [],
                  unapprovedDomains: ['api.linear.app'],
                  mcpServers: [
                    { name: 'linear', url: 'https://mcp.linear.app' },
                  ],
                },
              ],
            },
          ],
        }),
      })
    );

    await gotoAuthenticated(page, '/admin/?page=approvals');
    // Re-register after gotoAuthenticated so the override sticks. Reload to
    // re-fetch with the new mock.
    await page.route('**/admin/api/skills/setup', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            {
              agentId: 'agent-001-abcdef123456',
              agentName: 'research-bot',
              cards: [
                {
                  skillName: 'linear-oauth',
                  description: 'Linear via OAuth',
                  missingCredentials: [],
                  unapprovedDomains: ['api.linear.app'],
                  mcpServers: [
                    { name: 'linear', url: 'https://mcp.linear.app' },
                  ],
                },
              ],
            },
          ],
        }),
      })
    );
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await expect(
      card.getByRole('button', { name: /approve & enable/i })
    ).toBeEnabled();
  });

  test('Pop-up blocked surfaces an error on the card', async ({ page }) => {
    await page.route('**/admin/api/skills/oauth/start', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authUrl: 'https://linear.app/oauth/authorize',
          state: 'abc',
        }),
      });
    });

    // Stub window.open to return null — simulates a blocked popup.
    await page.addInitScript(() => {
      window.open = (() => null) as typeof window.open;
    });

    await mockSkillsSetupWithOAuth(page);
    await gotoAuthenticated(page, '/admin/?page=approvals');
    await mockSkillsSetupWithOAuth(page);
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await card.getByRole('button', { name: /connect with linear/i }).click();

    await expect(card.getByText(/pop-up blocked/i)).toBeVisible();
  });

  test('Start endpoint 404 surfaces the error on the card', async ({ page }) => {
    await page.route('**/admin/api/skills/oauth/start', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'No provider registered for linear' },
        }),
      });
    });

    await mockSkillsSetupWithOAuth(page);
    await gotoAuthenticated(page, '/admin/?page=approvals');
    await mockSkillsSetupWithOAuth(page);
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await card.getByRole('button', { name: /connect with linear/i }).click();

    await expect(
      card.getByText(/no provider registered for linear/i)
    ).toBeVisible();
  });

  test('credential request card renders and Save POSTs to /credentials/provide', async ({ page }) => {
    let provideBody: unknown = null;
    await page.route('**/admin/api/credentials/provide', (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      try {
        provideBody = JSON.parse(req.postData() ?? '{}');
      } catch {
        provideBody = {};
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await gotoAuthenticated(page, '/admin/?page=approvals');

    const reqCard = page.locator(
      '[data-testid="credential-request-sess-credreq-1111aaaa-STRIPE_API_KEY"]'
    );
    await expect(reqCard).toBeVisible();
    await expect(reqCard.getByRole('heading', { name: 'STRIPE_API_KEY' })).toBeVisible();
    await expect(reqCard.getByText(/billing-bot/)).toBeVisible();

    // Fill value and save
    await reqCard.locator('input[type="password"]').fill('sk_live_whatever');
    await reqCard.getByRole('button', { name: /^save$/i }).click();

    await expect(reqCard.getByText('Saved', { exact: true })).toBeVisible();

    expect(provideBody).toMatchObject({
      envName: 'STRIPE_API_KEY',
      value: 'sk_live_whatever',
      sessionId: 'sess-credreq-1111aaaa',
    });
  });

  test('surface the MOCK fixtures referenced here stay in sync', async () => {
    // Quick sanity check — lock the mock shape so unexpected edits blow up loudly.
    expect(MOCK_SKILL_SETUP.agents).toHaveLength(1);
    expect(MOCK_SKILL_SETUP.agents[0].cards).toHaveLength(2);
    expect(MOCK_CREDENTIAL_REQUESTS.requests).toHaveLength(1);
    // Phase-6 OAuth fixture must carry a single oauth-typed credential.
    expect(MOCK_SKILL_SETUP_WITH_OAUTH.agents).toHaveLength(1);
    expect(MOCK_SKILL_SETUP_WITH_OAUTH.agents[0].cards[0].missingCredentials[0].authType).toBe('oauth');
  });
});
