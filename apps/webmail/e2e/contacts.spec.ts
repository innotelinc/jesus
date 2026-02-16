import { test, expect } from '@playwright/test';

test.describe('Contacts', () => {
  test.skip('navigates to contacts page', async ({ page }) => {
    await page.goto('/en/contacts');
    await expect(page.locator('text=title')).toBeVisible();
  });

  test.skip('creates a new contact', async ({ page }) => {
    await page.goto('/en/contacts');
    await page.click('text=create_new');
    await page.fill('input[placeholder="given_name"]', 'Test');
    await page.fill('input[placeholder="surname"]', 'User');
    await page.fill('input[type="email"]', 'test@example.com');
    await page.click('button[type="submit"]');
  });
});
