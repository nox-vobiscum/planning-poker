import { test, expect } from '@playwright/test';

const assets = [
  ['/assets/branding/brandmark-rbs-96.png', 'image/png'],
  ['/assets/branding/pwa/icon-192x192.png', 'image/png'],
  ['/assets/branding/pwa/icon-512x512.png', 'image/png'],
  ['/apple-touch-icon.png', 'image/png'],
  ['/favicon.ico', 'image/x-icon'],
  ['/favicon-16x16.png', 'image/png'],
  ['/favicon-32x32.png', 'image/png'],
] as const;

test('brand assets and manifest resolve with their declared formats', async ({ page, request }) => {
  for (const [path, contentType] of assets) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type'], path).toContain(contentType);
  }

  const manifest = await (await request.get('/manifest.json')).json();
  expect(manifest.icons).toEqual([
    { src: '/assets/branding/pwa/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/assets/branding/pwa/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ]);

  await page.goto('/');
  await expect(page.locator('link[rel="icon"]')).toHaveCount(3);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
  await expect(page.locator('.app-brand')).toHaveAccessibleName('Planning Poker');
  await expect(page.locator('.app-brand img')).toHaveAttribute('alt', '');
  await expect(page.locator('.app-brand img')).toHaveJSProperty('naturalWidth', 96);
});

for (const width of [320, 375, 768, 769, 1280]) {
  test(`brand remains visible without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      const image = page.locator('.app-brand img');
      await expect(image).toBeVisible();
      const size = await image.evaluate(el => {
        const img = el as HTMLImageElement;
        return { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
          width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height };
      });
      expect(size.naturalWidth).toBe(96);
      expect(size.width / size.height).toBeCloseTo(size.naturalWidth / size.naturalHeight, 2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}

test('brand remains available with the system theme preference', async ({ page }) => {
  await page.goto('/');
  await page.locator('#hcThemeSystem').click();
  await expect(page.locator('#hcThemeSystem')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.app-brand img')).toBeVisible();
  await expect(page.locator('.app-brand')).toHaveAccessibleName('Planning Poker');
});
