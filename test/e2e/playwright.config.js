import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:8000',
    viewport: { width: 1280, height: 800 },
    headless: true,
  },
  // 不自动启服务器——由调用方（driver.mjs / ci.yml）手动管理
  webServer: undefined,
});
