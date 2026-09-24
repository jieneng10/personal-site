import { test, expect } from '@playwright/test';

test('本地壁纸和曲目在数据库多次升级后仍可读取和删除', async ({ page }) => {
  await page.route('**/*.supabase.co/**', route => route.abort());
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.saveToLocalDB === 'function' &&
    typeof window.getAllWallpapers === 'function' && typeof window.getAllTracks === 'function');

  const result = await page.evaluate(async () => {
    const name = 'PersonalSiteDB-e2e-' + Date.now();
    window.DB_NAME = name;
    const data = new Uint8Array([1, 2, 3]).buffer;
    await Promise.all([
      window.saveToLocalDB('wallpapers', [{ name: 'local.png', data, type: 'image/png' }]),
      window.saveToLocalDB('tracks', [{ name: 'local.mp3', data, type: 'audio/mpeg' }]),
    ]);
    await window.saveToLocalDB('files', [{ name: 'local.txt', data }]);

    window.invalidateWallpaperCache();
    window.invalidateTrackCache();
    const wallpaper = (await window.getAllWallpapers()).find(item => item.name === 'local.png');
    const track = (await window.getAllTracks()).find(item => item.name === 'local.mp3');
    if (!wallpaper || !track) return { wallpaper, track };

    await window.removeCustomWallpaper(wallpaper.id);
    await window.deleteBGMById(track.id);

    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = storeName => new Promise((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const counts = {
      wallpapers: await count('wallpapers'),
      tracks: await count('tracks'),
      files: await count('files'),
    };
    const version = db.version;
    db.close();
    return { wallpaperId: wallpaper.id, trackId: track.id, counts, version };
  });

  expect(result.wallpaperId).toMatch(/^local_wp_\d+$/);
  expect(result.trackId).toMatch(/^local_\d+$/);
  expect(result.version).toBeGreaterThanOrEqual(3);
  expect(result.counts).toEqual({ wallpapers: 0, tracks: 0, files: 1 });
});
