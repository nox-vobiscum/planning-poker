import { test, expect } from '@playwright/test';
import { newRoomCode, roomUrlFor } from './utils/env';

const switches = [
  ['menuAutoRevealToggle', 'auto-reveal-toggle', 'on'],
  ['menuTopicToggle', 'topic-toggle', 'on'],
  ['menuSpecialsToggle', 'specials-toggle', 'on'],
  ['menuHardModeToggle', 'hard-mode-toggle', 'on'],
  ['menuParticipationToggle', 'participation-toggle', 'estimating'],
] as const;

  for (const width of [320, 1280]) {
    test(`${width}: responsive switches, keyboard events and guest permissions`, async ({ browser, browserName }, testInfo) => {

      const theme = browserName === 'chromium' ? 'dark' : 'light';
      const hostContext = await browser.newContext({ viewport: { width, height: 720 }, reducedMotion: 'reduce' });
      const guestContext = await browser.newContext({ viewport: { width, height: 720 }, reducedMotion: 'reduce' });
      try {
        for (const context of [hostContext, guestContext]) {
          await context.addInitScript(({ theme }) => {
            localStorage.setItem('planningpoker-theme', theme);
            localStorage.setItem('lang', 'de');
          }, { theme });
        }
        const host = await hostContext.newPage();
        const guest = await guestContext.newPage();
        const room = newRoomCode('MR009');
        await host.goto(roomUrlFor('Host', room));
        await expect(host.locator('body')).toHaveClass(/is-host/);
        await guest.goto(roomUrlFor('Guest', room));
        await expect(host.locator('#liveParticipantList .participant-row')).toHaveCount(2);
        for (const page of [host, guest]) {
          await page.locator('#menuButton').click();
          await page.evaluate(switches => {
            (window as any).__toggleEvents = [];
            for (const [, name] of switches) {
              document.addEventListener('pp:' + name, e => {
                (window as any).__toggleEvents.push({ name, detail: (e as CustomEvent).detail });
              });
            }
          }, switches);
        }
        for (const [id, name, payloadKey] of switches) {
          const input = host.locator('#' + id);
          const row = input.locator('..');
          await expect(input).toBeEnabled();
          await expect(input).toHaveAccessibleName(/.+/);
          await input.scrollIntoViewIfNeeded();
          await host.mouse.move(0, 0);
          const text = (await row.locator('.switch-text').boundingBox())!;
          const box = (await input.boundingBox())!;
          expect(text.x + text.width).toBeLessThanOrEqual(box.x);
          expect(box.x + box.width).toBeLessThan(width);
          expect(box.width).toBe(42);
          await expect(input).toHaveCSS('height', '24px');
          expect(box.height).toBeCloseTo(24, 3);
          await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

          const before = await input.isChecked();
          await input.focus();
          await host.keyboard.press('Shift+Tab');
          await host.keyboard.press('Tab');
          await expect(input).toBeFocused();
          await expect(input).toHaveCSS('outline-style', 'solid');
          await host.keyboard.press('Space');
          await expect(input).toBeChecked({ checked: !before });
          await expect(input).toHaveAttribute('aria-checked', String(!before));
          expect(await host.evaluate(name => (window as any).__toggleEvents.filter(
            (e: any) => e.name === name), name)).toEqual([{ name, detail: { [payloadKey]: !before } }]);
          // The existing large row target must still dispatch once, just like the native input.
          await row.locator('.switch-text strong').click();
          await expect(input).toBeChecked({ checked: before });
          expect(await host.evaluate(name => (window as any).__toggleEvents.filter(
            (e: any) => e.name === name), name)).toEqual([
            { name, detail: { [payloadKey]: !before } }, { name, detail: { [payloadKey]: before } },
          ]);
          // Both positions have a visible track and a centered, contrasting thumb.
          const css = await input.evaluate(el => {
            const track = getComputedStyle(el), thumb = getComputedStyle(el, '::after');
            return { track: track.backgroundColor, thumb: thumb.backgroundColor, top: thumb.top, transition: thumb.transitionDuration };
          });
          expect(css.track).not.toBe('rgba(0, 0, 0, 0)');
          expect(css.track).not.toBe(css.thumb);
          expect(css.top).toBe('2px');
          expect(css.transition).toBe('0s');
          const guestInput = guest.locator('#' + id);
          if (id !== 'menuParticipationToggle') {
            await expect(guestInput).toBeDisabled();
            await expect(guestInput).toHaveAttribute('aria-disabled', 'true');
            const guestBefore = await guestInput.isChecked();
            await guestInput.locator('..').locator('.switch-text strong').click();
            await expect(guestInput).toBeChecked({ checked: guestBefore });
            expect(await guest.evaluate(name => (window as any).__toggleEvents.filter(
              (e: any) => e.name === name), name)).toEqual([]);
          } else {
            await expect(guestInput).toBeEnabled();
            await guestInput.focus();
            await guest.keyboard.press('Space');
            await expect(guestInput).not.toBeChecked();
            expect(await guest.evaluate(() => (window as any).__toggleEvents.filter(
              (e: any) => e.name === 'participation-toggle'))).toEqual([
              { name: 'participation-toggle', detail: { estimating: false } },
            ]);
          }
        }
        await host.mouse.move(0, 0);
        await host.locator('#menuAutoRevealToggle').scrollIntoViewIfNeeded();
        await host.screenshot({ path: testInfo.outputPath('switches.png'), animations: 'disabled' });
        expect(await host.locator('.menu-panel').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await host.keyboard.press('Escape');
        await expect(host.locator('#menuButton')).toBeFocused();
      } finally {
        await Promise.all([hostContext.close(), guestContext.close()]);
      }
    });
  }
