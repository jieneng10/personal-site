import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

function createWorker(fetchImpl) {
  const handlers = {};
  const cache = {
    match: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    addAll: vi.fn().mockResolvedValue(undefined),
  };
  const caches = { open: vi.fn().mockResolvedValue(cache) };
  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://site.example' },
      registration: { scope: 'https://site.example/' },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      skipWaiting: vi.fn(),
    },
    caches,
    fetch: fetchImpl,
    Response,
    URL,
    console,
  });
  return { fetchHandler: handlers.fetch, installHandler: handlers.install, cache, caches };
}

describe('service worker fetch', () => {
  it('pre-caches assets under the active scope for root previews', async () => {
    const { installHandler, cache } = createWorker(vi.fn());
    let installation;
    installHandler({ waitUntil: promise => { installation = promise; } });
    await installation;
    const assets = cache.addAll.mock.calls[0][0];
    expect(assets).toContain('https://site.example/index.html');
    expect(assets).not.toContain('https://site.example/personal-site/index.html');
  });

  it('leaves third-party requests to the browser', () => {
    const fetchImpl = vi.fn();
    const { fetchHandler, caches } = createWorker(fetchImpl);
    const respondWith = vi.fn();
    fetchHandler({ request: { method: 'GET', url: 'https://cdn.example/script.js' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();
  });

  it.each([
    ['/personal-site/data/articles.json', /^ps-core-/],
    ['/personal-site/static/bgm/song.mp3', /^ps-media-/],
  ])('returns an offline response for uncached %s', async (path, cacheName) => {
    const { fetchHandler, caches } = createWorker(vi.fn().mockRejectedValue(new Error('offline')));
    let response;
    fetchHandler({
      request: { method: 'GET', url: 'https://site.example' + path },
      respondWith: promise => { response = promise; },
    });
    expect((await response).status).toBe(503);
    expect(caches.open).toHaveBeenCalledWith(expect.stringMatching(cacheName));
  });
});
