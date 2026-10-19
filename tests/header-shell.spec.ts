import { test, expect } from '@playwright/test';

for (const width of [320, 375, 768, 769, 1280]) {
  for (const [name, path] of [
    ['home', '/'], ['about', '/about'],
    ['invite', '/invite?roomCode=header-invite'],
    ['room', '/room?roomCode=header-shell&participantName=HeaderHost'],
  ]) {
    test('header ' + name + ' at ' + width + 'px', async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path!);
      const header = page.locator('.app-header');
      const trigger = page.locator('#menuButton');
      await expect(header).toHaveCount(1);
      await expect(trigger).toHaveCount(1);
      await expect(page.locator('#appMenuOverlay')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(header.locator('.app-brand')).toHaveAttribute('href', '/');
      await expect(header.locator('.app-brand img')).toHaveAttribute('width', '48');
      await expect(header.locator('.app-brand img')).toHaveAttribute('height', '48');
      const brandFontSize = await header.locator('.app-brand').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      expect(brandFontSize).toBeCloseTo(width <= 768 ? 22.4 : 28.8, 1);
      await expect(trigger).toBeVisible();
      expect(await header.evaluate(el => getComputedStyle(el).position)).toBe('static');
      const brand = await header.locator('.app-brand').boundingBox();
      const menu = await trigger.boundingBox();
      const headerBox = await header.boundingBox();
      expect(headerBox!.x).toBeCloseTo(0, 1);
      expect(headerBox!.width).toBeCloseTo(width, 1);
      expect(brand!.x).toBeGreaterThanOrEqual(width <= 768 ? 16 : 24);
      expect(width - (menu!.x + menu!.width)).toBeGreaterThanOrEqual(width <= 768 ? 16 : 24);
      expect(brand!.x + brand!.width).toBeLessThanOrEqual(menu!.x);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('#hcLangEN')).toHaveCount(1);
      await expect(page.locator('#menuLangEN')).toHaveCount(1);
      if (width <= 768) {
        await expect(header.locator('button:visible')).toHaveCount(1);
      } else {
        await expect(page.locator('#hcLangEN')).toBeVisible();
        await expect(page.locator('#hcLangDE')).toBeVisible();
      }
      await trigger.click();
      await expect(page.locator('#appMenuOverlay')).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      const prefix = width <= 768 ? 'menuLang' : 'hcLang';
      // On desktop close the existing overlay before using the header language buttons.
      if (width > 768) await page.locator('#menuCloseButton').click();
      await page.locator('#' + prefix + 'DE').click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.locator('#hcLangDE')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#menuLangDE')).toHaveAttribute('aria-pressed', 'true');
      await page.locator(width <= 768 ? '#themeLight' : '#hcThemeLight').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      if (width > 768) await trigger.click();
      await page.keyboard.press('Escape');
      await expect(page.locator('#appMenuOverlay')).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (name === 'home' && [375, 1280].includes(width)) {
        await page.screenshot({ path: testInfo.outputPath('header.png'), fullPage: true });
      }
    });
  }
}

test('responsive header preserves one menu and language state across resize', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.locator('#hcLangDE').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.locator('#menuButton').click();
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.locator('#appMenuOverlay')).toBeVisible();
  await expect(page.locator('#menuLangDE')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#menuLangEN').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#hcLangEN')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#menuButton')).toHaveCount(1);
});

for (const theme of ['light', 'dark'] as const) {
  test(`full-width header visual ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript(({ theme }) => {
      localStorage.setItem('planningpoker-theme', theme);
    }, { theme });
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 240 });
      await page.goto('/');
      const header = page.locator('.app-header');
      const box = (await header.boundingBox())!;
      expect(box.x).toBeCloseTo(0, 1);
      expect(box.width).toBeCloseTo(width, 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await header.screenshot({ path: testInfo.outputPath(`header-${width}.png`) });
    }
  });
}
