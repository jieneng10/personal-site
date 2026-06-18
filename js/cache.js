// ==================== Cache Utility — TTL Memoisation ====================
// Every data module (articles, wallpaper, bgm) had the same 20-line manual
// cache pattern.  This extracts it once so each module only describes *what*
// to fetch and how long to keep it.
(function() {
  /**
   * Create a time-to-live cache for an async fetch function.
   *
   * @template T
   * @param {() => Promise<T>} fetchFn - Async function that produces fresh data
   * @param {number} ttlMs               - Cache lifetime in milliseconds
   * @returns {{ get: (forceRefresh?: boolean) => Promise<T>, invalidate: () => void }}
   *
   * @example
   * var _wallpaperCache = createCache(getAllWallpapersImpl, 600_000);
   * // later …
   * var items = await _wallpaperCache.get();        // cached if fresh
   * var items = await _wallpaperCache.get(true);    // force refresh
   * _wallpaperCache.invalidate();                   // clear TTL (next get() refetches)
   */
  function createCache(fetchFn, ttlMs) {
    var _data = null;   // cached value
    var _ts   = 0;      // timestamp of last fetch (ms)
    var _pending = null; // in-flight promise — deduplicate concurrent requests

    /**
     * Get data, optionally forcing a refresh.
     * @param {boolean} [forceRefresh]
     * @returns {Promise<T>}
     */
    async function get(forceRefresh) {
      if (!forceRefresh && _data !== null && Date.now() - _ts < ttlMs) {
        return _data;
      }
      // Deduplicate concurrent fetches — if a request is already in flight
      // while the cache is stale, share the same promise.
      // B-8: forceRefresh 时不复用过期 pending，确保调用方拿到最新数据
      if (!forceRefresh && _pending) return _pending;

      _pending = fetchFn();
      try {
        var result = await _pending;
        _data = result;
        _ts = Date.now();
        return result;
      } finally {
        _pending = null;
      }
    }

    /** Discard cached data so the next get() always refetches. */
    function invalidate() {
      _data = null;
      _ts = 0;
    }

    return { get: get, invalidate: invalidate };
  }

  window.createCache = createCache;
})();
