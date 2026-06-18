/**
 * ==================== 缓存工具 — 带过期时间的记忆功能 ====================
 *
 * 【这是什么】
 *   一个"记住答案"的工具。比如从 Supabase 拉壁纸列表很慢（网络请求），
 *   拉一次之后把结果存起来，下次直接用存的，直到过期了再重新拉。
 *
 * 【为什么需要它】
 *   以前每个模块（articles/wallpaper/bgm）都自己写一套缓存逻辑，
 *   代码重复了 5 次。现在只写一次，所有模块共用。
 *
 * 【核心概念 — TTL（Time To Live，存活时间）】
 *   数据"新鲜"多久。比如 600_000 毫秒 = 10 分钟。
 *   10 分钟内反复调用 get() 都返回同一份缓存，不发起网络请求。
 *   10 分钟后缓存"过期"，下一次 get() 会重新拉取。
 *
 * 【怎么用 — 三步走】
 *   第 1 步：创建缓存（给一个拉数据的函数 + 过期时间）
 *     var _cache = createCache(getAllTracks, 30_000);  // 30 秒过期
 *
 *   第 2 步：读取数据
 *     var tracks = await _cache.get();      // 缓存新鲜就用缓存，否则重新拉
 *     var tracks = await _cache.get(true);  // 强制重新拉，忽略缓存
 *
 *   第 3 步（可选）：手动清空缓存
 *     _cache.invalidate();  // 下次 get() 会重新拉数据
 *
 * 【内置防护】
 *   - 并发去重：如果缓存过期了，A 和 B 同时调用 get()，
 *     只有 A 真正发起请求，B 等着 A 的结果——不会发两次重复请求
 *   - forceRefresh（强制刷新）：传 true 时不复用正在进行的请求，确保拿到最新数据
 */
(function() {

  /**
   * 创建一个 TTL 缓存
   *
   * @param {Function} fetchFn - 拉数据的异步函数（必须返回 Promise）
   * @param {number}   ttlMs   - 缓存有效期，单位毫秒
   *                             常用值：30_000(30秒) / 300_000(5分钟) / 600_000(10分钟)
   * @returns {{ get: Function, invalidate: Function }}
   *
   * 【示例】
   *   // 创建
   *   var _wallpaperCache = createCache(async function() {
   *     return await fetchWallpapersFromSupabase();  // 这个操作很慢
   *   }, 600_000);  // 缓存 10 分钟
   *
   *   // 使用
   *   var items = await _wallpaperCache.get();  // 第一次：发起网络请求
   *   var items = await _wallpaperCache.get();  // 10 分钟内：直接返回缓存
   *   var items = await _wallpaperCache.get(true); // 强制刷新，忽略缓存
   *   _wallpaperCache.invalidate();             // 手动清空
   */
  function createCache(fetchFn, ttlMs) {

    // ─── 内部状态 ─────────────────────────────
    var _data    = null;  // 缓存的数据本体（null = 还没有数据）
    var _ts      = 0;     // 上次拉取的时间戳（毫秒），0 = 从未拉取
    var _pending = null;  // 正在进行中的请求 Promise
                          // null = 没有请求在进行
                          // 有值 = 正在拉数据，其他人等我结果就好

    /**
     * 获取数据（优先用缓存）
     *
     * @param {boolean} [forceRefresh] - 传 true 跳过缓存，强制重新拉取
     * @returns {Promise<*>} 缓存或新拉取的数据
     */
    async function get(forceRefresh) {

      // 情况 1：缓存新鲜且没有强制刷新 → 直接用缓存
      //         条件：forceRefresh 不为 true、缓存非空、缓存未过期
      if (!forceRefresh && _data !== null && Date.now() - _ts < ttlMs) {
        return _data;
      }

      // 情况 2：缓存过期了但已经有人在拉数据 → 复用那个进行中的请求
      //         避免 A 和 B 同时触发两次相同的网络请求
      //         但是如果 forceRefresh 为 true，不共享——你要新的，我给你新的
      if (!forceRefresh && _pending) {
        return _pending;
      }

      // 情况 3：需要真正发起请求
      //         记录 _pending 让后续并发调用者知道"我正在拉"
      _pending = fetchFn();
      try {
        var result = await _pending;  // 等待请求完成
        _data = result;               // 存入缓存
        _ts = Date.now();             // 记录拉取时间
        return result;
      } finally {
        // finally = 无论成功还是失败，都清理 _pending
        // 这样下次调用可以发起新请求，不会永远卡在"进行中"
        _pending = null;
      }
    }

    /**
     * 清空缓存
     * 调用后下一次 get() 会重新拉数据
     * 不会取消正在进行的请求（那个请求跑完了会自己更新缓存）
     */
    function invalidate() {
      _data = null;
      _ts   = 0;
    }

    // 返回两个方法：读数据 和 清缓存
    return { get: get, invalidate: invalidate };
  }

  // 让所有 IIFE 模块都能直接 createCache(...)
  window.createCache = createCache;
})();
