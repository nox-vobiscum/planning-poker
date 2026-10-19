import { expect, test } from '@playwright/test';
import { newRoomCode, roomUrlFor } from './utils/env';

test('participant roles stay beside the name while the vote slot remains centered', async ({ browser }) => {
  const room = newRoomCode('ROLES');
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  try {
    await host.goto(roomUrlFor('RoleHost', room));
    await expect(host.locator('.main-info-group--participant .pp-status-icon use')).toHaveAttribute('href', '#pp-icon-person');
    await expect(host.locator('.main-info-group--room .pp-status-icon use')).toHaveAttribute('href', '#pp-icon-room');
    await expect(host.locator('#liveParticipantList .participant-row.is-host')).toHaveCount(1);
    await guest.goto(roomUrlFor('RoleGuest', room));

    const rows = host.locator('#liveParticipantList .participant-row');
    await expect(rows).toHaveCount(2);
    const hostRow = rows.filter({ has: host.locator('.name', { hasText: /^RoleHost$/ }) });
    const guestRow = rows.filter({ has: host.locator('.name', { hasText: /^RoleGuest$/ }) });

    await expect(hostRow.locator('.participant-identity .participant-role-host')).toHaveCount(1);
    await expect(hostRow.locator('.participant-icon .pp-status-icon[data-icon="person"] use')).toHaveAttribute('href', '#pp-icon-person');
    await expect(hostRow.locator('.participant-role-host .pp-status-icon[data-icon="host"] use')).toHaveAttribute('href', '#pp-icon-host');
    await expect(hostRow.locator('.host-label')).toHaveText('Host');
    await expect(guestRow.locator('.participant-role-host')).toHaveCount(0);

    await guestRow.locator('.participant-more').click();
    await guestRow.locator('button.row-action.spectator').click();
    await expect(guestRow).toHaveClass(/spectator/);
    await expect(guestRow.locator('.participant-identity .participant-role-spectator')).toHaveCount(1);
    await expect(guestRow.locator('.participant-role-spectator .pp-status-icon[data-icon="spectator"] use')).toHaveAttribute('href', '#pp-icon-spectator');
    await expect(guestRow.locator('.spectator-label')).toHaveText('Spectator');
    await expect(guestRow.locator('.row-right .spectator-slot')).toHaveText('–');

    const centers = await guestRow.evaluate(row => {
      const rowRect = row.getBoundingClientRect();
      const slotRect = row.querySelector('.row-right .spectator-slot')!.getBoundingClientRect();
      return {
        delta: Math.abs((rowRect.left + rowRect.width / 2) - (slotRect.left + slotRect.width / 2)),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(centers.delta).toBeLessThanOrEqual(1);
    expect(centers.overflow).toBeLessThanOrEqual(1);

    await guestContext.close();
    await expect(guestRow).toHaveClass(/disconnected/, { timeout: 5_000 });
    await expect(guestRow.locator('.participant-identity .participant-role-inactive')).toHaveCount(1);
    await expect(guestRow.locator('.participant-role-inactive .pp-status-icon[data-icon="inactive"] use')).toHaveAttribute('href', '#pp-icon-inactive');
    await expect(guestRow.locator('.inactive-label')).toHaveText('Inactive');
  } finally {
    await hostContext.close();
    await guestContext.close().catch(() => {});
  }
});

for (const width of [320, 1280]) {
  test(`long participant identity remains contained at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => localStorage.setItem('planningpoker-theme', 'light'));
    await page.goto(roomUrlFor(`Participant-${'x'.repeat(68)}`, newRoomCode('LONGNAME')));

    const row = page.locator('#liveParticipantList .participant-row');
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    await page.waitForTimeout(300);
    const geometry = await row.evaluate(element => {
      const rowRect = element.getBoundingClientRect();
      const nameRect = element.querySelector('.name')!.getBoundingClientRect();
      const chipRect = element.querySelector('.row-right .mini-chip')!.getBoundingClientRect();
      const identity = element.querySelector('.participant-identity')!;
      const roleRect = element.querySelector('.participant-role-host')?.getBoundingClientRect();
      const rowStyle = getComputedStyle(element);
      return {
        nameContained: nameRect.right <= rowRect.right + 1,
        chipDelta: Math.abs((rowRect.left + rowRect.width / 2) - (chipRect.left + chipRect.width / 2)),
        chipContained: chipRect.left >= rowRect.left - 1 && chipRect.right <= rowRect.right + 1,
        chipRightDelta: Math.abs((rowRect.right - Number.parseFloat(rowStyle.paddingRight)) - chipRect.right),
        roleClearance: chipRect.left - (roleRect?.right ?? nameRect.right),
        identityWidth: identity.getBoundingClientRect().width,
        hostBackground: getComputedStyle(element).backgroundColor,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(geometry.nameContained).toBe(true);
    if (width === 320) {
      expect(geometry.chipContained).toBe(true);
      expect(geometry.chipRightDelta, JSON.stringify(geometry)).toBeLessThanOrEqual(1);
      expect(geometry.roleClearance, JSON.stringify(geometry)).toBeGreaterThanOrEqual(6);
    } else {
      expect(geometry.chipDelta).toBeLessThanOrEqual(1);
    }
    expect(geometry.hostBackground).toBe('rgba(0, 0, 0, 0)');
    expect(geometry.overflow).toBeLessThanOrEqual(1);
  });
}
