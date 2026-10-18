import { test, expect, chromium, webkit } from '@playwright/test';
import { newRoomCode, roomUrlFor } from './utils/env';

for (const browserName of ['chromium', 'webkit'] as const) {
  test.describe(browserName, () => {
    test('identity proof survives reload; a parallel tab is refused; exit permits a fresh identity', async () => {
      const browser = await (browserName === 'chromium' ? chromium : webkit).launch();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
      const room = newRoomCode('IDENTITY');
      const url = roomUrlFor('Host', room);
      const ownRow = page.locator('.participant-row').filter({ has: page.locator('.name', { hasText: /^Host$/ }) });
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('websocket', socket => expect(new URL(socket.url()).search).toBe(''));
      await page.goto(url);
      await expect(ownRow).toHaveClass(/is-host/);
      const participantId = await page.evaluate(r => (window as any).PPIdentity.read(r).participantId, room);
      await page.reload();
      await expect(ownRow).toHaveClass(/is-host/);
      expect(await page.evaluate(r => (window as any).PPIdentity.read(r).participantId, room)).toBe(participantId);
      // Credential frames are intercepted before the app's generic debug history.
      expect(await page.evaluate(() => ((window as any).__ppVU || []).some((m: any) => m.token))).toBe(false);
      const duplicate = await context.newPage();
      let duplicateReason = '';
      duplicate.on('websocket', socket => socket.on('framereceived', frame => {
        try { const m = JSON.parse(String(frame.payload)); if (m.type === 'identityError') duplicateReason = m.reason; } catch {}
      }));
      await duplicate.goto(url);
      await expect.poll(() => duplicateReason).toBe('activeElsewhere');
      await duplicate.close();
      await page.locator('#leaveRoomBtn').click();
      await expect(page).toHaveURL(/\/$/);
      expect(await page.evaluate(r => localStorage.getItem('pp-identity-v2:' + encodeURIComponent(r)), room)).toBeNull();
      // A direct New Join is expected here; entry-form unification is step 3.
      await page.goto(url);
      await expect(ownRow).toHaveClass(/is-host/);
      const next = await page.evaluate(r => (window as any).PPIdentity.read(r).participantId, room);
      expect(next).not.toBe(participantId);
      expect(errors).toEqual([]);
      } finally { await browser.close(); }
    });
  });
}