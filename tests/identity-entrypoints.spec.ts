import { test, expect, chromium, webkit, type Page } from '@playwright/test';
import { baseUrl, newRoomCode, roomUrlFor } from './utils/env';

const names = (page: Page) => page.locator('#liveParticipantList .name');
const proof = (page: Page, room: string) => page.evaluate(r => (window as any).PPIdentity.read(r), room);
const command = (page: Page, value: string) => page.evaluate(v => (window as any).__ppWs.send(v), value);

for (const engine of ['chromium', 'webkit'] as const) {
  test.describe(engine + ' identity entry points', () => {
    test('home, invite, preflight and browser restart resume canonical identity and state', async () => {
      test.setTimeout(60_000);
      const browser = await (engine === 'chromium' ? chromium : webkit).launch();
      try {
        const room = newRoomCode('ENTRY');
        const hostContext = await browser.newContext();
        const guestContext = await browser.newContext();
        const host = await hostContext.newPage();
        const guest = await guestContext.newPage();
        let participants: any[] = [];
        host.on('websocket', socket => socket.on('framereceived', frame => {
          try {
            const data = JSON.parse(String(frame.payload));
            if (data.type === 'voteUpdate') participants = data.participants;
          } catch {}
        }));
        let nameQueries = 0;
        guest.on('request', request => {
          if (/name-(taken|available)/.test(request.url())) nameQueries++;
        });
        await host.goto(roomUrlFor('Host', room));
        await expect(names(host)).toHaveText(['Host']);
        await guest.goto(roomUrlFor('Original', room));
        await expect(names(guest)).toHaveCount(2);
        const original = await proof(guest, room);
        await command(guest, 'rename:Canonical');
        await expect(names(host)).toContainText(['Host', 'Canonical']);
        await command(guest, 'vote:Canonical:5');
        await expect.poll(() => participants.find(p => p.name === 'Canonical')?.vote).toBe('5');

        await guest.goto(baseUrl + '/');
        await expect.poll(() => participants.find(p => p.name === 'Canonical')?.disconnected).toBe(true);
        await guest.locator('#nameInput').fill('Outdated form name');
        await guest.locator('#roomInput').fill(room);
        await guest.locator('button[type=submit]').click();
        await expect(guest.locator('#youName')).toHaveText('Canonical');
        await expect(guest).toHaveURL(roomUrlFor('Canonical', room));
        expect((await proof(guest, room)).participantId).toBe(original.participantId);
        await expect.poll(() => participants.find(p => p.name === 'Canonical')?.vote).toBe('5');

        await command(guest, 'participation:false');
        await expect(guest.locator('.participant-row.spectator .name')).toHaveText('Canonical');
        await guest.goto(baseUrl + '/invite?roomCode=' + room);
        await expect.poll(() => participants.find(p => p.name === 'Canonical')?.disconnected).toBe(true);
        await guest.locator('[name=participantName]').fill('Another old name');
        await guest.locator('button[type=submit]').click();
        await expect(guest.locator('#youName')).toHaveText('Canonical');
        await expect(guest.locator('.participant-row.spectator .name')).toHaveText('Canonical');
        expect(nameQueries).toBe(0);

        await guest.goto(roomUrlFor('Stale URL', room) + '&preflight=1');
        await expect(guest.locator('#youName')).toHaveText('Canonical');
        await expect(guest.locator('.participant-row.spectator .name')).toHaveText('Canonical');
        await guest.reload();
        await expect(guest.locator('.participant-row.spectator .name')).toHaveText('Canonical');
        await guest.goto(baseUrl + '/about');
        await guest.goBack();
        await expect(guest.locator('.participant-row.spectator .name')).toHaveText('Canonical');

        const storageState = await guestContext.storageState();
        await guestContext.close();
        await expect.poll(() => participants.find(p => p.name === 'Canonical')?.disconnected).toBe(true);
        const restarted = await browser.newContext({ storageState });
        const freshPage = await restarted.newPage();
        await freshPage.goto(baseUrl + '/');
        expect(await freshPage.evaluate(() => sessionStorage.getItem('pp-room-return'))).toBeNull();
        await freshPage.locator('#nameInput').fill('Canonical');
        await freshPage.locator('#roomInput').fill(room);
        await freshPage.locator('button[type=submit]').click();
        await expect(freshPage.locator('.participant-row.spectator .name')).toHaveText('Canonical');
        expect((await proof(freshPage, room)).participantId).toBe(original.participantId);
        await expect(names(host)).toHaveCount(2);
      } finally { await browser.close(); }
    });

    test('invalid proof requires deliberate new join; names do not restore identity; other rooms are isolated', async () => {
      const browser = await (engine === 'chromium' ? chromium : webkit).launch();
      try {
        const room = newRoomCode('INVALID');
        const otherRoom = newRoomCode('OTHER');
        const ownerContext = await browser.newContext();
        const owner = await ownerContext.newPage();
        await owner.goto(roomUrlFor('Taken', room));
        await expect(names(owner)).toHaveText(['Taken']);
        const strangerContext = await browser.newContext();
        const stranger = await strangerContext.newPage();
        await stranger.goto(baseUrl + '/');
        const invalid = {
          roomInstanceId: '00000000-0000-0000-0000-000000000001',
          participantId: '00000000-0000-0000-0000-000000000002',
          token: 'x'.repeat(43),
        };
        await stranger.evaluate(({ room, otherRoom, invalid }) => {
          (window as any).PPIdentity.save(room, invalid);
          (window as any).PPIdentity.save(otherRoom, invalid);
        }, { room, otherRoom, invalid });
        await stranger.goto(roomUrlFor('Taken', room) + '&preflight=1');
        await expect(stranger).toHaveURL(/rejoin=invalid/);
        await expect(stranger.locator('#nameCheckNotice')).toBeVisible();
        await expect(stranger.locator('#roomReturn')).toBeHidden();
        expect(await proof(stranger, room)).toBeNull();
        expect(await proof(stranger, otherRoom)).toEqual(invalid);
        await expect(names(owner)).toHaveText(['Taken']);
        // Without a proof, the same name is still unavailable and creates no participant.
        await stranger.locator('button[type=submit]').click();
        await expect(stranger.locator('#nameCheckNotice')).toContainText('Taken (2)');
        await expect(names(owner)).toHaveText(['Taken']);
        await stranger.locator('[name=participantName]').fill('New participant');
        await stranger.locator('button[type=submit]').click();
        await expect(names(stranger)).toHaveCount(2);
        expect((await proof(stranger, room)).participantId).not.toBe(invalid.participantId);
        expect((await proof(owner, room)).participantId).not.toBe((await proof(stranger, room)).participantId);

        // An old page's rejection must not delete a newer proof in shared storage.
        expect(await stranger.evaluate(({ room, invalid }) => {
          const current = (window as any).PPIdentity.read(room);
          (window as any).PPIdentity.clear(room, invalid);
          return JSON.parse(localStorage.getItem('pp-identity-v2:' + encodeURIComponent(room))!).token === current.token;
        }, { room, invalid })).toBe(true);
      } finally { await browser.close(); }
    });

    test('stale form responses cannot submit changed room/name or replace current feedback', async () => {
      const browser = await (engine === 'chromium' ? chromium : webkit).launch();
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        for (const path of ['/', '/invite?roomCode=STALE']) {
          let release!: () => void;
          let requested!: () => void;
          const started = new Promise<void>(resolve => { requested = resolve; });
          const waiting = new Promise<void>(resolve => { release = resolve; });
          await page.route('**/api/rooms/**', async route => {
            requested();
            await waiting;
            await route.fulfill({ json: path === '/' ? true : { available: false, suggestion: 'Old (2)' } });
          });
          let dialogs = 0;
          const dismiss = async (dialog: any) => { dialogs++; await dialog.dismiss(); };
          page.on('dialog', dismiss);
          await page.goto(baseUrl + path);
          await page.locator('[name=participantName]').fill('Old');
          if (path === '/') await page.locator('[name=roomCode]').fill('STALE');
          await page.locator('button[type=submit]').click();
          await started;
          await page.locator('[name=participantName]').fill('Current');
          if (path === '/') await page.locator('[name=roomCode]').fill('OTHER');
          const response = page.waitForResponse(response => response.url().includes('/api/rooms/'));
          release();
          await response;
          // Let the response handler settle without a fixed network/timing sleep.
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await expect(page.locator('[name=participantName]')).toHaveValue('Current');
          await expect(page.locator('#nameCheckNotice')).toHaveCount(0);
          expect(dialogs).toBe(0);
          expect(new URL(page.url()).pathname).toBe(path === '/' ? '/' : '/invite');
          page.off('dialog', dismiss);
          await page.unroute('**/api/rooms/**');
        }
      } finally { await browser.close(); }
    });
  });
}