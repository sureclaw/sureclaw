import { test, expect } from '@playwright/test';
import { gotoAuthenticated } from './fixtures';

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAuthenticated(page);
  });

  test('sidebar shows all navigation items', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agents' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Security' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Logs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
  });

  test('sidebar shows AX logo and title', async ({ page }) => {
    await expect(page.locator('aside').getByText('ax')).toBeVisible();
    await expect(page.locator('aside').getByText('admin')).toBeVisible();
  });

  test('overview is the default active page', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  });

  test('navigating to Agents page', async ({ page }) => {
    await page.getByRole('button', { name: 'Agents' }).click();
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
    await expect(
      page.getByText('Manage and monitor running agents'),
    ).toBeVisible();
  });

  test('navigating to Approvals page', async ({ page }) => {
    await page.getByRole('button', { name: 'Approvals' }).click();
    await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
  });

  test('navigating to Security page', async ({ page }) => {
    await page.getByRole('button', { name: 'Security' }).click();
    await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible();
  });

  test('navigating to Logs page', async ({ page }) => {
    await page.getByRole('button', { name: 'Logs' }).click();
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
  });

  test('navigating to Settings page', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('navigating back and forth between pages', async ({ page }) => {
    // Go to Agents
    await page.getByRole('button', { name: 'Agents' }).click();
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();

    // Go to Logs
    await page.getByRole('button', { name: 'Logs' }).click();
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();

    // Go back to Overview
    await page.getByRole('button', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  });

  test('active nav item is visually highlighted', async ({ page }) => {
    const overviewBtn = page.getByRole('button', { name: 'Overview' });
    // Active page button should have the highlight class
    await expect(overviewBtn).toHaveClass(/bg-foreground/);

    // Switch to agents
    await page.getByRole('button', { name: 'Agents' }).click();
    const agentsBtn = page.getByRole('button', { name: 'Agents' });
    await expect(agentsBtn).toHaveClass(/bg-foreground/);
  });
});
