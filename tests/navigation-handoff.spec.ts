import { test, expect, chromium, webkit, type Page } from '@playwright/test';
import { newRoomCode, roomUrlFor } from './utils/env';

async function waitForParticipant(page: Page, name: string, property: string, expected: unknown) {
  await expect.poll(() => page.evaluate(({ participantName, key, value }) => {
    const updates = (window as any).__ppVU || [];
    for (let index = updates.length - 1; index >= 0; index--) {
      const participant = updates[index]?.participants?.find((item: any) => item.name === participantName);
      if (participant) return participant[key] === value;
    }
    return false;
  }, { participantName: name, key: property, value: expected })).toBe(true);
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`${engine}: authenticated navigation handoff preserves state and host actions`, async () => {
    const browser = await (engine === 'chromium' ? chromium : webkit).launch();
    const page = await browser.newPage();
    const room = newRoomCode('HANDOFF');
    const identityEvents: string[] = [];
    page.on('websocket', socket => socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.type === 'identityReady' || message.type === 'identityError') {
          identityEvents.push(message.type + ':' + (message.reason || ''));
        }
      } catch {}
    }));

    try {
      await page.goto(roomUrlFor('Navigator', room));
      await expect(page.locator('.participant-row.is-host')).toContainText('Navigator');
      await page.evaluate(() => (window as any).__ppWs.send('participation:false'));
      await waitForParticipant(page, 'Navigator', 'spectator', true);

      for (let index = 0; index < 3; index++) {
        const readyBefore = identityEvents.filter(event => event === 'identityReady:').length;
        await page.locator('footer a[href="/"]').click();
        await expect(page.locator('#roomReturnLink')).toBeVisible();
        await page.locator('#roomReturnLink').click();
        await expect.poll(() => identityEvents.filter(event => event === 'identityReady:').length).toBeGreaterThan(readyBefore);
        await expect(page.locator('.participant-row.is-host')).toContainText('Navigator');
        await waitForParticipant(page, 'Navigator', 'spectator', true);
      }

      expect(identityEvents).not.toContain('identityError:activeElsewhere');
      await page.evaluate(() => (window as any).__ppWs.send('participation:true'));
      await page.locator('#cardGrid button[data-value="5"]').click();
      await waitForParticipant(page, 'Navigator', 'vote', '5');
      await expect(page.locator('#revealButton')).toBeEnabled();
      await page.locator('#revealButton').click();
      await expect(page.locator('#resetButton')).toBeVisible();

      await page.reload();
      await expect(page.locator('.participant-row.is-host')).toContainText('Navigator');
    } finally {
      await browser.close();
    }
  });
}

test('lost navigationReleased acknowledgement falls through the bounded timeout', async ({ page }) => {
  const room = newRoomCode('HANDOFFACK');
  await page.goto(roomUrlFor('AckLoss', room));
  await expect(page.locator('.participant-row.is-host')).toContainText('AckLoss');
  await page.evaluate(() => {
    const socket = (window as any).__ppWs as WebSocket;
    const original = socket.onmessage;
    socket.onmessage = function (event) {
      try { if (JSON.parse(String(event.data)).type === 'navigationReleased') return; } catch {}
      return original?.call(socket, event);
    };
  });

  const started = Date.now();
  const navigated = page.waitForURL(/\/$/);
  await page.locator('footer a[href="/"]').click();
  await navigated;
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(350);
  expect(elapsed).toBeLessThan(2_000);
  await page.locator('#roomReturnLink').click();
  await expect(page.locator('.participant-row.is-host')).toContainText('AckLoss');
});

for (const engine of ['chromium', 'webkit'] as const) {
  test(`${engine}: Back and Forward preserve an authenticated same-tab return`, async () => {
    const browser = await (engine === 'chromium' ? chromium : webkit).launch();
    const page = await browser.newPage();
    try {
      const room = newRoomCode('HISTORY');
      await page.goto(roomUrlFor('History', room));
      await expect(page.locator('.participant-row.is-host')).toContainText('History');
      await page.locator('footer a[href="/about"]').click();
      await expect(page).toHaveURL(/\/about$/);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('.participant-row.is-host')).toContainText('History');
      await page.goForward({ waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/about$/);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('.participant-row.is-host')).toContainText('History');
    } finally {
      await browser.close();
    }
  });
}
