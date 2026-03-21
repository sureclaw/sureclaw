import { test, expect } from '@playwright/test';
import {
  gotoAuthenticated,
  MOCK_SCAN_AUDIT,
  MOCK_BLOCKED_AUDIT,
} from './fixtures';

test.describe('Security Page', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAuthenticated(page);
    await page.getByRole('button', { name: 'Security' }).click();
  });

  test('displays page header', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible();
    await expect(
      page.getByText('Security profile, scans, and threat monitoring'),
    ).toBeVisible();
  });

  test('shows security profile card', async ({ page }) => {
    await expect(page.getByText('Active Security Profile')).toBeVisible();
    // balanced profile
    await expect(page.getByRole('heading', { name: 'balanced' })).toBeVisible();
    await expect(
      page.getByText('Reasonable defaults'),
    ).toBeVisible();
  });

  test('displays security stats', async ({ page }) => {
    // Scans count
    await expect(page.getByText('Scans', { exact: true })).toBeVisible();
    await expect(
      page.getByText(String(MOCK_SCAN_AUDIT.length)).first(),
    ).toBeVisible();

    // Blocked count
    await expect(page.getByText('Blocked', { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText(String(MOCK_BLOCKED_AUDIT.length)).first(),
    ).toBeVisible();

    // Clean scans count
    const cleanCount = MOCK_SCAN_AUDIT.filter((e) => e.result === 'ok').length;
    await expect(page.getByText('Clean Scans')).toBeVisible();
    await expect(page.getByText(String(cleanCount)).first()).toBeVisible();
  });

  test('shows threat patterns section', async ({ page }) => {
    await expect(page.getByText('Threat Patterns')).toBeVisible();
    await expect(
      page.getByText(`${MOCK_BLOCKED_AUDIT.length} blocked`),
    ).toBeVisible();

    // Blocked events should appear
    for (const entry of MOCK_BLOCKED_AUDIT) {
      await expect(page.getByText(entry.action).first()).toBeVisible();
    }
  });

  test('shows security scans section', async ({ page }) => {
    await expect(page.getByText('Security Scans')).toBeVisible();

    const passCount = MOCK_SCAN_AUDIT.filter((e) => e.result === 'ok').length;
    await expect(page.getByText(`${passCount} pass`)).toBeVisible();

    // Scan events should appear with their action names
    for (const entry of MOCK_SCAN_AUDIT) {
      await expect(page.getByText(entry.action).first()).toBeVisible();
    }
  });

  test('scan events show duration', async ({ page }) => {
    for (const entry of MOCK_SCAN_AUDIT) {
      await expect(page.getByText(`${entry.durationMs}ms`).first()).toBeVisible();
    }
  });

  test('refresh button is present', async ({ page }) => {
    const refreshBtn = page.getByRole('button', { name: 'Refresh' });
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();
    await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible();
  });
});
