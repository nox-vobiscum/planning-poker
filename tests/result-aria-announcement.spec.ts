import { test, expect } from '@playwright/test';

function rc(p='ARIA'){ return `${p}-${Date.now()}-${Math.floor(Math.random()*1e6)}`; }

test('Result row announces for screen readers on reveal', async ({ browser }) => {
  const room = rc();
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto(`/room?roomCode=${encodeURIComponent(room)}&participantName=Alice`, { waitUntil: 'domcontentloaded' });
  await expect(host.locator('html')).toHaveAttribute('data-ready','1');

  await guest.goto(`/room?roomCode=${encodeURIComponent(room)}&participantName=Bob`, { waitUntil: 'domcontentloaded' });

  await expect(host.locator('#liveParticipantList .participant-row')).toHaveCount(2);

  await host.locator('#cardGrid button').first().click();
  await guest.locator('#cardGrid button').first().click();

  await host.locator('#revealButton').click();

  const sr = host.locator('#resultAnnounce');
  await expect(sr).toContainText(/Consensus/i);
  await expect(sr).not.toHaveText('');

  await guestContext.close();
  await hostContext.close();
});
