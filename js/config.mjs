/**
 * ==================== 全局配置 — ES Module ====================
 *
 * 从 window 读取常量（由 shared.js 经典脚本设置），re-export 给 ESM 消费者。
 * shared.js 是常量的唯一真实来源——改常量只改那一处。
 *
 * 经典脚本在 ESM module 之前执行，确保 window.* 已就绪。
 *
 * SUPABASE_KEY 是 anon key（公开密钥），可安全放在前端。
 * 不要在这里放 service_role key！
 */

export const SUPABASE_URL = window.SUPABASE_URL;
export const SUPABASE_KEY = window.SUPABASE_KEY;
export const DB_NAME      = window.DB_NAME;
export const DB_VERSION   = window.DB_VERSION;
export const safeSetItem  = window.safeSetItem;
