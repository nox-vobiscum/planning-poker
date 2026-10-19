import { test, expect } from '@playwright/test';

test('Theme switch in Menu updates :root data-theme and reflects state', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');

  // Open the app menu
  const menuBtn = page.locator('.menu-button');
  await expect(menuBtn).toBeVisible();
  await menuBtn.click();

  const bLight  = page.locator('#themeLight');
  const bDark   = page.locator('#themeDark');
  const bSystem = page.locator('#themeSystem');

  // At least one should be visible; in practice all three are.
  await expect(bLight).toBeVisible();
  await expect(bDark).toBeVisible();
  await expect(bSystem).toBeVisible();

  // Switch to Dark
  await bDark.click();
  await expect
    .poll(async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme') || '')))
    .toBe('dark');
  await expect(bDark).toHaveAttribute('aria-pressed', 'true');
  await expect(bLight).toHaveAttribute('aria-pressed', 'false');
  await expect(bSystem).toHaveAttribute('aria-pressed', 'false');

  // Switch to Light
  await bLight.click();
  await expect
    .poll(async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme') || '')))
    .toBe('light');
  await expect(bLight).toHaveAttribute('aria-pressed', 'true');
  await expect(bDark).toHaveAttribute('aria-pressed', 'false');
  await expect(bSystem).toHaveAttribute('aria-pressed', 'false');

  // Switch to System (removes the data-theme attribute)
  await bSystem.click();
  await expect
    .poll(async () => (await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))))
    .toBe(false);
  await expect(bSystem).toHaveAttribute('aria-pressed', 'true');
  await expect(bLight).toHaveAttribute('aria-pressed', 'false');
  await expect(bDark).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#hcThemeSystem')).toHaveAttribute('aria-pressed', 'true');
});

test('compact desktop theme control stays synchronized and supports keyboard and reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.evaluate(() => (window as any).PPUI.ready);

  const light = page.locator('#hcThemeLight');
  const dark = page.locator('#hcThemeDark');
  const system = page.locator('#hcThemeSystem');
  await expect(light).toBeVisible();
  await expect(dark).toBeVisible();
  await expect(system).toBeVisible();

  await dark.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(dark).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#menuButton').click();
  await expect(page.locator('#menuTheme')).toBeHidden();
  await expect(page.locator('#themeDark')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  await system.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  await expect(system).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 247, 249)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(30, 30, 30)');

  await light.click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(light).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('planningpoker-theme'))).toBe('light');
});

test('mobile keeps theme choices in the menu and hides desktop theme controls', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await expect(page.locator('.desktop-theme')).toBeHidden();
  await expect(page.locator('.app-header button:visible')).toHaveCount(1);
  await page.locator('#menuButton').click();
  await expect(page.locator('#themeLight')).toBeVisible();
  await expect(page.locator('#themeDark')).toBeVisible();
  await expect(page.locator('#themeSystem')).toBeVisible();
  await page.locator('#themeDark').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#themeDark')).toHaveAttribute('aria-pressed', 'true');
});
