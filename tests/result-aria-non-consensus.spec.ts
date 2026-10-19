import { newRoomCode } from './utils/env';
// tests/result-aria-non-consensus.spec.ts
import { test, expect } from '@playwright/test';

test('Result row announces non-consensus stats (Average/Median/Range) in English', async ({ browser }) => {
  const room = newRoomCode();
  const hostName = 'HostSR';
  const guestName = 'GuestSR';

  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  // Host joins
  await host.goto(`/room?roomCode=${encodeURIComponent(room)}&participantName=${encodeURIComponent(hostName)}`, {
    waitUntil: 'domcontentloaded',
  });

  await expect(host.locator('#liveParticipantList .host-label')).toHaveCount(1);

  // Guest joins
  await guest.goto(`/room?roomCode=${encodeURIComponent(room)}&participantName=${encodeURIComponent(guestName)}`, {
    waitUntil: 'domcontentloaded',
  });

  // Make different votes to avoid consensus.
  // Use regex to match the exact label to avoid "1" vs "10" collisions.
  await host.getByRole('button', { name: /^3$/ }).click();
  await guest.getByRole('button', { name: /^8$/ }).click();

  // Reveal from host
  const reveal = host.locator('#revealButton');
  await expect(reveal).toBeVisible();
  await expect(reveal).toBeEnabled();
  await reveal.click();

  // SR-only announcement should be in English and NOT say "Consensus"
  const sr = host.locator('#resultAnnounce');
  await expect(sr).not.toHaveText('');                     // something announced
  await expect(sr).toContainText(/Average:/i);             // English keyword present
  await expect(sr).not.toContainText(/Konsens/i);          // no localized term
  await expect(sr).not.toContainText(/Consensus\s*🎉/i);    // non-consensus path (no "Consensus ...")

  await guestContext.close();
  await hostContext.close();
});
