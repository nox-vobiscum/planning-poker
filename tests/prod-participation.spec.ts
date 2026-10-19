// Prod: Participation → Spectator mode disables voting and reflects in host list
// - User toggles Participation OFF → all their cards disabled, host sees 👁 chip
// - User toggles Participation ON  → some cards enabled again, 👁 chip disappears

import { test, expect } from '@playwright/test';
import { roomUrlFor, newRoomCode, ensureMenuOpen, ensureMenuClosed } from './_setup/prod-helpers.js';

test('Participation toggle on prod: Spectator disables voting and updates host list', async ({ browser }) => {
  const room = newRoomCode('PROD-OBS');
  const hostName = 'Host';
  const userName = 'Viewer';
  const hostContext = await browser.newContext();
  const userContext = await browser.newContext();
  const page = await hostContext.newPage();
  const user = await userContext.newPage();

  // Open Host & User
  await page.goto(roomUrlFor(hostName, room), { waitUntil: 'domcontentloaded' });
  await user.goto(roomUrlFor(userName, room), { waitUntil: 'domcontentloaded' });

  // Base UI visible
  await expect(page.locator('#cardGrid')).toBeVisible();
  await expect(user.locator('#cardGrid')).toBeVisible();

  // Wait until both rows are present
  const rows = page.locator('#liveParticipantList .participant-row');
  await expect(rows).toHaveCount(2);

  // Match rows by the name cell (avoid matching action buttons)
  const hostRow = rows.filter({ has: page.locator('.name, .p-name', { hasText: new RegExp(`^${hostName}$`) }) });
  const viewerRow = rows.filter({ has: page.locator('.name, .p-name', { hasText: new RegExp(`^${userName}$`) }) });
  await expect(hostRow).toHaveCount(1);
  await expect(viewerRow).toHaveCount(1);

  // --- User -> Spectator (Participation OFF) ---
  await ensureMenuOpen(user);
  const participationTgl = user.locator('#menuParticipationToggle');
  await expect(participationTgl).toHaveCount(1);

  // If currently ON, click to turn OFF (spectator)
  if (await participationTgl.isChecked()) {
    await participationTgl.click({ force: true });
  }
  await ensureMenuClosed(user);

  // On user's page: all card buttons must be disabled
  await user.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('#cardGrid button'));
    return btns.length > 0 && btns.every(b => (b as HTMLButtonElement).disabled)
  });

  // On host page: spectator eye chip must appear on the viewer's row
  await expect(viewerRow.locator('.mini-chip.spectator')).toHaveCount(1);

  // --- User -> Estimating (Participation ON) ---
  await ensureMenuOpen(user);
  if (!(await participationTgl.isChecked())) {
    await participationTgl.click({ force: true });
  }
  await ensureMenuClosed(user);

  // On user's page: at least one card button becomes enabled again
  await user.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('#cardGrid button'));
    return btns.length > 0 && btns.some(b => !(b as HTMLButtonElement).disabled)
  });

  // On host page: spectator eye chip disappears from the viewer's row
  await expect(viewerRow.locator('.mini-chip.spectator')).toHaveCount(0);

  await userContext.close();
  await hostContext.close();
});
