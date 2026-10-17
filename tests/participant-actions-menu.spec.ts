import { test, expect, type Page, type Browser } from '@playwright/test';
import { newRoomCode, roomUrlFor } from './utils/env';

const row = (page: Page, name: string) => page.locator('#liveParticipantList .participant-row').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) });
function commands(page: Page) {
  const sent: string[] = [];
  page.on('websocket', socket => socket.on('framesent', frame => {
    const payload = String(frame.payload);
    if (/^(makeHost|kick|setSpectator|setParticipating):/.test(payload)) sent.push(payload);
  }));
  return sent;
}
async function pair(browser: Browser, width = 1280, theme = 'light', touch = false) {
  const hostContext = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch });
  const guestContext = await browser.newContext();
  await hostContext.addInitScript(mode => localStorage.setItem('planningpoker-theme', mode), theme);
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const hostSent = commands(host), guestSent = commands(guest);
  const code = newRoomCode('ACTIONS');
  await host.goto(`${roomUrlFor('Host', code)}&lang=en&theme=${theme}`);
  await expect(row(host, 'Host')).toHaveClass(/is-host/);
  await guest.goto(`${roomUrlFor('Guest', code)}&lang=en`);
  await expect(row(host, 'Guest')).toBeVisible();
  return { host, guest, hostSent, guestSent, close: async () => { await hostContext.close(); await guestContext.close(); } };
}

test('mouse: spectator round trip, cancelled/accepted transfer, new host kick and permissions', async ({ browser }) => {
  const p = await pair(browser);
  const { host, guest, hostSent, guestSent } = p;
  try {
    await expect(row(host, 'Host').locator('.participant-more')).toHaveCount(0);
    await expect(guest.locator('.participant-more')).toHaveCount(0);
    await row(host, 'Guest').locator('.participant-more').click();
    await expect(host.locator('.participant-action-icon')).toHaveCount(3);
    for (const action of ['host', 'spectator', 'kick']) {
      await expect(host.locator(`.participant-action-menu [data-action="${action}"] .participant-action-icon[data-icon="${action}"]`)).toHaveCount(1);
    }
    await expect(host.locator('.participant-action-menu [data-action="kick"] use')).toHaveAttribute('href', '#pp-icon-exit');
    await host.getByRole('menuitem', { name: 'Make spectator', exact: true }).click();
    await expect(row(guest, 'Guest')).toHaveClass(/spectator/);
    await expect(guest.locator('.participant-more, [role="menu"]')).toHaveCount(0);
    await expect.poll(() => hostSent).toEqual(['setSpectator:Guest:true']);
    await row(host, 'Guest').locator('.participant-more').click();
    await host.getByRole('menuitem', { name: 'Restore participation' }).click();
    await expect(row(guest, 'Guest')).not.toHaveClass(/spectator/);
    await expect.poll(() => hostSent).toEqual(['setSpectator:Guest:true', 'setSpectator:Guest:false']);

    await row(host, 'Guest').locator('.participant-more').click();
    host.once('dialog', dialog => dialog.dismiss());
    await host.getByRole('menuitem', { name: 'Make host', exact: true }).click();
    await expect(row(host, 'Host')).toHaveClass(/is-host/);
    expect(hostSent).toHaveLength(2);
    await expect(row(host, 'Guest').locator('.participant-more')).toBeFocused();
    await row(host, 'Guest').locator('.participant-more').click();
    host.once('dialog', dialog => dialog.accept());
    await host.getByRole('menuitem', { name: 'Make host', exact: true }).click();
    await expect(row(guest, 'Guest')).toHaveClass(/is-host/);
    await expect(host.locator('.participant-more, [role="menu"]')).toHaveCount(0);
    await expect(row(guest, 'Guest').locator('.participant-more')).toHaveCount(0);
    await expect.poll(() => hostSent).toEqual(['setSpectator:Guest:true', 'setSpectator:Guest:false', 'makeHost:Guest']);
    await row(guest, 'Host').locator('.participant-more').click();
    guest.once('dialog', dialog => dialog.dismiss());
    await guest.getByRole('menuitem', { name: 'Remove from room' }).click();
    expect(guestSent).toEqual([]);
    await row(guest, 'Host').locator('.participant-more').click();
    guest.once('dialog', dialog => dialog.accept());
    await guest.getByRole('menuitem', { name: 'Remove from room' }).click();
    await expect(row(guest, 'Host')).toHaveCount(0);
    await expect.poll(() => guestSent).toEqual(['kick:Host']);
    await expect(host).not.toHaveURL(/\/room\?/);
  } finally { await p.close(); }
});

test('keyboard: single execution, dismissal/focus, rerender and reconnect', async ({ browser }) => {
  const p = await pair(browser);
  const { host, guest, hostSent } = p;
  try {
    const more = row(host, 'Guest').locator('.participant-more');
    await more.focus();
    await host.keyboard.press('Enter');
    await expect(host.getByRole('menuitem', { name: 'Make host', exact: true })).toBeFocused();
    await host.keyboard.press('ArrowDown');
    await host.keyboard.press('Space');
    await expect(row(guest, 'Guest')).toHaveClass(/spectator/);
    await expect(more).toBeFocused();
    await host.keyboard.press('Space');
    await host.keyboard.press('ArrowDown');
    await host.keyboard.press('Enter');
    await expect(row(guest, 'Guest')).not.toHaveClass(/spectator/);
    await expect.poll(() => hostSent).toEqual(['setSpectator:Guest:true', 'setSpectator:Guest:false']);
    await more.press('ArrowUp');
    await expect(host.getByRole('menuitem', { name: 'Remove from room' })).toBeFocused();
    await host.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await more.click();
    await host.keyboard.press('Tab');
    await expect(host.getByRole('menu')).toHaveCount(0);
    await more.click();
    await host.locator('.participant-heading').click();
    await expect(host.getByRole('menu')).toHaveCount(0);
    await more.click();
    await guest.locator('#cardGrid button[data-value="3"]').click();
    await expect(host.getByRole('menu')).toHaveCount(0);
    await expect(more).toBeFocused();
    await host.evaluate(() => (window as any).__ppWs.close(4002, 'menu-test'));
    await expect.poll(() => host.evaluate(() => (window as any).__ppWs.readyState)).toBe(1);
    await more.click();
    await expect(host.getByRole('menuitem')).toHaveCount(3);
    expect(hostSent).toHaveLength(2);
  } finally { await p.close(); }
});

test('guest/spectator and forged self targets cannot invoke the action UI', async ({ browser }) => {
  const p = await pair(browser);
  try {
    const { host, guest, guestSent, hostSent } = p;
    async function forge(page: Page, target: string) {
      await page.evaluate(name => {
        const button = document.createElement('button');
        button.className = 'participant-more'; button.dataset.name = name;
        document.querySelector('#liveParticipantList')!.appendChild(button);
        button.click(); button.remove();
      }, target);
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
    await forge(guest, 'Host');
    await forge(host, 'Host');
    expect(hostSent).toEqual([]); expect(guestSent).toEqual([]);
    await row(host, 'Guest').locator('.participant-more').click();
    await host.getByRole('menuitem', { name: 'Make spectator', exact: true }).click();
    await expect(row(guest, 'Guest')).toHaveClass(/spectator/);
    await forge(guest, 'Host');
    expect(guestSent).toEqual([]);
    // The server also rejects a command submitted directly by a non-host.
    await guest.evaluate(() => (window as any).__ppWs.send('makeHost:Guest'));
    await guest.evaluate(() => (window as any).__ppWs.send('setSpectator:Host:true'));
    await guest.evaluate(() => (window as any).__ppWs.send('kick:Host'));
    await guest.reload();
    await expect(row(guest, 'Host')).toHaveClass(/is-host/);
    await expect(row(guest, 'Host')).not.toHaveClass(/spectator/);
    await expect(guest.locator('.participant-more')).toHaveCount(0);
    // Participation state does not remove host permissions.
    await host.locator('#menuButton').click();
    await host.locator('#menuParticipationToggle').uncheck({ force: true });
    await host.locator('#menuCloseButton').click();
    await expect(row(host, 'Host')).toHaveClass(/spectator/);
    await expect(row(host, 'Host')).toHaveClass(/is-host/);
    await expect(row(host, 'Guest').locator('.participant-more')).toBeVisible();
    await forge(host, 'Host');

    // The host can still manage another participant while not estimating.
    await row(host, 'Guest').locator('.participant-more').click();
    await host.getByRole('menuitem', { name: 'Restore participation' }).click();
    await expect(row(guest, 'Guest')).not.toHaveClass(/spectator/);
    await expect.poll(() => hostSent).toEqual(['setSpectator:Guest:true', 'setSpectator:Guest:false']);

    // The state and permissions survive the regular refresh/rejoin path.
    await host.reload();
    await expect(row(host, 'Host')).toHaveClass(/spectator/);
    await expect(row(host, 'Host')).toHaveClass(/is-host/);
    await expect(row(host, 'Guest').locator('.participant-more')).toBeVisible();

    // Re-enabling estimation leaves the same host permissions in place.
    await host.locator('#menuButton').click();
    await host.locator('#menuParticipationToggle').check({ force: true });
    await host.locator('#menuCloseButton').click();
    await expect(row(host, 'Host')).not.toHaveClass(/spectator/);
    await expect(row(host, 'Guest').locator('.participant-more')).toBeVisible();
  } finally { await p.close(); }
});

for (const width of [320, 375, 768, 769, 1280]) {
  test(`menu fits and remains operable at ${width}px`, async ({ browser }, testInfo) => {
    const p = await pair(browser, width, width < 769 ? 'dark' : 'light', width <= 768);
    try {
      if (width === 375) {
        await p.host.evaluate(() => localStorage.setItem('lang', 'de'));
        await p.host.reload();
        await expect(row(p.host, 'Host')).toHaveClass(/is-host/);
      }
      const more = row(p.host, 'Guest').locator('.participant-more');
      await expect(p.host.locator('html')).toHaveAttribute('data-theme', width < 769 ? 'dark' : 'light');
      if (width === 375) await expect(more).toHaveAttribute('aria-label', 'Teilnehmeraktionen: Guest');
      if (width <= 768) await more.tap(); else await more.click();
      await expect(p.host.getByRole('menuitem')).toHaveCount(3);
      if (width === 375) {
        await expect(p.host.getByRole('menuitem', { name: 'Zum Zuschauer machen' })).toBeVisible();
        await expect(p.host.getByRole('menuitem', { name: 'Aus dem Raum entfernen' })).toBeVisible();
      }
      if (width === 320 || width === 1280) await p.host.screenshot({ path: testInfo.outputPath('menu.png') });
      const geometry = await p.host.getByRole('menu').evaluate(menu => {
        const r = menu.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.width);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      await p.host.keyboard.press('Escape');
      await expect(more).toBeFocused();
      // Place the final row near the viewport bottom to exercise upward opening.
      await p.host.setViewportSize({ width, height: 400 });
      await more.scrollIntoViewIfNeeded();
      await more.click();
      await expect(p.host.getByRole('menu')).toBeVisible();
      const r = await p.host.getByRole('menu').boundingBox();
      expect(r!.y).toBeGreaterThanOrEqual(0);
      expect(r!.y + r!.height).toBeLessThanOrEqual(400);
      if (width === 320) {
        await p.host.getByRole('menuitem', { name: 'Make spectator', exact: true }).tap();
        await expect(row(p.guest, 'Guest')).toHaveClass(/spectator/);
        expect(p.hostSent).toEqual(['setSpectator:Guest:true']);
      }
    } finally { await p.close(); }
  });
}
