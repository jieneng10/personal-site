/**
 * ==================== 全局常量 — IIFE 兼容层 ====================
 *
 * 【这是什么】
 *   和 config.mjs 内容相同，但是用旧式 IIFE 写法。
 *   旧的业务模块（articles.js, wallpaper.js 等）读 window.SUPABASE_URL，
 *   这些值就在这个文件里设置。
 *
 * 【什么时候删掉这个文件】
 *   等所有 IIFE 模块都迁移成 ES Module 之后，
 *   所有模块直接 import config.mjs，这个文件就可以删了。
 *
 * 【当前状态】
 *   这个文件和 config.mjs 同时存在，内容保持一致。
 *   改常量的时候两个文件都要改（临时状态，迁移完就不用了）。
 *
 * 【注意】
 *   - SUPABASE_KEY 是 anon key（公开密钥），可以安全放在前端
 *   - 不要在这里放 service_role key
 */
(function() {

  // ═══════════════════════════════════════════════════════════
  // Supabase 项目配置
  // ═══════════════════════════════════════════════════════════

  /** Supabase 项目 URL — 如果换项目，改这一个字符串就行 */
  var SUPABASE_URL = 'https://nskircwzcsmbkispshif.supabase.co';

  /**
   * Supabase 匿名密钥（anon key）
   * 这是公开密钥，权限受 RLS 策略限制
   * 不要替换成 service_role key！
   */
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5za2lyY3d6Y3NtYmtpc3BzaGlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMDY0MzYsImV4cCI6MjA5NDY4MjQzNn0.jZESXIc71IAVcCEY7nLGJvpPF2XIvm-hyb6-DOKfiE0';

  // ═══════════════════════════════════════════════════════════
  // IndexedDB 本地数据库配置
  // ═══════════════════════════════════════════════════════════

  /**
   * IndexedDB 数据库名称
   * 浏览器本地数据库，存离线壁纸/BGM/文件
   * 改这个名字会导致用户之前的离线数据"丢失"（名字变了找不到旧库）
   */
  var DB_NAME = 'PersonalSiteDB';

  /**
   * IndexedDB 版本号
   * 如果新增/删除表（object store），要 +1
   * 浏览器会在版本变化时触发 onupgradeneeded 重建表结构
   */
  var DB_VERSION = 1;

  // ═══════════════════════════════════════════════════════════
  // 挂载到 window（让所有 IIFE 模块和 ESM 包装层都能读到）
  // ═══════════════════════════════════════════════════════════

  window.SUPABASE_URL = SUPABASE_URL;
  window.SUPABASE_KEY = SUPABASE_KEY;
  window.DB_NAME      = DB_NAME;
  window.DB_VERSION   = DB_VERSION;

  // ═══════════════════════════════════════════════════════════
  // 安全写入 localStorage
  // ═══════════════════════════════════════════════════════════

  /**
   * 安全写入 localStorage（配额满了不会崩溃）
   *
   * 浏览器 localStorage 有 5-10MB 配额，满了会抛异常。
   * 这个函数用 try/catch 兜底，写入失败只打印警告，不会让网站崩溃。
   *
   * @param {string} key   - 键名
   * @param {string} value - 值（必须是字符串！对象要先 JSON.stringify）
   *
   * 【示例】
   *   safeSetItem('wallpaperIdx', '3');
   *   safeSetItem('siteSettings', JSON.stringify(settingsObject));
   */
  function safeSetItem(key, value) {
    try { localStorage.setItem(key, value); }
    catch (e) { console.warn('[storage] 写入失败:', key, e); }
  }

  window.safeSetItem = safeSetItem;
})();
