import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://127.0.0.1:8000',
    viewport: { width: 1280, height: 800 },
    headless: true,
  },
  // CI 和本地调用方负责启动服务，避免 Windows 上留下孤立的 serve 子进程。
  webServer: undefined,
});
