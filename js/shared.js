/**
 * ==================== 全局常量 — IIFE 兼容层 ====================
 *
 * 【这是什么】
 *   全局常量的唯一真实来源。classic <script defer> 先执行，设置 window.*。
 *   config.mjs (ESM) 从 window 读取 re-export 给 ESM 消费者。
 *   改常量只改这一个文件——config.mjs 自动同步。
 *
 * 【加载顺序】
 *   本文件作为 classic defer script 在 index.html 中先加载。
 *   supabase.js 依赖 window.SUPABASE_URL 初始化客户端。
 *   config.mjs 作为 ESM 后加载，从 window 读取并 re-export。
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
