// Prod: Host list shows/removes spectator eye chip when user toggles participation
// - Viewer toggles Participation OFF → host sees 👁 chip on that row
// - Viewer toggles Participation ON  → 👁 chip disappears

import { test, expect } from '@playwright/test';
import { roomUrlFor, newRoomCode, ensureMenuOpen, ensureMenuClosed } from './_setup/prod-helpers.js';

test('Host list shows/removes observer icon when user toggles participation', async ({ browser }) => {
  const room = newRoomCode('PROD-HOST-OBS');
  const hostName = 'Host';
  const viewerName = 'Viewer';
  const hostContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const page = await hostContext.newPage();
  const viewer = await viewerContext.newPage();

  // Open Host & Viewer
  await page.goto(roomUrlFor(hostName, room), { waitUntil: 'domcontentloaded' });
  await viewer.goto(roomUrlFor(viewerName, room), { waitUntil: 'domcontentloaded' });

  // Base UI visible
  await expect(page.locator('#cardGrid')).toBeVisible();
  await expect(viewer.locator('#cardGrid')).toBeVisible();

  // Wait until both rows are present (match by the name cell)
  const rows = page.locator('#liveParticipantList .participant-row');
  await expect(rows).toHaveCount(2);

  const viewerRow = rows.filter({
    has: page.locator('.name, .p-name', { hasText: new RegExp(`^${viewerName}$`) })
  });
  await expect(viewerRow).toHaveCount(1);

  // --- Viewer -> Spectator (Participation OFF) ---
  await ensureMenuOpen(viewer);
  const partTgl = viewer.locator('#menuParticipationToggle');
  await expect(partTgl).toHaveCount(1);
  if (await partTgl.isChecked()) {
    await partTgl.click({ force: true });
  }
  await ensureMenuClosed(viewer);

  // Host sees the spectator eye chip on the viewer's row
  await expect(viewerRow.locator('.mini-chip.spectator')).toHaveCount(1);

  // --- Viewer -> Estimating (Participation ON) ---
  await ensureMenuOpen(viewer);
  if (!(await partTgl.isChecked())) {
    await partTgl.click({ force: true });
  }
  await ensureMenuClosed(viewer);

  // Spectator eye chip disappears
  await expect(viewerRow.locator('.mini-chip.spectator')).toHaveCount(0);

  await viewerContext.close();
  await hostContext.close();
});
