import { test, expect } from '@playwright/test';
import { gotoAuthenticated, MOCK_STATUS, MOCK_CONFIG } from './fixtures';

test.describe('Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAuthenticated(page);
    await page.getByRole('button', { name: 'Settings' }).click();
  });

  test('displays page header', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Server configuration (read-only)')).toBeVisible();
  });

  test('shows read-only notice with ax.yaml reference', async ({ page }) => {
    await expect(
      page.getByText('Configuration is read-only in the dashboard'),
    ).toBeVisible();
    await expect(page.getByText('ax.yaml')).toBeVisible();
  });

  test('shows server information section', async ({ page }) => {
    await expect(page.getByText('Server Information')).toBeVisible();

    // Status
    await expect(page.getByText('Status').first()).toBeVisible();
    await expect(page.getByText(MOCK_STATUS.status).first()).toBeVisible();

    // Uptime
    await expect(page.getByText('Uptime').first()).toBeVisible();

    // Security Profile
    await expect(page.getByText('Security Profile').first()).toBeVisible();
    await expect(page.getByText('balanced').first()).toBeVisible();

    // Agents
    await expect(page.getByText('Agents').first()).toBeVisible();
    await expect(
      page.getByText(
        `${MOCK_STATUS.agents.active} active / ${MOCK_STATUS.agents.total} total`,
      ),
    ).toBeVisible();
  });

  test('shows security profile config section', async ({ page }) => {
    // Config section titled "Security Profile"
    const sections = page.locator('.card');
    const profileSection = sections.filter({ hasText: 'Security Profile' }).last();
    await expect(profileSection).toBeVisible();
    await expect(profileSection.getByText(MOCK_CONFIG.profile)).toBeVisible();
  });

  test('shows providers config section', async ({ page }) => {
    await expect(page.getByText('Providers')).toBeVisible();

    // Provider values
    await expect(page.getByText('llm')).toBeVisible();
    await expect(page.getByText('anthropic')).toBeVisible();
    await expect(page.getByText('sandbox').first()).toBeVisible();
    await expect(page.getByText('docker').first()).toBeVisible();
    await expect(page.getByText('audit')).toBeVisible();
    await expect(page.getByText('sqlite')).toBeVisible();
  });

  test('shows sandbox config section', async ({ page }) => {
    await expect(page.getByText('Sandbox').first()).toBeVisible();
    await expect(page.getByText('type')).toBeVisible();
    await expect(page.getByText('timeout')).toBeVisible();
    await expect(page.getByText('30000')).toBeVisible();
  });

  test('shows scheduler config section', async ({ page }) => {
    await expect(page.getByText('Scheduler')).toBeVisible();
    await expect(page.getByText('maxConcurrent')).toBeVisible();
    await expect(page.getByText('3').first()).toBeVisible();
    await expect(page.getByText('pollInterval')).toBeVisible();
    await expect(page.getByText('1000')).toBeVisible();
  });

  test('refresh button reloads both status and config', async ({ page }) => {
    const refreshBtn = page.getByRole('button', { name: 'Refresh' });
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });
});
