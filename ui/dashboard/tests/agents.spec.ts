import { test, expect } from '@playwright/test';
import {
  gotoAuthenticated,
  MOCK_AGENTS,
  MOCK_AGENT_DETAIL,
  mockAgentKill,
} from './fixtures';

test.describe('Agents Page', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAuthenticated(page);
    await page.getByRole('button', { name: 'Agents' }).click();
  });

  test('displays page header', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
    await expect(
      page.getByText('Manage and monitor running agents'),
    ).toBeVisible();
  });

  test('shows total agent count', async ({ page }) => {
    await expect(page.getByText(`${MOCK_AGENTS.length} total`)).toBeVisible();
  });

  test('renders agent table with all agents', async ({ page }) => {
    // Table headers
    await expect(page.getByText('NAME').first()).toBeVisible();
    await expect(page.getByText('TYPE').first()).toBeVisible();
    await expect(page.getByText('STATUS').first()).toBeVisible();
    await expect(page.getByText('CREATED').first()).toBeVisible();

    // Agent rows
    for (const agent of MOCK_AGENTS) {
      await expect(page.getByText(agent.name)).toBeVisible();
    }
  });

  test('shows agent types in table', async ({ page }) => {
    await expect(page.getByRole('cell', { name: 'pi-session' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'claude-code' }).first()).toBeVisible();
  });

  test('shows status badges for each agent', async ({ page }) => {
    // Count status badges
    const runningBadges = page.locator('text=running');
    const idleBadges = page.locator('text=idle');
    const errorBadges = page.locator('text=error');
    const stoppedBadges = page.locator('text=stopped');

    expect(await runningBadges.count()).toBeGreaterThanOrEqual(2); // 2 running agents
    expect(await idleBadges.count()).toBeGreaterThanOrEqual(1);
    expect(await errorBadges.count()).toBeGreaterThanOrEqual(1);
    expect(await stoppedBadges.count()).toBeGreaterThanOrEqual(1);
  });

  test('shows placeholder when no agent selected', async ({ page }) => {
    await expect(page.getByText('Select an agent to view details')).toBeVisible();
  });

  test('clicking agent row shows detail panel', async ({ page }) => {
    // Click the first agent row
    await page.getByRole('row', { name: /research-bot/ }).click();

    // Detail panel shows agent name as heading and tab buttons
    await expect(page.getByRole('heading', { name: 'research-bot' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Info' })).toBeVisible();
  });

  test('detail panel shows agent metadata', async ({ page }) => {
    await page.getByRole('row', { name: /research-bot/ }).click();

    // ID field
    await expect(page.getByText('agent-001-abcdef123456')).toBeVisible();
    // Type
    await expect(page.getByText('pi-session').first()).toBeVisible();
    // Created By
    await expect(page.getByText('admin').first()).toBeVisible();
  });

  test('detail panel shows capabilities', async ({ page }) => {
    await page.getByRole('row', { name: /research-bot/ }).click();

    await expect(page.getByText('Capabilities')).toBeVisible();
    await expect(page.getByText('web-search')).toBeVisible();
    await expect(page.getByText('file-read')).toBeVisible();
    await expect(page.getByText('code-exec')).toBeVisible();
  });

  test('detail panel shows kill button for running agents', async ({ page }) => {
    await page.getByRole('row', { name: /research-bot/ }).click();

    await expect(page.getByRole('button', { name: 'Kill Agent' })).toBeVisible();
  });

  test('kill agent sends request and shows success', async ({ page }) => {
    await mockAgentKill(page, 'agent-001-abcdef123456');

    await page.getByRole('row', { name: /research-bot/ }).click();
    await page.getByRole('button', { name: 'Kill Agent' }).click();

    await expect(page.getByText('Agent killed successfully')).toBeVisible();
  });

  test('detail panel does not show kill for stopped agents', async ({ page }) => {
    await page.getByRole('row', { name: /old-agent/ }).click();

    // Detail panel shows agent name
    await expect(page.getByRole('heading', { name: 'old-agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kill Agent' })).not.toBeVisible();
  });

  test('close button hides detail panel', async ({ page }) => {
    await page.getByRole('row', { name: /research-bot/ }).click();
    await expect(page.getByRole('heading', { name: 'research-bot' })).toBeVisible();

    // Click close (XCircle button)
    await page.locator('.card-header button').click();

    await expect(page.getByText('Select an agent to view details')).toBeVisible();
  });

  test('selected row is highlighted', async ({ page }) => {
    const row = page.getByRole('row', { name: /research-bot/ });
    await row.click();

    await expect(row).toHaveClass(/bg-foreground/);
  });

  test('refresh button is present and clickable', async ({ page }) => {
    const refreshBtn = page.getByRole('button', { name: 'Refresh' });
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();
    // Should not crash
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  });
});
