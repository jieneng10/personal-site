/**
 * ==================== Supabase — ES Module 包装层 ====================
 *
 * 【为什么有这个文件】
 *   supabase.js 是旧式 IIFE，所有函数挂在 window 上。
 *   新的 ES Module 不应该读 window，应该用 import。
 *   这个文件把 window 上的 12 个函数转成 ES Module export。
 *
 * 【怎么用（新模块推荐写法）】
 *   import { sb, escHtml, showToast } from './supabase.mjs';
 *   showToast('操作成功', 'success');
 *
 * 【旧模块仍然用旧写法】
 *   window.showToast('操作成功', 'success');  // 也能用，不冲突
 *
 * 【加载顺序（重要！）】
 *   supabase.js（classic defer script）先执行 → window.xxx 就绪
 *   supabase.mjs（module script）后执行 → 安全地从 window 取值导出
 *   如果顺序反了，所有 export 都是 undefined
 */

export const sb            = window.sb;            // Supabase 客户端
export const sbStoragePath = window.sbStoragePath; // 生成存储路径
export const sbUpload      = window.sbUpload;      // 上传文件
export const sbPublicUrl   = window.sbPublicUrl;   // 公开 URL
export const sbSignedUrl   = window.sbSignedUrl;   // 临时签名 URL
export const sbDelete      = window.sbDelete;      // 批量删除文件
export const escHtml       = window.escHtml;       // HTML 转义（防 XSS）
export const getCachedUser = window.getCachedUser; // 获取当前用户
export const showLoading   = window.showLoading;   // 顶部 loading
export const hideLoading   = window.hideLoading;   // 隐藏 loading
export const showToast     = window.showToast;     // 弹出 toast 通知
export const saveToLocalDB = window.saveToLocalDB; // 写 IndexedDB
