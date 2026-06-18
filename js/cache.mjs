/**
 * ==================== Cache — ES Module 包装层 ====================
 *
 * 【为什么有这个文件】
 *   和 event-bus.mjs 一样的道理——cache.js 是旧式 IIFE，
 *   createCache 挂在 window 上，这个文件把它转成 ES Module export。
 *
 * 【怎么用】
 *   import { createCache } from './cache.mjs';
 *   const _cache = createCache(expensiveFetch, 300_000);
 *   const data = await _cache.get();        // 有缓存就用缓存
 *   const data = await _cache.get(true);     // 强制刷新
 *   _cache.invalidate();                     // 清空缓存
 *
 * 【加载顺序】
 *   cache.js（classic）先于 cache.mjs（module），确保 window.createCache 已就绪
 */

export const createCache = window.createCache;
