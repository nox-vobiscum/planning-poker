import { test, expect, chromium, webkit } from '@playwright/test';
import { baseUrl, newRoomCode, roomUrlFor } from './utils/env';

for (const engine of ['chromium', 'webkit'] as const) {
  test(`${engine}: lost exit acknowledgement completes on the revoked proof without duplicate participation`, async () => {
    const browser = await (engine === 'chromium' ? chromium : webkit).launch();
    try {
      const room = newRoomCode('EXIT-RETRY');
      const firstContext = await browser.newContext();
      const first = await firstContext.newPage();
      await first.goto(roomUrlFor('Leaver', room));
      await expect(first.locator('#liveParticipantList .name')).toHaveText(['Leaver']);
      const proof = await first.evaluate(r => (window as any).PPIdentity.read(r), room);
      await first.locator('#leaveRoomBtn').click();
      await expect(first).toHaveURL(/\/$/);

      // Recreate the client state from the instant before the acknowledgement arrived.
      const retryContext = await browser.newContext();
      const retry = await retryContext.newPage();
      await retry.goto(baseUrl + '/');
      await retry.evaluate(({ room, proof }) => {
        (window as any).PPIdentity.save(room, proof);
        (window as any).PPIdentity.markExit(room, proof);
      }, { room, proof });
      await retry.goto(roomUrlFor('Leaver', room));
      await expect(retry).toHaveURL(/\/$/);
      expect(await retry.evaluate(r => (window as any).PPIdentity.read(r), room)).toBeNull();
      expect(await retry.evaluate(r => localStorage.getItem('pp-identity-exit-v1:' + encodeURIComponent(r)), room)).toBeNull();

      const replacementContext = await browser.newContext();
      const replacement = await replacementContext.newPage();
      await replacement.goto(roomUrlFor('Leaver', room));
      await expect(replacement.locator('#liveParticipantList .name')).toHaveText(['Leaver']);
      expect((await replacement.evaluate(r => (window as any).PPIdentity.read(r), room)).participantId)
        .not.toBe(proof.participantId);

      // If the original command never arrived, the durable marker retries it after resume.
      const pendingRoom = newRoomCode('EXIT-PENDING');
      const pendingContext = await browser.newContext();
      const pending = await pendingContext.newPage();
      await pending.goto(roomUrlFor('Pending', pendingRoom));
      await expect(pending.locator('#liveParticipantList .name')).toHaveText(['Pending']);
      const pendingProof = await pending.evaluate(r => (window as any).PPIdentity.read(r), pendingRoom);
      await pendingContext.close();
      const retryPendingContext = await browser.newContext();
      const retryPending = await retryPendingContext.newPage();
      await retryPending.goto(baseUrl + '/');
      await retryPending.evaluate(({ room, proof }) => {
        (window as any).PPIdentity.save(room, proof);
        (window as any).PPIdentity.markExit(room, proof);
      }, { room: pendingRoom, proof: pendingProof });
      await retryPending.goto(roomUrlFor('Stale display name', pendingRoom));
      await expect(retryPending).toHaveURL(/\/$/);
      expect(await retryPending.evaluate(r => (window as any).PPIdentity.read(r), pendingRoom)).toBeNull();
    } finally {
      await browser.close();
    }
  });
}

test('storage fallback is explicit and keeps the current participation usable', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('pp-identity-')) throw new Error('identity storage denied');
      return original.call(this, key, value);
    };
  });
  await page.goto(roomUrlFor('Memory only', newRoomCode('STORAGE')) + '&lang=en');
  await expect(page.locator('.toast')).toContainText('cannot be restored after reloading');
  await expect(page.locator('#cardGrid button').first()).toBeEnabled();
  expect(await page.evaluate(() => (window as any).PPIdentity.read(
    new URL(location.href).searchParams.get('roomCode'))?.participantId)).toBeTruthy();
});
