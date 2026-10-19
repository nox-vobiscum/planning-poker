import { test, expect } from '@playwright/test';

for (const theme of ['light', 'dark', 'system']) {
  test(`compact preferences share geometry and states: ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.addInitScript(({ theme }) => {
      localStorage.setItem('planningpoker-theme', theme);
    }, { theme });
    await page.goto('/?lang=en');
    await page.evaluate(() => (window as any).PPUI.ready);
    for (const width of [320, 375, 768, 769, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const hamburger = await page.locator('#menuButton').boundingBox();
      expect(hamburger!.height).toBe(40);
      if (width > 768) {
        for (const selector of ['#hcLang', '.desktop-theme .preference-control']) {
          expect((await page.locator(selector).boundingBox())!.height).toBe(hamburger!.height);
        }
      }
      if (width <= 768) await page.locator('#menuButton').click();
      const selectors = width <= 768
        ? ['#menuTheme', '#menuLang']
        : ['.desktop-theme .preference-control', '#hcLang'];
      const reference = await page.locator('#hcLang').evaluate(el => {
        const css = getComputedStyle(el);
        return [css.backgroundColor, css.borderRadius, css.padding, css.gap, css.boxShadow];
      });
      for (const selector of selectors) {
        const control = page.locator(selector);
        await expect(control).toBeVisible();
        const box = (await control.boundingBox())!;
        expect(box.height).toBe(hamburger!.height);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(await control.evaluate(el => {
          const css = getComputedStyle(el);
          return [css.backgroundColor, css.borderRadius, css.padding, css.gap, css.boxShadow];
        })).toEqual(reference);
        const active = control.locator('[aria-pressed="true"]');
        const inactive = control.locator('[aria-pressed="false"]').first();
        await expect(active).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(active).toHaveCSS('box-shadow', 'none');
        const foreground = await page.locator('body').evaluate(el => getComputedStyle(el).color);
        await expect(active).toHaveCSS('color', foreground);
        expect(await inactive.evaluate(el => getComputedStyle(el).color)).not.toBe(foreground);
        expect((await active.boundingBox())!.height).toBe(30);
      }
      if (width <= 768) await page.locator('#menuCloseButton').click();
    }
    if (theme === 'system') {
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('#hcThemeSystem')).toHaveCSS('color', 'rgb(212, 212, 212)');
    }
  });
}
