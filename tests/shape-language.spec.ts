import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark', 'system']) {
  for (const width of [375, 1280]) {
    test(`shape families ${theme} at ${width}px`, async ({ baseURL, page, browserName }, testInfo) => {
          await page.setViewportSize({ width, height: 800 });
          await page.emulateMedia({ colorScheme: 'light' });
          await page.addInitScript(({ theme }) => {
            localStorage.setItem('planningpoker-theme', theme);
          }, { theme });
          await page.goto(`${baseURL}/?lang=en`);
          const measure = async (selector: string) => page.locator(selector).evaluate(el => {
            const css = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
              radius: css.borderRadius,
              height: rect.height,
              border: `${css.borderTopWidth} ${css.borderTopStyle} ${css.borderTopColor}`,
              background: css.backgroundColor,
              shadow: css.boxShadow,
            };
          });

          const language = await measure('#hcLang');
          const themeControl = await measure('.desktop-theme .preference-control');
          expect(language.radius).toBe('10px');
          expect(themeControl.radius).toBe(language.radius);
          expect(themeControl.border).toBe(language.border);
          if (width > 768) {
            expect(language.height).toBe(40);
            expect(themeControl.height).toBe(language.height);
          }
          expect((await measure('#nameInput')).radius).toBe('14px');
          expect((await measure('#joinForm .button')).radius).toBe('14px');
          expect((await measure('#joinForm')).radius).toBe('20px');

          const trigger = page.locator('#menuButton');
          await trigger.focus();
          await expect(trigger).toHaveCSS('outline-style', 'solid');
          await page.keyboard.press('Enter');
          const close = page.locator('#menuCloseButton');
          await expect(close).toBeFocused();
          await expect(close).toHaveCSS('outline-style', 'solid');
          const menuButton = await measure('#menuButton');
          const closeButton = await measure('#menuCloseButton');
          expect(menuButton.radius).toBe('14px');
          expect(closeButton).toEqual(menuButton);
          expect(menuButton.height).toBe(40);
          const menuTheme = await measure('#menuTheme');
          expect(menuTheme.radius).toBe('10px');
          expect((await measure('.menu-panel')).radius).toBe(width <= 768 ? '20px' : '0px');
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          if (theme === 'dark') {
            await page.screenshot({ path: testInfo.outputPath(`${browserName}-${width}.png`), animations: 'disabled' });
          }
    });
  }
}
