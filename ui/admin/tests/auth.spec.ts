import { test, expect } from '@playwright/test';
import {
  MOCK_TOKEN,
  mockSetupStatus,
  mockAllAPIs,
  gotoAuthenticated,
} from './fixtures';

test.describe('Authentication', () => {
  test('shows login page when no token is present', async ({ page }) => {
    await mockSetupStatus(page, true);
    await page.goto('/admin/');

    await expect(page.getByText('AX Admin')).toBeVisible();
    await expect(page.getByText('No admin token provided')).toBeVisible();
    await expect(
      page.getByText('The admin URL with token is printed when the server starts'),
    ).toBeVisible();
  });

  test('authenticates via URL token param and shows dashboard', async ({ page }) => {
    await mockAllAPIs(page);
    await page.goto(`/admin/?token=${MOCK_TOKEN}`);

    // Should show the main dashboard sidebar
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agents' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Security' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Logs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  });

  test('strips token from URL after authentication', async ({ page }) => {
    await mockAllAPIs(page);
    await page.goto(`/admin/?token=${MOCK_TOKEN}`);

    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    // Token should be stripped from the URL
    expect(page.url()).not.toContain('token=');
  });

  test('persists token in localStorage', async ({ page }) => {
    await mockAllAPIs(page);
    await page.goto(`/admin/?token=${MOCK_TOKEN}`);

    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();

    const storedToken = await page.evaluate(() =>
      localStorage.getItem('ax-admin-token'),
    );
    expect(storedToken).toBe(MOCK_TOKEN);
  });

  test('logout clears token and shows login page', async ({ page }) => {
    await gotoAuthenticated(page);

    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();

    // Click logout
    await page.getByRole('button', { name: 'Logout' }).click();

    // Should show login page
    await expect(page.getByText('AX Admin')).toBeVisible();
    await expect(page.getByText('No admin token provided')).toBeVisible();

    // Token should be cleared
    const storedToken = await page.evaluate(() =>
      localStorage.getItem('ax-admin-token'),
    );
    expect(storedToken).toBeNull();
  });

  test('redirects to login on 401 from API', async ({ page }) => {
    await mockSetupStatus(page, true);

    // Mock status to return 401
    await page.route('**/admin/api/status', (route) =>
      route.fulfill({ status: 401, body: 'Unauthorized' }),
    );
    await page.route('**/admin/api/agents', (route) =>
      route.fulfill({ status: 401, body: 'Unauthorized' }),
    );
    await page.route('**/admin/api/audit**', (route) =>
      route.fulfill({ status: 401, body: 'Unauthorized' }),
    );

    // Set token directly to simulate returning user
    await page.goto('/admin/');
    await page.evaluate((t) => localStorage.setItem('ax-admin-token', t), MOCK_TOKEN);
    await page.reload();

    // Should eventually show login page due to 401
    await expect(page.getByText('No admin token provided')).toBeVisible({ timeout: 10_000 });
  });
});
