import { test, expect } from '@playwright/test';

for (const width of [375, 768, 1280]) {
  for (const theme of ['dark', 'light', 'system']) {
    test(`${theme} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await page.addInitScript(theme => localStorage.setItem('planningpoker-theme', theme), theme);
      const roomCode = `interface-${theme}-${width}-${Date.now()}`;
      for (const path of ['/?lang=en', '/about?lang=en', `/room?roomCode=${roomCode}&participantName=Tester`]) {
        await page.goto(path);
        expect(await page.locator('html').getAttribute('data-theme')).toBe(theme === 'system' ? null : theme);
        expect(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily)).toContain('system-ui');
        await expect(page.locator('body')).toHaveCSS('background-color',
          theme === 'dark' ? 'rgb(30, 30, 30)' : 'rgb(246, 247, 249)');
        const backgroundImage = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundImage);
        expect(backgroundImage).not.toBe('none');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.locator('#menuButton').click();
        if (width < 769) {
          await expect(page.locator('#menuTheme')).toBeVisible();
        } else {
          await expect(page.locator('#menuTheme')).toBeHidden();
          await expect(page.locator('.app-header .theme-control')).toBeVisible();
        }
        await page.locator('#menuCloseButton').click();
      }
      if (theme === 'system') {
        await page.emulateMedia({ colorScheme: 'dark' });
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(30, 30, 30)');
        expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundImage)).not.toBe('none');
      }
    });
  }
}

test('blocked storage retains the standard appearance and usable theme controls', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('Storage unavailable'); };
    Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
  });
  await page.goto('/');
  await expect(page.locator('body')).toHaveCSS('font-family', /system-ui/);
  await page.locator('#hcThemeDark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test(`vote, reveal and reset remain functional`, async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const host = await context.newPage();
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const room = `interface-${Date.now()}`;
  let state: any;
  host.on('websocket', socket => socket.on('framereceived', event => {
    try {
      const data = JSON.parse(String(event.payload));
      if (data.type === 'voteUpdate') state = data;
    } catch {}
  }));
  try {
    await host.goto(`${testInfo.project.use.baseURL}/room?roomCode=${room}&participantName=Host`);
    await expect.poll(() => state?.participants?.length).toBe(1);
    await guest.goto(`${testInfo.project.use.baseURL}/room?roomCode=${room}&participantName=Guest`);
    await expect.poll(() => state?.participants?.length).toBe(2);
    const unselected = host.locator('#cardGrid button').filter({ hasText: /^8$/ });
    const neutralBorder = await unselected.evaluate(el => getComputedStyle(el).borderTopColor);
    await host.locator('#cardGrid button').filter({ hasText: /^5$/ }).click();
    await guest.locator('#cardGrid button').filter({ hasText: /^3$/ }).click();
    await expect.poll(() => state?.participants?.filter((p: any) => p.vote != null).length).toBe(2);
    await host.locator('#revealButton').click();
    await expect.poll(() => state?.votesRevealed).toBe(true);
    await expect(host.locator('#resetButton')).toBeVisible();
    await expect(host.locator('#averageVote')).toHaveText(/^4([.,]0+)?$/);
    await unselected.hover();
    await expect(unselected).toHaveCSS('border-top-color', neutralBorder);
    await host.screenshot({ path: testInfo.outputPath(`interface-room.png`), fullPage: true });
    await host.locator('#resetButton').click();
    await expect.poll(() => state?.votesRevealed).toBe(false);
    await expect.poll(() => state?.participants?.filter((p: any) => p.vote != null).length).toBe(0);
  } finally {
    await context.close();
    await guestContext.close();
  }
});
