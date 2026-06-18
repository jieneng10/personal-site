// Quick browser verification
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const exe = path.join(localAppData, 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe');

(async () => {
  try {
    const browser = await chromium.launch({ headless: true, executablePath: exe });
    const page = await browser.newPage();
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', e => errors.push('PAGE_ERR: ' + e.message));

    await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // Check window functions
    const checks = await page.evaluate(() => ({
      loadArticles: typeof window.loadArticles,
      initSakura: typeof window.initSakura,
      applyWallpaper: typeof window.applyWallpaper,
      _isLoggedIn: window._isLoggedIn,
      EventBus: typeof window.EventBus,
      sb: typeof window.sb,
    }));
    console.log('window functions:', JSON.stringify(checks, null, 2));

    // Try clicking articles
    await page.click('[data-section="articles"]');
    await page.waitForTimeout(2000);
    const cards = await page.locator('.article-card').count();
    console.log('articleCards:', cards);

    if (errors.length) console.log('errors:', errors.slice(0, 10));

    await browser.close();
    console.log('DONE');
  } catch (e) {
    console.error('FAIL:', e.message.slice(0, 300));
  }
})();
