import { test, expect } from '@playwright/test';
import {
  gotoAuthenticated,
  MOCK_IDENTITY,
  MOCK_SKILLS,
  MOCK_WORKSPACE_FILES,
  MOCK_MEMORY,
} from './fixtures';

test.describe('Agent Detail Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAuthenticated(page);
    await page.getByRole('button', { name: 'Agents' }).click();
    // Click on the first agent to open detail panel
    await page.getByRole('row', { name: /research-bot/ }).click();
  });

  test('shows all five tabs', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Info' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Identity' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skills' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Workspace' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Memory' })).toBeVisible();
  });

  test('Info tab is active by default', async ({ page }) => {
    // Info tab should show agent metadata
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

  test('Skills tab loads and shows skills', async ({ page }) => {
    await page.getByRole('button', { name: 'Skills' }).click();

    // Should show skill names (use exact match to avoid matching descriptions)
    for (const skill of MOCK_SKILLS) {
      await expect(page.getByText(skill.name, { exact: true })).toBeVisible();
    }
  });

  test('Skills tab shows skill descriptions', async ({ page }) => {
    await page.getByRole('button', { name: 'Skills' }).click();

    for (const skill of MOCK_SKILLS) {
      if (skill.description) {
        await expect(page.getByText(skill.description)).toBeVisible();
      }
    }
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
});
