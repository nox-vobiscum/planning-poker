import { defineConfig } from '@playwright/test';

const browserMatrixSpecs = /(?:control-geometry|firefox-handshake-wake|menu-toggle-presentation|shape-language)\.spec\.ts/;
const webkitMatrixSpecs = /(?:control-geometry|firefox-handshake-wake|menu-focus-restore|menu-toggle-presentation|shape-language)\.spec\.ts/;

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts$/,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  timeout: 30_000,
  expect: { timeout: 8_000 },

  use: {
    headless: true,
    baseURL: process.env.PP_BASE_URL || 'http://localhost:8080',
    actionTimeout: 7_000,
    navigationTimeout: 25_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      testIgnore: browserMatrixSpecs,
      use: { browserName: 'chromium' },
    },
    {
      name: 'matrix-chromium',
      testMatch: browserMatrixSpecs,
      use: { browserName: 'chromium' },
    },
    {
      name: 'matrix-firefox',
      testMatch: browserMatrixSpecs,
      dependencies: ['matrix-chromium'],
      use: { browserName: 'firefox' },
    },
    {
      name: 'matrix-webkit',
      testMatch: webkitMatrixSpecs,
      dependencies: ['matrix-chromium'],
      use: { browserName: 'webkit' },
    },
  ],
});
