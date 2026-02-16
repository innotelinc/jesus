import { test, expect } from '@playwright/test';

test.describe('Email', () => {
  test.skip('loads inbox', async ({ page }) => {
    await page.goto('/en');
    await expect(page.locator('[data-testid="email-list"]')).toBeVisible({ timeout: 15000 });
  });

  test.skip('opens email from list', async ({ page }) => {
    await page.goto('/en');
    const firstEmail = page.locator('[data-testid="email-list-item"]').first();
    await firstEmail.click();
    await expect(page.locator('[data-testid="email-viewer"]')).toBeVisible();
  });

  test.skip('composes new email', async ({ page }) => {
    await page.goto('/en');
    await page.keyboard.press('c');
    await expect(page.locator('[data-testid="email-composer"]')).toBeVisible();
  });
});
