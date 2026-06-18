/**
 * ==================== 全局配置 — ES Module ====================
 *
 * 【这是什么】
 *   整个网站的"开关面板"——所有其他模块需要的常量都存在这里。
 *   比如"后端地址是什么""数据库叫什么名字"，只在这里写一次，
 *   其他地方 import 引用，改一处全站生效。
 *
 * 【什么时候用这个文件】
 *   - 要新增一个全局常量（比如加了新的 Supabase bucket 名称）
 *   - 要改 Supabase 项目地址（迁移到新项目时）
 *   - 所有 import 了 config.mjs 的模块会自动拿到最新值
 *
 * 【注意】
 *   - SUPABASE_KEY 是 anon key（公开密钥），可以安全放在前端
 *   - 不要在这里放 service_role key（管理员密钥），那会泄露权限
 *   - 这个文件的 .mjs 版本只给新式 ES Module 用
 *   - 旧的 IIFE 模块仍然读 window.SUPABASE_URL（在 shared.js 里设置）
 */

// ─── Supabase 连接 ──────────────────────────────────────

/**
 * Supabase 项目的 URL
 * 格式固定：https://<项目ID>.supabase.co
 * 如果你把网站迁移到新的 Supabase 项目，只改这里就行
 */
export const SUPABASE_URL = 'https://nskircwzcsmbkispshif.supabase.co';

/**
 * Supabase 匿名密钥（anon key）
 * 这个密钥是公开的、安全的，权限受 RLS 策略限制
 * 不要替换成 service_role key！
 */
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5za2lyY3d6Y3NtYmtpc3BzaGlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMDY0MzYsImV4cCI6MjA5NDY4MjQzNn0.jZESXIc71IAVcCEY7nLGJvpPF2XIvm-hyb6-DOKfiE0';

// ─── 本地数据库（IndexedDB）───────────────────────────────

/**
 * IndexedDB 数据库名称
 * 浏览器本地数据库，用来存离线数据（壁纸/BGM/文件）
 * 改这个会导致用户之前的离线数据"丢失"（因为新名字找不到旧库）
 */
export const DB_NAME = 'PersonalSiteDB';

/**
 * IndexedDB 版本号
 * 如果你改了数据库结构（新增/删除表），要递增这个数字
 * 浏览器检测到版本变化会自动触发 onupgradeneeded
 */
export const DB_VERSION = 1;

// ─── 工具函数 ───────────────────────────────────────────

/**
 * 安全写入 localStorage
 *
 * 【为什么需要这个函数】
 *   浏览器 localStorage 有 5-10MB 配额限制
 *   配额满了之后 localStorage.setItem() 会抛异常（静默失败）
 *   这个函数用 try/catch 包住，失败时打印警告但不会让网站崩溃
 *
 * 【参数】
 *   @param {string} key   - 存储键名，如 'wallpaperIdx'
 *   @param {string} value - 存储值，复杂对象要先 JSON.stringify()
 *
 * 【示例】
 *   safeSetItem('wallpaperIdx', '3');              // 简单值
 *   safeSetItem('cache', JSON.stringify(obj));     // 对象必须先转字符串
 *
 * 【注意】
 *   - 只接受字符串！数字、对象会报错
 *   - 写入失败只是打印警告，不会弹窗告诉用户
 */
export function safeSetItem(key, value) {
  try { localStorage.setItem(key, value); }
  catch (e) { console.warn('[storage] 写入失败:', key, e); }
}
