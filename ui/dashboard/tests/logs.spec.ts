import { test, expect } from '@playwright/test';
import { gotoAuthenticated, MOCK_AUDIT } from './fixtures';

test.describe('Logs Page', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAuthenticated(page);
    await page.getByRole('button', { name: 'Logs' }).click();
  });

  test('displays page header', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
    await expect(
      page.getByText('System activity and event history'),
    ).toBeVisible();
  });

  test('shows entry count', async ({ page }) => {
    await expect(page.getByText(`${MOCK_AUDIT.length} entries`)).toBeVisible();
  });

  test('renders log table with headers', async ({ page }) => {
    // Table headers are rendered as <th> elements with uppercase text
    const table = page.locator('table');
    await expect(table).toBeVisible();
    await expect(table.locator('th').first()).toBeVisible();

    // Verify the column header count (Timestamp, Action, Session, Result, Duration)
    const headers = table.locator('th');
    await expect(headers).toHaveCount(5);
  });

  test('displays audit entries with actions', async ({ page }) => {
    const table = page.locator('table');
    for (const entry of MOCK_AUDIT) {
      await expect(table.getByText(entry.action).first()).toBeVisible();
    }
  });

  test('displays result badges', async ({ page }) => {
    // We have ok, blocked, error results in mock data
    const table = page.locator('table');
    await expect(table.getByText('ok').first()).toBeVisible();
    await expect(table.getByText('blocked').first()).toBeVisible();
    await expect(table.getByText('error').first()).toBeVisible();
  });

  test('displays durations', async ({ page }) => {
    const table = page.locator('table');
    await expect(table.getByText('245ms')).toBeVisible();
    await expect(table.getByText('1200ms')).toBeVisible();
    await expect(table.getByText('5ms', { exact: true })).toBeVisible();
  });

  test('displays truncated session IDs', async ({ page }) => {
    // Session IDs are sliced to 12 chars + "..."
    await expect(page.getByText('sess-aaa1112').first()).toBeVisible();
  });

  test('action filter dropdown has all options', async ({ page }) => {
    const actionSelect = page.locator('select').first();
    await expect(actionSelect).toBeVisible();

    const options = await actionSelect.locator('option').allTextContents();
    expect(options).toContain('All Actions');
    expect(options).toContain('Tool Calls');
    expect(options).toContain('LLM Requests');
    expect(options).toContain('Agent Spawn');
    expect(options).toContain('Security Scans');
  });

  test('result filter dropdown has all options', async ({ page }) => {
    const resultSelect = page.locator('select').nth(1);
    await expect(resultSelect).toBeVisible();

    const options = await resultSelect.locator('option').allTextContents();
    expect(options).toContain('All Results');
    expect(options).toContain('OK');
    expect(options).toContain('Error');
    expect(options).toContain('Blocked');
    expect(options).toContain('Timeout');
  });

  test('search input is present and functional', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search actions, sessions...');
    await expect(searchInput).toBeVisible();

    await searchInput.fill('tool_call');
    // Should trigger a re-fetch (the mock returns same data regardless)
    await expect(page.getByText('Log Entries')).toBeVisible();
  });

  test('action filter triggers refetch', async ({ page }) => {
    let lastUrl = '';
    await page.route('**/admin/api/audit**', (route) => {
      lastUrl = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_AUDIT),
      });
    });

    const actionSelect = page.locator('select').first();
    await actionSelect.selectOption('tool_call');

    await page.waitForTimeout(500);
    expect(lastUrl).toContain('action=tool_call');
  });

  test('result filter triggers refetch', async ({ page }) => {
    let lastUrl = '';
    await page.route('**/admin/api/audit**', (route) => {
      lastUrl = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_AUDIT),
      });
    });

    const resultSelect = page.locator('select').nth(1);
    await resultSelect.selectOption('error');

    await page.waitForTimeout(500);
    expect(lastUrl).toContain('result=error');
  });

  test('refresh button reloads data', async ({ page }) => {
    const refreshBtn = page.getByRole('button', { name: 'Refresh' });
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
  });
});
