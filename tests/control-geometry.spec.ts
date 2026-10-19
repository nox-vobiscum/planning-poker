import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { newRoomCode, roomUrlFor } from './utils/env';

type ControlMeasurement = {
  label: string | null;
  width: number;
  height: number;
  radius: string;
  appearance: string;
};

// Compare the same controls and state across engines, not font rasterization.
for (const width of [375, 768, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`control geometry ${theme} at ${width}px`, async ({ page, browserName }, testInfo) => {
          await page.setViewportSize({ width, height: 900 });
          await page.addInitScript(({ theme }) => {
            localStorage.setItem('planningpoker-theme', theme);
          }, { theme });
          await page.goto(roomUrlFor('Host', newRoomCode(`GEO-${browserName[0]}`)));
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
          await page.screenshot({ path: testInfo.outputPath(`${browserName}-room.png`), fullPage: true });
          if (width <= 768) await page.locator('#menuButton').click();
          const themeDark = width <= 768 ? '#themeDark' : '#hcThemeDark';
          const themeSystem = width <= 768 ? '#themeSystem' : '#hcThemeSystem';
          await page.locator(themeSystem).focus();
          await page.keyboard.press('Shift+Tab');
          await expect(page.locator(themeDark)).toHaveCSS('outline-style', 'solid');
          await page.mouse.move(0, 0);
          // Query and measure atomically: WebSocket updates can replace card nodes.
          const measurements: ControlMeasurement[] = await page.evaluate(({ themeDark, themeSystem }) => Array.from(document.querySelectorAll(`#cardGrid button,#revealButton,#menuButton,#copyRoomLink,${themeDark},${themeSystem}`), el => {
            const css = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return { label: el.id || el.textContent, width: rect.width, height: rect.height, radius: css.borderRadius, appearance: css.appearance };
          }), { themeDark, themeSystem });
          await page.screenshot({ path: testInfo.outputPath(`${browserName}-menu.png`) });

      const baselineDir = path.join(testInfo.project.outputDir, 'control-geometry-baseline');
      const baselinePath = path.join(baselineDir, `${theme}-${width}.json`);
      if (browserName === 'chromium') {
        await mkdir(baselineDir, { recursive: true });
        await writeFile(baselinePath, JSON.stringify(measurements), 'utf8');
      } else {
        const baseline: ControlMeasurement[] = JSON.parse(await readFile(baselinePath, 'utf8'));
        expect(measurements.length).toBe(baseline.length);
        baseline.forEach((control, index) => {
          const other = measurements[index]!;
        expect(control.appearance).toBe('none');
        expect(other.appearance, `${other.label}: ${JSON.stringify(other)}`).toBe('none');
        expect(other.radius).toBe(control.radius);
        expect(Math.abs(other.width - control.width)).toBeLessThan(2);
        expect(Math.abs(other.height - control.height)).toBeLessThan(2);
        });
      }
      measurements.forEach(control => expect(control.appearance).toBe('none'));
    });
  }
}
