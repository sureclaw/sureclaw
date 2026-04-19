import { test, expect } from '@playwright/test';
import {
  gotoAuthenticated,
  MOCK_IDENTITY,
  MOCK_WORKSPACE_FILES,
  MOCK_MEMORY,
  MOCK_AGENT_SKILLS,
} from './fixtures';

test.describe('Agent Detail Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAuthenticated(page);
    await page.getByRole('button', { name: 'Agents' }).click();
    // The Agents page auto-selects the first agent (research-bot) on load —
    // wait for its name to render in the selector bar so the detail panel is
    // visible before per-test actions kick in.
    await expect(page.getByText('research-bot').first()).toBeVisible();
  });

  test('shows all six sections', async ({ page }) => {
    // Both the sidebar sub-nav and the in-page tab nav render a button with
    // each section's name — `.first()` narrows to a single match either way.
    await expect(page.getByRole('button', { name: 'Overview' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Identity' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skills' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connectors' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Workspace' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Memory' }).first()).toBeVisible();
  });

  test('Overview section is active by default', async ({ page }) => {
    // Overview should show agent metadata
    await expect(page.getByText('agent-001-abcdef123456')).toBeVisible();
  });

  test('Identity tab loads and shows documents', async ({ page }) => {
    await page.getByRole('button', { name: 'Identity' }).click();

    // Should show identity documents
    for (const doc of MOCK_IDENTITY) {
      await expect(page.getByText(doc.key)).toBeVisible();
    }
  });

  test('Identity tab expands document to show content', async ({ page }) => {
    await page.getByRole('button', { name: 'Identity' }).click();

    // Click on the first document to expand it
    await page.getByText(MOCK_IDENTITY[0].key).click();
    await expect(page.getByText(MOCK_IDENTITY[0].content)).toBeVisible();
  });

  test('Workspace tab loads and shows files', async ({ page }) => {
    await page.getByRole('button', { name: 'Workspace' }).click();

    // Should show file paths
    for (const file of MOCK_WORKSPACE_FILES) {
      await expect(page.getByText(file.path)).toBeVisible();
    }
  });

  test('Workspace tab shows file count', async ({ page }) => {
    await page.getByRole('button', { name: 'Workspace' }).click();
    await expect(page.getByText(`${MOCK_WORKSPACE_FILES.length} files`)).toBeVisible();
  });

  test('Memory tab loads and shows entries', async ({ page }) => {
    await page.getByRole('button', { name: 'Memory' }).click();

    await expect(page.getByText(MOCK_MEMORY[0].content)).toBeVisible();
  });

  test('Memory tab shows scope input', async ({ page }) => {
    await page.getByRole('button', { name: 'Memory' }).click();

    await expect(page.getByText('Scope')).toBeVisible();
    await expect(page.getByPlaceholder('general')).toBeVisible();
  });

  test('Skills tab lists enabled and pending skills with state labels', async ({ page }) => {
    await page.getByRole('button', { name: 'Skills' }).click();

    for (const s of MOCK_AGENT_SKILLS.skills) {
      const card = page.locator(`[data-testid="agent-skill-${s.name}"]`);
      await expect(card).toBeVisible();
      await expect(card.getByText(s.name, { exact: true })).toBeVisible();
      await expect(card.getByText(s.kind, { exact: true })).toBeVisible();
      if (s.description) {
        await expect(card.getByText(s.description)).toBeVisible();
      }
    }
  });

  test('Skills tab surfaces pending reasons', async ({ page }) => {
    await page.getByRole('button', { name: 'Skills' }).click();

    const pendingCard = page.locator('[data-testid="agent-skill-linear"]');
    for (const reason of MOCK_AGENT_SKILLS.skills[1].pendingReasons!) {
      await expect(pendingCard.getByText(reason)).toBeVisible();
    }
  });

  test('Skills tab shows Refresh tools button only on enabled skills', async ({ page }) => {
    await page.getByRole('button', { name: 'Skills' }).click();

    // Enabled skill-creator → button present.
    const enabledCard = page.locator('[data-testid="agent-skill-skill-creator"]');
    await expect(
      enabledCard.locator('[data-testid="agent-skill-skill-creator-refresh"]'),
    ).toBeVisible();

    // Pending linear → no refresh button.
    const pendingCard = page.locator('[data-testid="agent-skill-linear"]');
    await expect(
      pendingCard.locator('[data-testid="agent-skill-linear-refresh"]'),
    ).toHaveCount(0);
  });

  test('Refresh tools button on enabled skill shows success feedback', async ({ page }) => {
    await page.getByRole('button', { name: 'Skills' }).click();

    await page
      .locator('[data-testid="agent-skill-skill-creator-refresh"]')
      .click();

    // Default mock responds 200 with moduleCount=2, toolCount=5 — see fixtures.
    const successBanner = page.locator(
      '[data-testid="agent-skill-skill-creator-refresh-success"]',
    );
    await expect(successBanner).toBeVisible();
    await expect(successBanner).toContainText('2 modules');
    await expect(successBanner).toContainText('5 tools');
  });
});
