import { test, expect } from '@playwright/test';

for (const saved of [null, 'invalid', 'light', 'dark', 'system']) {
  test('theme bootstrap and reload: ' + saved, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(value => {
      if (!sessionStorage.getItem('seeded')) {
        if (value) localStorage.setItem('planningpoker-theme', value);
        sessionStorage.setItem('seeded', '1');
      }
      document.addEventListener('load', event => {
        if (event.target instanceof HTMLLinkElement && event.target.rel === 'stylesheet') {
          (window as any).__earlyTheme = document.documentElement.getAttribute('data-theme');
        }
      }, true);
    }, saved);
    await page.goto('/');
    await page.evaluate(() => (window as any).PPUI.ready);
    const mode = saved === 'light' || saved === 'dark' ? saved : 'system';
    expect(await page.evaluate(() => (window as any).__earlyTheme)).toBe(mode === 'system' ? null : mode);
    expect(await page.evaluate(() => (window as any).PPUI.snapshot())).toEqual({ themeMode: mode, language: 'en' });
    expect(await page.evaluate(() => Object.keys((window as any).PPUI))).not.toContain('setMenuOpen');
    await expect(page.locator('#hcTheme' + mode[0]!.toUpperCase() + mode.slice(1))).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    expect(await page.evaluate(() => (window as any).PPUI.snapshot().themeMode)).toBe(mode);
    if (mode === 'system') {
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(30, 30, 30)');
    }
  });
}

test('denied storage leaves preferences and dialog usable in memory', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
    get() { throw new Error('Storage blocked'); }
  }));
  await page.goto('/');
  await page.evaluate(() => (window as any).PPUI.ready);
  expect(await page.evaluate(() => (window as any).PPUI.snapshot().themeMode)).toBe('system');
  await page.locator('#hcLangDE').click();
  await expect(page.locator('#hcLangDE')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#hcThemeDark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#menuButton').click();
  await expect(page.locator('#menuButton')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#menuButton')).toBeFocused();
  expect(errors).toEqual([]);
});

test('saved language wins over query locale; events are emitted once', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lang', 'de'));
  await page.goto('/?lang=en&tracking=test');
  await page.evaluate(() => (window as any).PPUI.ready);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  expect(page.url()).toContain('tracking=test');
  expect(page.url()).not.toContain('lang=');
  await page.evaluate(() => {
    (window as any).__events = [];
    window.addEventListener('pp:lang-change', (event: any) => (window as any).__events.push(['window', event.detail]));
    document.addEventListener('pp:lang-changed', (event: any) => (window as any).__events.push(['document', event.detail]));
  });
  await page.locator('#hcLangEN').click();
  await expect.poll(() => page.evaluate(() => (window as any).__events.length)).toBe(2);
  await page.locator('#hcLangEN').click();
  expect(await page.evaluate(() => (window as any).__events)).toEqual([
    ['window', { lang: 'en', source: 'header' }], ['document', { lang: 'en', source: 'header' }]
  ]);
  expect(await page.evaluate(() => localStorage.getItem('lang'))).toBe('en');
});

test('a late translation response cannot overwrite the latest language', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => (window as any).PPUI.ready);
  let releaseDe!: () => void;
  const holdDe = new Promise<void>(resolve => { releaseDe = resolve; });
  let requestedDe!: () => void;
  const seenDe = new Promise<void>(resolve => { requestedDe = resolve; });
  await page.route('**/i18n/messages?lang=de', async route => {
    const response = await route.fetch();
    requestedDe();
    await holdDe;
    await route.fulfill({ response });
  });
  await page.evaluate(() => { (window as any).__de = (window as any).PPUI.setLanguage('de'); });
  await seenDe;
  await page.evaluate(() => (window as any).PPUI.setLanguage('en'));
  releaseDe();
  await page.evaluate(() => (window as any).__de);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#hcLangEN')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('label[for="nameInput"]')).toContainText('Your name');
});

test('failed translation can be requested again without losing menu state', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => (window as any).PPUI.ready);
  await page.locator('#menuButton').click();
  await page.route('**/i18n/messages?lang=de', route => route.fulfill({ status: 503, body: '' }));
  await page.evaluate(() => (window as any).PPUI.setLanguage('de'));
  await expect(page.locator('#appMenuOverlay')).toBeVisible();
  await page.unroute('**/i18n/messages?lang=de');
  await page.evaluate(() => (window as any).PPUI.setLanguage('de'));
  await expect(page.locator('#menuTitle')).toHaveText('Einstellungen');
  await expect(page.locator('#menuButton')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#menuButton')).toBeFocused();
});
