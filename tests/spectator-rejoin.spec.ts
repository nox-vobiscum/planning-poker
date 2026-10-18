import { expect, test, type Page } from '@playwright/test';
import { ensureMenuClosed, ensureMenuOpen } from './utils/helpers';
import { newRoomCode, roomUrlFor } from './utils/env';

const row = (page: Page, name: string) => page.locator('#liveParticipantList .participant-row').filter({
  has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }),
});

async function expectSpectator(page: Page, name: string, spectator: boolean) {
  const participant = row(page, name);
  await expect(participant).toBeVisible();
  if (spectator) await expect(participant).toHaveClass(/spectator/);
  else await expect(participant).not.toHaveClass(/spectator/);
}

async function hostSetsSpectator(host: Page, name: string, spectator: boolean) {
  await row(host, name).locator('.participant-more').click();
  await host.getByRole('menuitem', {
    name: spectator ? 'Make spectator' : 'Restore participation',
    exact: true,
  }).click();
}

test('spectator state follows the existing identity through refresh, back navigation and reconnect', async ({ browser }) => {
  const room = newRoomCode('SPECTATOR-REJOIN');
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const newContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const newcomer = await newContext.newPage();
  const hostCommands: string[] = [];
  const guestCommands: string[] = [];
  let guestSockets = 0;

  host.on('websocket', socket => socket.on('framesent', frame => {
    const payload = String(frame.payload);
    if (payload.startsWith('setSpectator:')) hostCommands.push(payload);
  }));
  guest.on('websocket', socket => {
    guestSockets++;
    socket.on('framesent', frame => {
      const payload = String(frame.payload);
      if (payload.startsWith('participation:')) guestCommands.push(payload);
    });
  });

  try {
    await host.goto(`${roomUrlFor('Host', room)}&lang=en`);
    await guest.goto(`${roomUrlFor('Guest', room)}&lang=en`);
    await expect(row(host, 'Guest')).toBeVisible();
    const originalParticipantId = await guest.evaluate(() => (window as any).PPIdentity.read(new URL(location.href).searchParams.get('roomCode')).participantId);
    expect(originalParticipantId).toBeTruthy();

    await hostSetsSpectator(host, 'Guest', true);
    await expectSpectator(guest, 'Guest', true);
    await expect(guest.locator('#cardGrid button:enabled')).toHaveCount(0);
    expect(hostCommands).toEqual(['setSpectator:Guest:true']);
    await expect(guest.locator('.participant-more')).toHaveCount(0);

    await guest.reload();
    await expectSpectator(guest, 'Guest', true);
    expect(await guest.evaluate(() => (window as any).PPIdentity.read(new URL(location.href).searchParams.get('roomCode')).participantId)).toBe(originalParticipantId);
    expect(hostCommands).toEqual(['setSpectator:Guest:true']);

    await guest.goto('/about');
    await guest.goBack();
    await expectSpectator(guest, 'Guest', true);
    expect(await guest.evaluate(() => (window as any).PPIdentity.read(new URL(location.href).searchParams.get('roomCode')).participantId)).toBe(originalParticipantId);

    const socketsBeforeReconnect = guestSockets;
    await guest.evaluate(() => (window as any).__ppWs.close(4002, 'spectator-rejoin-test'));
    await expect.poll(() => guestSockets, { timeout: 5_000 }).toBeGreaterThan(socketsBeforeReconnect);
    await expectSpectator(guest, 'Guest', true);

    await ensureMenuOpen(guest);
    await guest.locator('#menuParticipationToggle').check({ force: true });
    await ensureMenuClosed(guest);
    await expectSpectator(host, 'Guest', false);
    await expect.poll(() => guestCommands).toEqual(['participation:true']);
    await guest.reload();
    await expectSpectator(guest, 'Guest', false);

    await hostSetsSpectator(host, 'Guest', true);
    await expectSpectator(guest, 'Guest', true);
    await hostSetsSpectator(host, 'Guest', false);
    await expectSpectator(guest, 'Guest', false);
    expect(hostCommands).toEqual([
      'setSpectator:Guest:true',
      'setSpectator:Guest:true',
      'setSpectator:Guest:false',
    ]);
    await guest.reload();
    await expectSpectator(guest, 'Guest', false);

    await newcomer.goto(`${roomUrlFor('NewGuest', room)}&lang=en`);
    await expect(newcomer.locator('#cardGrid button:enabled').first()).toBeVisible();
    await ensureMenuOpen(newcomer);
    await expect(newcomer.locator('#menuParticipationToggle')).toBeChecked();
    await expect(newcomer.locator('.participant-more')).toHaveCount(0);
  } finally {
    await Promise.allSettled([newContext.close(), guestContext.close(), hostContext.close()]);
  }
});
