import { test, expect } from '@playwright/test';
import { newRoomCode, roomUrlFor } from './utils/env';

const widths = [320, 375, 768, 769, 1280];

for (const width of widths) {
  test(`room metadata remains compact and contained at ${width}px`, async ({ page }) => {
    const participantName = `A very long participant name for ${width}px metadata verification`;
    const roomCode = `metadata-${width}-${Date.now()}-with-a-deliberately-long-room-code`;
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('planningpoker-theme', 'dark'));
    await page.goto(`${roomUrlFor(participantName, roomCode)}&lang=en`);

    const metadata = page.locator('.main-info');
    const participant = metadata.locator('.main-info-group--participant');
    const room = metadata.locator('.main-info-group--room');
    await expect(metadata).toBeVisible();
    await expect(metadata.locator('.main-info-group')).toHaveCount(2);
    await expect(page.locator('#youName')).toHaveText(participantName);
    await expect(page.locator('#roomCodeVal')).toHaveText(roomCode);
    await expect(page.locator('#copyRoomLink')).toHaveAccessibleName(/copy.*room/i);
    await expect(page.locator('#copyRoomLink')).toHaveCSS('border-radius', '10px');
    await expect(metadata.locator('.mi-label').first()).toHaveCSS('text-transform', 'uppercase');
    const labelStyles = await page.locator('.main-info .mi-label:first-of-type, .participant-heading, .topic-heading').evaluateAll(elements =>
      elements.map(element => {
        const css = getComputedStyle(element);
        return [css.fontSize, css.fontWeight, css.lineHeight, css.letterSpacing, css.textTransform].join('|');
      })
    );
    expect(new Set(labelStyles).size).toBe(1);

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const metadataRect = rect('.main-info');
      const participantRect = rect('.main-info-group--participant');
      const roomRect = rect('.main-info-group--room');
      const copyRect = rect('#copyRoomLink');
      return {
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        metadataLeft: metadataRect.left,
        metadataRight: metadataRect.right,
        participantTop: participantRect.top,
        roomTop: roomRect.top,
        copyWidth: copyRect.width,
        copyHeight: copyRect.height,
      };
    });

    expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
    expect(geometry.metadataLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.metadataRight).toBeLessThanOrEqual(width + 1);
    if (width <= 600) {
      expect(geometry.roomTop).toBeGreaterThan(geometry.participantTop);
    } else {
      expect(Math.abs(geometry.roomTop - geometry.participantTop)).toBeLessThanOrEqual(1);
    }
    if (width <= 768) {
      expect(geometry.copyWidth).toBeGreaterThanOrEqual(40);
      expect(geometry.copyHeight).toBeGreaterThanOrEqual(40);
    }
  });
}

for (const theme of ['light', 'system'] as const) {
  test(`${theme} preserves the metadata hierarchy`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(theme => localStorage.setItem('planningpoker-theme', theme), theme);
    await page.goto(`${roomUrlFor('Theme Tester', newRoomCode(`METADATA-${theme}`))}&lang=de`);

    await expect(page.locator('.main-info')).toBeVisible();
    await expect(page.locator('.main-info .mi-label').first()).toHaveCSS('color', 'rgb(55, 65, 81)');
    const colors = await page.evaluate(() => ({
      canvas: getComputedStyle(document.body).backgroundColor,
      metadata: getComputedStyle(document.querySelector('.main-info')!).backgroundColor,
    }));
    expect(colors.metadata).not.toBe(colors.canvas);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  });
}

for (const width of [601, 769, 805, 1280]) {
  test(`desktop metadata gives the participant only its required width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${roomUrlFor('Ada', `${newRoomCode('METADATA')}-room-with-available-space`)}&lang=en`);

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const metadata = rect('.main-info');
      const participant = rect('.main-info-group--participant');
      const room = rect('.main-info-group--room');
      const name = rect('#youName');
      const share = rect('#copyRoomLink');
      return {
        participantWidth: participant.width,
        roomWidth: room.width,
        participantShare: participant.width / metadata.width,
        nameClearance: participant.right - name.right,
        shareRightInset: metadata.right - share.right,
        aligned: Math.abs(participant.top - room.top),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });

    expect(geometry.participantWidth).toBeLessThan(geometry.roomWidth);
    expect(geometry.participantShare).toBeLessThan(0.35);
    expect(geometry.nameClearance).toBeGreaterThanOrEqual(23);
    expect(geometry.shareRightInset).toBeGreaterThanOrEqual(13);
    expect(geometry.shareRightInset).toBeLessThanOrEqual(15);
    expect(geometry.aligned).toBeLessThanOrEqual(1);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
  });
}

test('desktop metadata caps a long participant while preserving the flexible room area', async ({ page }) => {
  await page.setViewportSize({ width: 805, height: 800 });
  await page.goto(`${roomUrlFor(`Participant-${'n'.repeat(68)}`, 'Room-' + 'r'.repeat(100))}&lang=en`);

  const geometry = await page.evaluate(() => {
    const metadata = document.querySelector('.main-info')!.getBoundingClientRect();
    const participant = document.querySelector('.main-info-group--participant')!.getBoundingClientRect();
    const room = document.querySelector('.main-info-group--room')!.getBoundingClientRect();
    const name = document.querySelector<HTMLElement>('#youName')!;
    const code = document.querySelector<HTMLElement>('#roomCodeVal')!;
    const share = document.querySelector('#copyRoomLink')!.getBoundingClientRect();
    return {
      participantShare: participant.width / metadata.width,
      roomWidth: room.width,
      nameTruncated: name.scrollWidth > name.clientWidth,
      roomTruncated: code.scrollWidth > code.clientWidth,
      codeClear: code.getBoundingClientRect().right <= share.left - 7,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });

  expect(geometry.participantShare).toBeLessThanOrEqual(0.501);
  expect(geometry.roomWidth).toBeGreaterThan(0);
  expect(geometry.nameTruncated).toBe(true);
  expect(geometry.roomTruncated).toBe(true);
  expect(geometry.codeClear).toBe(true);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
});
