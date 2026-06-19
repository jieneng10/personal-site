/**
 * ==================== 缓存工具 — TTL 缓存（ESM） ====================
 *
 * 带过期时间的缓存。拉一次数据存起来，TTL 内复用，过期重新拉。
 * 内置并发去重：多个并发 get() 共享一次请求。
 *
 * import { createCache } from './cache.mjs';
 * const _cache = createCache(fetchFn, 300_000);
 * const data = await _cache.get();       // 走缓存
 * const data = await _cache.get(true);   // 强制刷新
 * _cache.invalidate();                   // 清空
 */

export function createCache(fetchFn, ttlMs) {

  var _data    = null;
  var _ts      = 0;
  var _pending = null;

  async function get(forceRefresh) {
    if (!forceRefresh && _data !== null && Date.now() - _ts < ttlMs) {
      return _data;
    }
    if (!forceRefresh && _pending) {
      return _pending;
    }
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

  function invalidate() {
    _data = null;
    _ts   = 0;
  }

  return { get, invalidate };
}

// Backward compat: classic supabase.js reads window.createCache (not used anymore)
window.createCache = createCache;
