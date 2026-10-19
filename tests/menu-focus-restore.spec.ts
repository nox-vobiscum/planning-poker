import { test, expect, type Page } from '@playwright/test';

const paths = [
  '/',
  '/about',
  '/invite?roomCode=focus-invite',
  '/room?roomCode=focus-room&participantName=FocusHost',
];

type CloseMethod = 'escape' | 'button' | 'backdrop';

async function closeMenu(page: Page, method: CloseMethod) {
  if (method === 'escape') await page.keyboard.press('Escape');
  if (method === 'button') await page.locator('#menuCloseButton').click();
  if (method === 'backdrop') await page.locator('.menu-backdrop').click({ position: { x: 5, y: 5 } });
}

for (const width of [320, 375]) {
  for (const path of paths) {
    for (const method of ['escape', 'button', 'backdrop'] as const) {
      test(`WebKit restores menu focus after ${method} at ${width}px on ${path}`, async ({ page, browserName }) => {
        test.skip(browserName !== 'webkit');
        await page.setViewportSize({ width, height: 800 });
        const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const target = path.replace('focus-invite', `focus-invite-${run}`).replace('focus-room', `focus-room-${run}`);
        await page.goto(target);

        const trigger = page.locator('#menuButton');
        await trigger.click();
        await expect(page.locator('#menuCloseButton')).toBeFocused();
        await closeMenu(page, method);

        await expect(page.locator('#appMenuOverlay')).toBeHidden();
        await expect(trigger).toBeFocused();
      });
    }
  }
}

test('Chromium restores focus after pointer-opened menu closes', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  const trigger = page.locator('#menuButton');
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('Chromium restores focus after keyboard-opened menu closes', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  const trigger = page.locator('#menuButton');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#menuCloseButton')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});
