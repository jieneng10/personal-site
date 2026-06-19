/**
 * Run driver for personal-site — static HTML site with Supabase backend.
 *
 * Usage:
 *   node .claude/skills/run-personal-site/driver.mjs           # default: port 8000
 *   node .claude/skills/run-personal-site/driver.mjs --port 3000
 *   node .claude/skills/run-personal-site/driver.mjs --help
 *
 * What it does:
 *   1. Starts python3 -m http.server on the given port
 *   2. Launches headless Chromium via Playwright
 *   3. Navigates, verifies key elements, clicks through sections
 *   4. Takes screenshots at each stage
 *   5. Reports console errors
 *   6. Stops server + browser cleanly
 *
 * Screenshots land in <project-root>/screenshots/.
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SCREENSHOT_DIR = join(PROJECT_ROOT, 'screenshots');

// ---- CLI ----
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node driver.mjs [--port <n>] [--help]

Options:
  --port <n>   Port for the HTTP server (default: 8000)
  --help       Show this message

Screenshots → ${SCREENSHOT_DIR}/`);
  process.exit(0);
}

const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8000;
const BASE_URL = `http://localhost:${PORT}`;

mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ---- Helpers ----

/** Find a free port, starting from `preferred`. */
async function findPort(preferred) {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(preferred, '127.0.0.1', () => { s.close(() => resolve(preferred)); });
    s.on('error', () => {
      // Try the next port
      const next = preferred + 1;
      if (next > preferred + 100) return reject(new Error('No free port found'));
      s.close();
      findPort(next).then(resolve, reject);
    });
  });
}

/** Check if a command exists on PATH. */
function checkCmd(cmd) {
  return new Promise(resolve => {
    const proc = spawn(cmd, ['--version'], { stdio: 'ignore' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/** Wait for the server to respond to a health check. */
async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 304) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server not ready at ${url} after ${timeoutMs}ms`);
}

// ---- Main ----

async function main() {
  const actualPort = await findPort(PORT);
  const URL = `http://localhost:${actualPort}`;
  const results = { ok: [], warn: [], fail: [] };

  function ok(msg)  { console.log(`  ✓ ${msg}`);  results.ok.push(msg); }
  function warn(msg) { console.log(`  ⚠ ${msg}`); results.warn.push(msg); }
  function fail(msg) { console.log(`  ✗ ${msg}`); results.fail.push(msg); }

  // 1. Start server — try python3 first (Linux), fall back to python (Windows)
  console.log(`\n▶ Starting HTTP server on port ${actualPort}...`);
  const pythonCmd = (await checkCmd('python3')) ? 'python3'
                  : (await checkCmd('python'))  ? 'python'
                  : 'python3'; // last resort
  const server = spawn(pythonCmd, ['-m', 'http.server', String(actualPort)], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write(`  [server] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`  [server:err] ${d}`));

  // Ensure server is killed on exit
  const cleanup = () => { try { server.kill('SIGTERM'); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(); });
  process.on('SIGTERM', () => { cleanup(); process.exit(); });

  try {
    await waitForServer(`${URL}/index.html`);
    console.log('  ✓ Server ready');

    // 2. Launch browser
    console.log('\n▶ Launching headless Chromium...');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    // Collect console events
    const consoleEntries = [];
    page.on('console', msg => consoleEntries.push({ type: msg.type(), text: msg.text() }));
    page.on('pageerror', err => consoleEntries.push({ type: 'error', text: `[pageerror] ${err.message}` }));

    try {

      // 3. Navigate + wait for DOM
      console.log(`\n▶ Navigating to ${URL}/index.html`);
      await page.goto(`${URL}/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500); // let defer scripts + canvas boot
      ok('Page loaded');

      // 4. Page metadata
      const title = await page.title();
      if (title.includes('jieneng')) ok(`Title: "${title}"`);
      else fail(`Unexpected title: "${title}"`);

      // 5. Key elements
      const checks = [
        ['#bgLayer', 'Background layer'],
        ['#sakuraCanvas', 'Sakura canvas'],
        ['.sidebar', 'Sidebar navigation'],
        ['#contentPanel', 'Content panel'],
        ['#btnNewsToggle', 'News toggle button'],
        ['#bgmPlayer', 'BGM player'],
        ['#wallpaperPicker', 'Wallpaper picker'],
      ];
      for (const [sel, label] of checks) {
        try {
          await page.waitForSelector(sel, { timeout: 3000 });
          ok(`${label} (${sel}) rendered`);
        } catch {
          fail(`${label} (${sel}) not found`);
        }
      }

      // 6. Screenshot: initial load (with wallpaper + sakura)
      await page.screenshot({ path: join(SCREENSHOT_DIR, '01-homepage.png'), fullPage: false });
      console.log(`  📷 → ${join(SCREENSHOT_DIR, '01-homepage.png')}`);

      // 7. Navigate to articles section
      console.log('\n▶ Clicking "Articles" nav...');
      await page.click('[data-section="articles"]');
      await page.waitForTimeout(600);
      const articlesActive = await page.isVisible('#sec-articles.active');
      if (articlesActive) ok('Articles section opened');
      else fail('Articles section did not open');

      await page.screenshot({ path: join(SCREENSHOT_DIR, '02-articles.png'), fullPage: false });
      console.log(`  📷 → ${join(SCREENSHOT_DIR, '02-articles.png')}`);

      // 8. Toggle news sidebar
      console.log('\n▶ Toggling news sidebar...');
      await page.click('#btnNewsToggle');
      await page.waitForTimeout(800);
      const newsVisible = await page.isVisible('#newsSidebar');
      // News sidebar might have class "open" but we check if it's in the DOM + styled visible
      const newsClasses = await page.$eval('#newsSidebar', el => el.className);
      if (newsVisible && newsClasses.includes('open')) ok('News sidebar opened');
      else if (newsVisible) warn('News sidebar visible but may not have "open" class');
      else fail('News sidebar not visible');

      await page.screenshot({ path: join(SCREENSHOT_DIR, '03-news-sidebar.png'), fullPage: false });
      console.log(`  📷 → ${join(SCREENSHOT_DIR, '03-news-sidebar.png')}`);

      // Check for news content (fetched from local JSON fallback)
      try {
        await page.waitForSelector('.news-card', { timeout: 5000 });
        const count = await page.$$eval('.news-card', els => els.length);
        ok(`News cards loaded: ${count}`);
      } catch {
        warn('No .news-card elements — news fetch may have failed (Supabase offline, JSON missing)');
      }

      // 9. Settings section
      console.log('\n▶ Clicking "Settings" nav...');
      await page.click('[data-section="settings"]');
      await page.waitForTimeout(500);
      const settingsActive = await page.isVisible('#sec-settings.active');
      if (settingsActive) ok('Settings section opened');
      else fail('Settings section did not open');

      await page.screenshot({ path: join(SCREENSHOT_DIR, '04-settings.png'), fullPage: false });
      console.log(`  📷 → ${join(SCREENSHOT_DIR, '04-settings.png')}`);

      // 10. Back to home
      console.log('\n▶ Clicking "Home" nav...');
      await page.click('[data-section="home"]');
      await page.waitForTimeout(500);
      const homeActive = await page.isVisible('#sec-home.active');
      if (homeActive) ok('Home section restored');
      else fail('Home section did not restore');

      // 11. Console check
      console.log('\n▶ Console audit...');
      const errors = consoleEntries.filter(c => c.type === 'error');
      const warnings = consoleEntries.filter(c => c.type === 'warning');

      if (errors.length === 0) {
        ok('No console errors');
      } else {
        // Expected: Supabase CDN 404 when offline, SW has GitHub Pages path prefix, CSP noise
        const realErrors = errors.filter(e =>
          !e.text.includes('cdn.jsdelivr.net') &&
          !e.text.includes('Failed to load resource: net::ERR_FAILED') &&
          !e.text.includes('/personal-site/sw.js') &&         // GH Pages prefix, not served locally
          !e.text.includes('404) was received when fetching the script') && // SW registration 404 (same cause)
          !e.text.includes('status of 404') &&                // generic 404 without URL (SW on GH Pages prefix)
          !e.text.includes('403')
        );
        if (realErrors.length === 0) {
          warn(`${errors.length} console error(s) — all expected (CDN/wasm in headless):`);
          errors.forEach(e => console.log(`    [${e.type}] ${e.text.substring(0, 120)}`));
        } else {
          fail(`${realErrors.length} unexpected console error(s):`);
          realErrors.forEach(e => console.log(`    [${e.type}] ${e.text}`));
        }
      }

      if (warnings.length > 0) {
        console.log(`  ℹ ${warnings.length} console warning(s) (informational):`);
        warnings.slice(0, 3).forEach(w => console.log(`    [${w.type}] ${w.text.substring(0, 120)}`));
        if (warnings.length > 3) console.log(`    ... and ${warnings.length - 3} more`);
      }

      // 12. Final screenshot: full page scrolled
      await page.evaluate(() => window.scrollTo(0, 300));
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SCREENSHOT_DIR, '05-homepage-scrolled.png'), fullPage: false });
      console.log(`  📷 → ${join(SCREENSHOT_DIR, '05-homepage-scrolled.png')}`);

    } finally {
      await browser.close();
      console.log('\n✓ Browser closed');
    }

  } finally {
    server.kill('SIGTERM');
    console.log('✓ Server stopped');
  }

  // Summary
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${results.ok.length} OK, ${results.warn.length} warnings, ${results.fail.length} failures`);
  if (results.fail.length > 0) {
    console.log(`\nFAILURES:`);
    results.fail.forEach(f => console.log(`  ✗ ${f}`));
    process.exitCode = 1;
  } else {
    console.log('All checks passed ✓');
  }
  console.log(`${'═'.repeat(50)}\n`);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
