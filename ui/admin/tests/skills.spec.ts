import { test, expect } from '@playwright/test';
import {
  gotoAuthenticated,
  mockSkillsSetup,
  mockCredentialRequests,
  MOCK_SKILL_SETUP,
  MOCK_CREDENTIAL_REQUESTS,
  MOCK_TOKEN,
} from './fixtures';

test.describe('Skills Page', () => {
  test('renders heading and empty state when nothing is pending', async ({ page }) => {
    // Install empty-response overrides AFTER gotoAuthenticated so they take
    // precedence over the defaults installed by mockAllAPIs (Playwright applies
    // the most-recently registered matching route first).
    await mockSkillsSetup(page, { agents: [] });
    await mockCredentialRequests(page, { requests: [] });
    await gotoAuthenticated(page, '/admin/?page=skills');
    // Re-install the empty overrides after the default mockAllAPIs ran inside
    // gotoAuthenticated, so the hooks fetch the empty response.
    await mockSkillsSetup(page, { agents: [] });
    await mockCredentialRequests(page, { requests: [] });
    // The app strips ?page= from history on boot (so reloads don't pin the
    // page). Re-navigate with the param so the reloaded state still renders
    // the Skills page and picks up the empty-response overrides above.
    await page.goto(`/admin/?page=skills&token=${MOCK_TOKEN}`);

    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
    await expect(page.getByText(/All your skills are set up/i)).toBeVisible();
  });

  test('renders a setup card with name, description, domains, credentials and MCP URLs', async ({ page }) => {
    await gotoAuthenticated(page, '/admin/?page=skills');

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

    await gotoAuthenticated(page, '/admin/?page=skills');

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

    await gotoAuthenticated(page, '/admin/?page=skills');

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

    await gotoAuthenticated(page, '/admin/?page=skills');

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
    await gotoAuthenticated(page, '/admin/?page=skills');

    const gcalCard = page.locator('[data-testid="setup-card-gcal-helper"]');
    await expect(gcalCard.getByText(/OAuth flow/i)).toBeVisible();

    const approveBtn = gcalCard.getByRole('button', { name: /approve & enable/i });
    await expect(approveBtn).toBeDisabled();
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

    await gotoAuthenticated(page, '/admin/?page=skills');

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
  });
});
