import { test, expect } from '@playwright/test';
import {
  gotoAuthenticated,
  MOCK_STATUS,
  MOCK_AGENTS,
  MOCK_AUDIT,
  mockAllAPIs,
  mockStatus,
  mockAgents,
  mockAudit,
  mockSetupStatus,
  mockConfig,
  mockSessions,
  mockEvents,
} from './fixtures';

test.describe('Overview Page', () => {
  test('displays page header', async ({ page }) => {
    await gotoAuthenticated(page);

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(
      page.getByText('Real-time system observability and agent orchestration'),
    ).toBeVisible();
  });

  test('shows system status indicator', async ({ page }) => {
    await gotoAuthenticated(page);

    // MOCK_STATUS.status is 'ok', which renders as-is (only 'running' shows 'All systems operational')
    const statusIndicator = page.locator('.animate-pulse-live').first();
    await expect(statusIndicator).toBeVisible();
    await expect(page.getByText('ok').first()).toBeVisible();
  });

  test('shows security profile badge', async ({ page }) => {
    await gotoAuthenticated(page);

    // The profile badge is a span with the profile name
    const badge = page.locator('span').filter({ hasText: /^balanced$/ });
    await expect(badge.first()).toBeVisible();
  });

  test('displays stat cards with correct data', async ({ page }) => {
    await gotoAuthenticated(page);

    // Active Agents stat
    await expect(page.getByText('Active Agents')).toBeVisible();
    await expect(
      page.getByText(`${MOCK_STATUS.agents.active} / ${MOCK_STATUS.agents.total}`),
    ).toBeVisible();

    // Uptime stat — 3661 seconds = 1h 1m
    await expect(page.getByText('Uptime')).toBeVisible();
    await expect(page.getByText('1h 1m')).toBeVisible();

    // Security Profile stat card
    const profileCard = page.locator('.card').filter({ hasText: 'Security Profile' }).first();
    await expect(profileCard).toBeVisible();

    // Total Events stat
    await expect(page.getByText('Total Events')).toBeVisible();
    await expect(page.getByText(String(MOCK_AUDIT.length), { exact: true }).first()).toBeVisible();
  });

  test('displays live agents list', async ({ page }) => {
    await gotoAuthenticated(page);

    await expect(page.getByText('Live Agents')).toBeVisible();

    // Agent names
    for (const agent of MOCK_AGENTS) {
      await expect(page.getByText(agent.name).first()).toBeVisible();
    }
  });

  test('shows agent status badges', async ({ page }) => {
    await gotoAuthenticated(page);

    // Should have status badges for different states
    await expect(page.getByText('running').first()).toBeVisible();
    await expect(page.getByText('idle').first()).toBeVisible();
    await expect(page.getByText('error').first()).toBeVisible();
    await expect(page.getByText('stopped').first()).toBeVisible();
  });

  test('displays recent activity feed', async ({ page }) => {
    await gotoAuthenticated(page);

    await expect(page.getByText('Recent Activity')).toBeVisible();
    await expect(page.getByText(`Last ${MOCK_AUDIT.length} events`)).toBeVisible();

    // Check audit actions appear
    await expect(page.getByText('tool_call').first()).toBeVisible();
    await expect(page.getByText('llm_request').first()).toBeVisible();
    await expect(page.getByText('file_write').first()).toBeVisible();
  });

  test('activity feed shows result badges', async ({ page }) => {
    await gotoAuthenticated(page);

    // Check result badges in the activity feed
    await expect(page.getByText('success').first()).toBeVisible();
    await expect(page.getByText('blocked').first()).toBeVisible();
  });

  test('activity feed shows duration', async ({ page }) => {
    await gotoAuthenticated(page);

    await expect(page.getByText('245ms')).toBeVisible();
    await expect(page.getByText('1200ms')).toBeVisible();
  });

  test('refresh button triggers data reload', async ({ page }) => {
    let statusCallCount = 0;

    await mockSetupStatus(page, true);
    await page.route('**/admin/api/status', (route) => {
      statusCallCount++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_STATUS),
      });
    });
    await mockAgents(page);
    await mockAudit(page);
    await mockConfig(page);
    await mockSessions(page);
    await mockEvents(page);

    await page.goto(`/admin/?token=test-token`);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    const initialCalls = statusCallCount;
    await page.getByRole('button', { name: 'Refresh' }).click();

    // Wait for the refresh to trigger
    await page.waitForTimeout(500);
    expect(statusCallCount).toBeGreaterThan(initialCalls);
  });

  test('shows empty state when no agents', async ({ page }) => {
    await mockSetupStatus(page, true);
    await mockStatus(page);
    await mockAgents(page, []);
    await mockAudit(page);
    await mockConfig(page);
    await mockSessions(page);
    await mockEvents(page);

    await page.goto(`/admin/?token=test-token`);

    await expect(page.getByText('No agents running')).toBeVisible();
  });

  test('shows empty state when no audit entries', async ({ page }) => {
    await mockSetupStatus(page, true);
    await mockStatus(page);
    await mockAgents(page);
    await mockAudit(page, []);
    await mockConfig(page);
    await mockSessions(page);
    await mockEvents(page);

    await page.goto(`/admin/?token=test-token`);

    await expect(page.getByText('No activity recorded yet')).toBeVisible();
  });

  test('shows error state on API failure', async ({ page }) => {
    await mockSetupStatus(page, true);
    await page.route('**/admin/api/status', (route) =>
      route.fulfill({ status: 500, body: 'Internal Server Error' }),
    );
    await mockAgents(page);
    await mockAudit(page);
    await mockConfig(page);
    await mockSessions(page);
    await mockEvents(page);

    await page.goto(`/admin/?token=test-token`);

    await expect(page.getByText('Connection Error')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
