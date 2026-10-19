import { test, expect, chromium, webkit } from '@playwright/test';

// Compare the same controls and state across engines, not font rasterization.
for (const width of [375, 768, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`control geometry ${theme} at ${width}px`, async ({ baseURL }, testInfo) => {
      const measurements: Record<string, any[]> = {};
      for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
        const browser = await engine.launch();
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        try {
          const page = await context.newPage();
          await page.addInitScript(({ theme }) => {
            localStorage.setItem('planningpoker-theme', theme);
          }, { theme });
          await page.goto(`${baseURL}/room?roomCode=geometry-${engineName}-${Date.now()}&participantName=Host`);
          const cards = page.locator('#cardGrid button');
          await expect(cards.first()).toBeVisible();
          await expect(page.locator('#liveParticipantList .participant-row')).toHaveCount(1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const cardSizes = await page.evaluate(() => Array.from(document.querySelectorAll('#cardGrid button'), el => {
            const rect = el.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          }));
          // Short labels must not collapse into intrinsic-width native buttons.
          for (const size of cardSizes) {
            expect(size.width).toBeGreaterThan(35);
            expect(Math.abs(size.width - cardSizes[0]!.width)).toBeLessThan(1);
            expect(size.height).toBeGreaterThanOrEqual(48);
          }
          await page.screenshot({ path: testInfo.outputPath(`${engineName}-room.png`), fullPage: true });
          if (width <= 768) await page.locator('#menuButton').click();
          const themeDark = width <= 768 ? '#themeDark' : '#hcThemeDark';
          const themeSystem = width <= 768 ? '#themeSystem' : '#hcThemeSystem';
          await page.locator(themeSystem).focus();
          await page.keyboard.press('Shift+Tab');
          await expect(page.locator(themeDark)).toHaveCSS('outline-style', 'solid');
          await page.mouse.move(0, 0);
          // Query and measure atomically: WebSocket updates can replace card nodes.
          measurements[engineName] = await page.evaluate(({ themeDark, themeSystem }) => Array.from(document.querySelectorAll(`#cardGrid button,#revealButton,#menuButton,#copyRoomLink,${themeDark},${themeSystem}`), el => {
            const css = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return { label: el.id || el.textContent, width: rect.width, height: rect.height, radius: css.borderRadius, appearance: css.appearance };
          }), { themeDark, themeSystem });
          await page.screenshot({ path: testInfo.outputPath(`${engineName}-menu.png`) });
        } finally {
          await context.close();
          await browser.close();
        }
      }
      expect(measurements.chromium!.length).toBe(measurements.webkit!.length);
      measurements.chromium!.forEach((control, index) => {
        const other = measurements.webkit![index];
        expect(control.appearance).toBe('none');
        expect(other.appearance, `${other.label}: ${JSON.stringify(other)}`).toBe('none');
        expect(other.radius).toBe(control.radius);
        expect(Math.abs(other.width - control.width)).toBeLessThan(2);
        expect(Math.abs(other.height - control.height)).toBeLessThan(2);
      });
    });
  }
}
