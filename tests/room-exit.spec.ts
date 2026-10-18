import { expect, test } from '@playwright/test';
import { newRoomCode, roomUrlFor } from './utils/env';

test('host leaves individually, guest inherits host role, and room stays open', async ({ browser }) => {
  const room = newRoomCode('EXIT');
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await host.goto(roomUrlFor('Host', room));
    await expect(host.locator('body')).toHaveClass(/is-host/);
    await guest.goto(roomUrlFor('Guest', room));
    await expect(host.locator('#liveParticipantList .participant-row')).toHaveCount(2);
    await guest.evaluate(() => {
      (window as any).__hostLeftEvents = 0;
      (window as any).__ppWs.addEventListener('message', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'participantLeft' && data.name === 'Host') (window as any).__hostLeftEvents++;
        } catch {}
      });
    });
    await host.locator('#menuButton').click();
    await expect(host.locator('#closeRoomBtn')).toBeVisible();
    await expect(host.locator('#menuLeaveRoomBtn')).toBeHidden();
    await host.locator('#menuCloseButton').click();
    await host.locator('#leaveRoomBtn').click();
    await expect(host).toHaveURL(/\/$/);
    await expect(host.locator('#roomReturn')).toBeHidden();
    await expect(guest.locator('body')).toHaveClass(/is-host/, { timeout: 12_000 });
    await expect(guest.locator('#cardGrid button').first()).toBeVisible();
    await expect(guest.locator('#liveParticipantList .participant-row').filter({
      has: guest.locator('.name', { hasText: /^Host$/ }),
    })).toHaveCount(0);
    expect(await guest.evaluate(() => (window as any).__hostLeftEvents)).toBe(1);
    await guest.locator('#menuButton').click();
    await expect(guest.locator('#closeRoomBtn')).toBeVisible();
    await expect(guest.locator('#menuLeaveRoomBtn')).toBeHidden();
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('guest menu leave uses individual navigation and preserves host room', async ({ browser }) => {
  const room = newRoomCode('EXIT');
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await host.goto(roomUrlFor('Host', room));
    await guest.goto(roomUrlFor('Guest', room));
    await expect(host.locator('#liveParticipantList .participant-row')).toHaveCount(2);
    await guest.locator('#menuButton').click();
    await expect(guest.locator('#menuLeaveRoomBtn')).toBeVisible();
    await expect(guest.locator('#menuLeaveRoomBtn')).toHaveAccessibleName('Leave room');
    await expect(guest.locator('#closeRoomBtn')).toBeHidden();
    for (const theme of ['light', 'dark', 'system'] as const) {
      const colors = await guest.evaluate(({ theme }) => {
        const ui = (window as typeof window & {
          PPUI: { setTheme: (value: string) => void };
        }).PPUI;
        ui.setTheme(theme);
        const appearance = (id: string) => {
          const css = getComputedStyle(document.getElementById(id)!);
          return [css.backgroundColor, css.borderColor, css.color];
        };
        return { bottom: appearance('leaveRoomBtn'), menu: appearance('menuLeaveRoomBtn') };
      }, { theme });
      expect(colors.menu, `${theme} leave action`).toEqual(colors.bottom);
    }
    await guest.locator('#menuLeaveRoomBtn').click();
    await expect(guest).toHaveURL(/\/$/);
    await expect(guest.locator('#roomReturn')).toBeHidden();
    await expect(host.locator('body')).toHaveClass(/is-host/);
    await expect(host.locator('#cardGrid button').first()).toBeVisible();
    await expect(host.locator('#liveParticipantList .participant-row').filter({ hasText: 'Guest' }))
      .toHaveCount(0);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('guest can leave through the bottom button with the keyboard', async ({ browser }) => {
  const room = newRoomCode('EXIT');
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await host.goto(roomUrlFor('Host', room));
    await guest.goto(roomUrlFor('Guest', room));
    await expect(host.locator('#liveParticipantList .participant-row')).toHaveCount(2);
    await guest.locator('#leaveRoomBtn').focus();
    await guest.keyboard.press('Enter');
    await expect(guest).toHaveURL(/\/$/);
    await expect(host.locator('body')).toHaveClass(/is-host/);
    await expect(host.locator('#cardGrid button').first()).toBeVisible();
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

for (const width of [375, 1280]) {
  test(`leave control is accessible and responsive at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${roomUrlFor('Host', newRoomCode('EXIT'))}&lang=de`);
    const leave = page.locator('#leaveRoomBtn');
    await expect(leave).toHaveAccessibleName('Raum verlassen');
    await expect(leave.locator('svg')).toBeVisible();
    await expect(leave.locator('use')).toHaveAttribute('href', '#pp-icon-exit');
    for (const theme of ['light', 'dark', 'system'] as const) {
      await page.evaluate(({ theme }) => {
        const ui = (window as typeof window & {
          PPUI: { setTheme: (value: string) => void };
        }).PPUI;
        ui.setTheme(theme);
      }, { theme });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await leave.scrollIntoViewIfNeeded();
      await expect(leave).toBeInViewport();
    }
    await leave.focus();
    await expect(leave).toBeFocused();
  });
}
