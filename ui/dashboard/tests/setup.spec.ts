import { test, expect } from '@playwright/test';
import { mockSetupStatus } from './fixtures';

test.describe('Setup Wizard', () => {
  test.beforeEach(async ({ page }) => {
    await mockSetupStatus(page, false);
  });

  test('shows setup wizard when server is unconfigured', async ({ page }) => {
    await page.goto('/admin/');

    await expect(page.getByText('AX Setup')).toBeVisible();
    await expect(page.getByText('Configure your AX instance')).toBeVisible();
    await expect(page.getByText('Welcome to AX')).toBeVisible();
  });

  test('step 1: welcome page has Get Started button', async ({ page }) => {
    await page.goto('/admin/');

    await expect(page.getByText('Welcome to AX')).toBeVisible();
    await expect(
      page.getByText('security-focused AI agent platform'),
    ).toBeVisible();

    const getStarted = page.getByRole('button', { name: 'Get Started' });
    await expect(getStarted).toBeVisible();
    await expect(getStarted).toBeEnabled();
  });

  test('step 2: security profile selection', async ({ page }) => {
    await page.goto('/admin/');

    // Navigate to profile step
    await page.getByRole('button', { name: 'Get Started' }).click();

    await expect(page.getByRole('heading', { name: 'Security Profile' })).toBeVisible();
    await expect(page.getByText('How paranoid should we be?')).toBeVisible();

    // All three profiles visible as buttons
    const paranoidBtn = page.getByRole('button', { name: /Paranoid/ });
    const balancedBtn = page.getByRole('button', { name: /Balanced/ });
    const yoloBtn = page.getByRole('button', { name: /YOLO/ });

    await expect(paranoidBtn).toBeVisible();
    await expect(balancedBtn).toBeVisible();
    await expect(yoloBtn).toBeVisible();

    // Balanced should be pre-selected (default)
    await expect(balancedBtn).toHaveClass(/border-amber/);

    // Select Paranoid
    await paranoidBtn.click();
    await expect(paranoidBtn).toHaveClass(/border-rose/);
  });

  test('step 3: agent type selection', async ({ page }) => {
    await page.goto('/admin/');

    await page.getByRole('button', { name: 'Get Started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Agent Type' })).toBeVisible();
    await expect(page.getByText('Choose your default agent runner')).toBeVisible();

    const piBtn = page.getByRole('button', { name: /PI Session/ });
    const claudeBtn = page.getByRole('button', { name: /Claude Code/ });

    await expect(piBtn).toBeVisible();
    await expect(claudeBtn).toBeVisible();

    // PI Session should be pre-selected
    await expect(piBtn).toHaveClass(/border-amber/);

    // Select Claude Code
    await claudeBtn.click();
    await expect(claudeBtn).toHaveClass(/border-amber/);
  });

  test('step 4: API key input', async ({ page }) => {
    await page.goto('/admin/');

    await page.getByRole('button', { name: 'Get Started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'API Key' })).toBeVisible();
    await expect(page.getByText('Enter your LLM provider API key')).toBeVisible();

    const input = page.locator('#api-key');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('type', 'password');

    // Continue should be disabled without an API key
    const continueBtn = page.getByRole('button', { name: 'Continue' });
    await expect(continueBtn).toBeDisabled();

    // Type a key
    await input.fill('sk-test-key-12345');
    await expect(continueBtn).toBeEnabled();
  });

  test('step 5: review shows selected options', async ({ page }) => {
    await page.goto('/admin/');

    // Walk through all steps
    await page.getByRole('button', { name: 'Get Started' }).click();
    // Select Paranoid
    await page.getByRole('button', { name: /Paranoid/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    // Select Claude Code
    await page.getByRole('button', { name: /Claude Code/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    // Enter API key
    await page.locator('#api-key').fill('sk-test-key-12345');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Review page
    await expect(page.getByText('Review Configuration')).toBeVisible();
    await expect(page.getByText('paranoid')).toBeVisible();
    await expect(page.getByText('Claude Code').first()).toBeVisible();
    await expect(page.getByText('sk-test')).toBeVisible(); // Masked key
    await expect(page.getByRole('button', { name: 'Configure AX' })).toBeVisible();
  });

  test('step 5: configure submits and shows done', async ({ page }) => {
    // Mock the configure endpoint
    await page.route('**/admin/api/setup/configure', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, token: 'new-admin-token-xyz' }),
      }),
    );

    await page.goto('/admin/');

    // Walk through all steps quickly
    await page.getByRole('button', { name: 'Get Started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('#api-key').fill('sk-test-key-12345');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Submit
    await page.getByRole('button', { name: 'Configure AX' }).click();

    // Should show done page
    await expect(page.getByText('All Set!')).toBeVisible();
    await expect(page.getByText('AX is configured and ready to go')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Dashboard' })).toBeVisible();
  });

  test('back button navigates to previous step', async ({ page }) => {
    await page.goto('/admin/');

    await page.getByRole('button', { name: 'Get Started' }).click();
    await expect(page.getByRole('heading', { name: 'Security Profile' })).toBeVisible();

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Agent Type' })).toBeVisible();

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'Security Profile' })).toBeVisible();
  });

  test('step indicator progresses through steps', async ({ page }) => {
    await page.goto('/admin/');

    // Step indicator should be visible (6 step bars)
    const stepBars = page.locator('.rounded-full.transition-all');
    await expect(stepBars).toHaveCount(6);
  });
});
