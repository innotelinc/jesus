import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test('loads login page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('input[type="text"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[type="text"]', 'invalid@test.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');
    await expect(page.locator('[role="alert"], .text-red-600, .text-destructive')).toBeVisible({ timeout: 10000 });
  });

  test.skip('logs in with valid credentials', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[type="text"]', process.env.TEST_USER || '');
    await page.fill('input[type="password"]', process.env.TEST_PASS || '');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/en/, { timeout: 15000 });
  });
});
