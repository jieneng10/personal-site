/**
 * i18n.js — 国际化支持模块 (ESM)
 *
 * 【它做什么】
 *   从 data/i18n/zh-CN.json 加载中文字符串映射表，
 *   导出 t(key) 函数供其他模块使用。
 *
 * 【设计原则】
 *   - 扁平 dot-notation key 结构 (如 "nav.home" → "🏠 首页")
 *   - t(key) 在找到翻译时返回中文字符串，未找到时返回 key 本身作为 fallback
 *   - 支持插值：t('cloud.fileSizeLimit', { name: 'myfile.zip' })
 *     字符串中的 {name} 会被替换为传入的值
 *
 * 【使用方式】
 *   import { t } from './i18n.js';
 *   t('nav.home');  // "🏠 首页"
 *   t('unknown.key');  // "unknown.key" (fallback)
 *   t('cloud.fileSizeLimit', { name: 'myfile.zip' });  // 插值
 */

/** @type {Record<string, string> | null} */
let _translations = null;

/**
 * 加载语言包
 * @returns {Promise<Record<string, string>>}
 */
async function _load() {
  if (_translations) return _translations;
  try {
    const resp = await fetch('data/i18n/zh-CN.json');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    _translations = await resp.json();
    return _translations;
  } catch (e) {
    console.warn('[i18n] 无法加载语言包，使用 key 作为 fallback:', e.message);
    _translations = {};
    return _translations;
  }
}

/**
 * 获取翻译字符串
 *
 * @param {string} key — 翻译键 (如 "nav.home")
 * @param {Record<string, string|number>} [params] — 可选插值参数
 * @returns {Promise<string>} 翻译后的字符串
 *
 * @example
 *   await t('nav.home');  // "🏠 首页"
 *   await t('cloud.fileSizeLimit', { name: 'myfile.zip' });
 *   // "文件 myfile.zip 超过 50MB 限制"
 */
export async function t(key, params) {
  const dict = await _load();
  let value = dict[key] !== undefined ? dict[key] : key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
  }

  return value;
}

/**
 * 同步版本：直接从已加载的缓存中取，若未加载则返回 key
 * 适用于不能使用 await 的场景（如 innerHTML 赋值表达式）
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function tSync(key, params) {
  const dict = _translations || {};
  let value = dict[key] !== undefined ? dict[key] : key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
  }

  return value;
}

/**
 * 预加载语言包（可在页面初始化时调用，避免首次 t() 的异步延迟）
 * @returns {Promise<void>}
 */
export async function initI18n() {
  await _load();
}

// Backward-compat: 让 IIFE 模块通过 window.initI18n() 调用
window.i18n = { t, tSync, init: initI18n };
window.initI18n = initI18n;
window.I18n = { t, tSync, init: initI18n };
