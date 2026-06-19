/**
 * settings.js — 用户设置与账号管理模块
 *
 * 【这是什么】
 *   个人站点核心配置模块，负责：用户偏好设置的读写与持久化（localStorage）、
 *   Supabase 账号登录/注册/登出/密码修改、设置云同步（user_settings 表）、
 *   设置面板 UI 事件绑定、以及将设置状态同步到页面 DOM（applyAllSettings）。
 *
 * 【数据流向概览】
 *   localStorage('siteSettings')  ←→  _settingsCache（内存缓存，5 秒 TTL）
 *        ↓ saveSettings                         ↓ loadSettings
 *   Supabase user_settings 表   ←→   各 UI 开关 / 输入框 / 侧边栏显隐
 *
 * 【与 window 全局变量的关系】
 *   - 读取：window.sb（Supabase 客户端）、window.safeSetItem（安全 localStorage 写入器）、
 *          window.switchSection、window.applyWallpaper、window.renderFileList、
 *          window.renderBGMPlaylist、window.migrateLocalToCloud、window.clearCloudData、
 *          window._isLoggedIn、window._sakuraCanvas、window.sakuraAnimId、window.tickSakura、
 *          window.EventBus（看其他模块是否已挂载）
 *   - 写入：window.defaultSettings、window.loadSettings、window.saveSettings、
 *          window.getSetting、window.toggleSetting、window.applyAllSettings、
 *          window.resetAllSettings、window.bindSettingsEvents、window.handleLockBtnClick、
 *          window.syncSettingsFromCloud、window.sakuraEnabled
 *
 * 【调用链】
 *   入口：main.js 在 DOMContentLoaded 时调用 bindSettingsEvents() 绑定 UI 事件，
 *        然后调用 applyAllSettings() 从 localStorage 恢复全部设置到页面。
 *   运行时：用户点击开关/修改输入 → 事件回调 → saveSettings → applyAllSettings。
 *   云同步：登录后调用 syncSettingsFromCloud() 拉取云端；applyAllSettings() 末尾
 *          自动调用 syncSettingsToCloud() 推送。
 *   nav.js / 其他模块：通过 window.getSetting(key) 读取设置项。
 */


import { sb, showLoading, hideLoading, showToast, saveToLocalDB, getCachedUser, escHtml } from './supabase.mjs';


// ============================================================================
// 默认设置 — 所有可配置项的初始值。
// 当 localStorage 中无对应 key 时回退至此。
// 新增设置项时需要同时在这里和 HTML 表单中添加对应的输入控件。
// ============================================================================
var defaultSettings = {
  sakuraEnabled: true,      // 樱花粒子动画开关
  cloudVisible: true,       // 侧边栏「文件」入口是否可见
  articlesVisible: true,    // 侧边栏「文章」入口是否可见
  nickname: 'jieneng',      // 用户昵称，显示在首页头像旁
  signature: '这并非对我的束缚，而是我对她的礼仪',  // 个性签名
  intro: '这里是jieneng的个人小站。喜欢在深夜推 galgame、听动漫 OST。\n信奉「优雅的文字即诗」，也相信每一部视觉小说都是一个世界。\n欢迎来到我的秘密基地 ✦',  // 个人介绍（支持换行）
  socialGitHub: '',         // GitHub 链接
  socialQQ: '',             // QQ 链接
  socialBilibili: '',       // Bilibili 链接
  socialEmail: '',          // Email 链接
};

// ============================================================================
// 设置缓存 — 减少对 localStorage 的同步 I/O 调用
// ============================================================================

/** 内存中的设置快照，避免每次 getSetting 都调用 JSON.parse */
var _settingsCache = null;
/** 缓存写入时间戳（ms），用于 TTL 判断 */
var _cacheTs = 0;

// ============================================================================
// 本地持久化层
// ============================================================================

/**
 * loadSettings — 从 localStorage 加载设置对象（带缓存）
 *
 * 【它做什么】
 *   读取 localStorage 中的 'siteSettings' 键，解析为 JSON 对象。
 *   5 秒内的重复调用直接返回内存缓存，不碰 localStorage。
 *   解析失败时返回空对象。
 *
 * 【输入】无
 *
 * 【输出】Object — 用户设置对象（可能是空对象 {}）
 *
 * 【副作用】更新 _settingsCache 和 _cacheTs（内存缓存写入）
 *
 * 【调用者】
 *   本模块内：getSetting()、toggleSetting()、renderSocialLinks()、applyAllSettings()
 *   外部模块：通过 window.loadSettings 被其他 JS 文件读取设置
 *
 * 【为什么用缓存】
 *   localStorage 是同步 API，在 UI 频繁刷新时（如 applyAllSettings 可能被多次调用）
��证设置变更后最多 5 秒生效。
 */
function loadSettings() {
if (_settingsCache && Date.now() - _cacheTs < 5000) return _settingsCache;
try {
  _settingsCache = JSON.parse(localStorage.getItem('siteSettings')) || {};
  _cacheTs = Date.now();
  return _settingsCache;
} catch (e) { return {}; }
}

/**
 * saveSettings — 将设置对象写入 localStorage 并同步内存缓存
 *
 * 【它做什么】
 *   同时更新内存缓存 _settingsCache 和 localStorage。
 *   使用 window.safeSetItem 而非原生 localStorage.setItem，
 *   因为 safeSetItem 在 Safari 隐私模式等 localStorage 不可用时静默失败。
 *
 * 【输入】
 *   s — Object，完整的设置对象（不是增量 patch）
 *
 * 【输出】无
 *
 * 【副作用】
 *   写入 _settingsCache、_cacheTs、localStorage('siteSettings')
 *
 * 【调用者】
 *   本模块：toggleSetting()、syncSettingsFromCloud()
 *   外部：profile 输入 change 事件回调、window.saveSettings
 *
 * 【为什么用 safeSetItem 而不是直接 setItem】
 *   safeSetItem（定义在 main.js）对 localStorage 不可用场景做了 try/catch 包装，
 *   避免 Safari 隐私模式 / 存储满 / 用户禁止 Cookie 时抛出未捕获异常导致页面白屏。
 */
function saveSettings(s) {
_settingsCache = s;
_cacheTs = Date.now();
window.safeSetItem('siteSettings', JSON.stringify(s));
}

/**
 * getSetting — 读取单个设置项的值
 *
 * 【它做什么】
 *   先从 localStorage（经缓存）读取用户设置；如果该 key 不存在，
 *   回退到 defaultSettings 中的默认值。
 *
 * 【输入】
 *   key — String，设置项名称（如 'sakuraEnabled'）
 *
 * 【输出】
 *   对应 key 的值（类型取决于该设置项：Boolean / String）
 *
 * 【副作用】无（读操作）
 *
 * 【调用者】
 *   本模块：toggleSetting() 中判断当前值
 *   外部模块：通过 window.getSetting 读取任意设置项（如壁纸模块、动画模块）
 *
 * 【为什么 undefined 检查用 !== undefined 而不是 !s[key]】
 *   因为 false 和空字符串 '' 是合法的设置值，
 *   不能用 truthy/falsy 判断，必须严格区分「未设置」和「设置为 falsy 值」。
 */
function getSetting(key) {
var s = loadSettings();
return s[key] !== undefined ? s[key] : defaultSettings[key];
}

/**
 * toggleSetting — 切换 Boolean 类型设置项并刷新 UI
 *
 * 【它做什么】
 *   读取当前值并取反，保存，然后调用 applyAllSettings 刷新整个页面。
 *
 * 【输入】
 *   key — String，Boolean 类型的设置项名称（如 'sakuraEnabled'）
 *
 * 【输出】无
 *
 * 【副作用】
 *   写 localStorage（通过 saveSettings），
 *   调用 applyAllSettings 刷新页面 DOM
 *
 * 【调用者】
 *   settings 面板中 data-action="toggle" 按钮的点击委托事件
 */
function toggleSetting(key) {
var s = loadSettings();
s[key] = !getSetting(key);
saveSettings(s);
applyAllSettings();
}

// ============================================================================
// Supabase 认证方法
// ============================================================================

/**
 * sbLogin — Supabase 邮箱密码登录
 *
 * 【它做什么】
 *   调用 Supabase Auth API 进行邮箱密码登录。
 *   成功后设置 window._isLoggedIn = true 并跳转首页。
 *   失败时在 #loginError 元素显示错误信息，并清空密码框。
 *
 * 【输入】
 *   email — String，用户邮箱
 *   password — String，明文密码（由 Supabase SDK 安全传输）
 *
 * 【输出】
 *   Boolean — 登录成功返回 true，失败返回 false
 *
 * 【副作用】
 *   - 显示/隐藏 loading 遮罩（showLoading / hideLoading）
 *   - 登录失败：设置 #loginError 文本、清空 #loginPassword
 *   - 登录成功：设置 window._isLoggedIn = true、调用 switchSection('home') 跳转、
 *     显示 toast 提示
 *
 * 【调用者】
 *   bindSettingsEvents 中 #btnLogin 的 click 事件回调
 *
 * 【为什么登录成功要设 _isLoggedIn】
 *   _isLoggedIn 是全局登录状态标志，其他模块（如 syncSettingsToCloud）
 *   在操作 Supabase 前会检查此标志，避免在未登录时发送无效请求。
 *
 * 【为什么切换 'Invalid login credentials' 为中文】
 *   Supabase 默认返回英文错误消息，直接展示给中文用户不友好。
 */
async function sbLogin(email, password) {
if (!sb) { showToast('服务不可用', 'warn'); return false; }
showLoading('登录中...');
var result = await sb.auth.signInWithPassword({ email: email, password: password });
hideLoading();
if (result.error) {
  var msg = result.error.message === 'Invalid login credentials' ? '邮箱或密码错误' : result.error.message;
  var errEl = document.getElementById('loginError');
  if (errEl) errEl.textContent = msg;
  document.getElementById('loginPassword').value = '';
  return false;
}
document.getElementById('loginError').textContent = '';
document.getElementById('loginPassword').value = '';
window._isLoggedIn = true;
showToast('登录成功！', 'success');
if (typeof window.switchSection === 'function') window.switchSection('home');
return true;
}

/**
 * sbRegister — Supabase 邮箱注册
 *
 * 【它做什么】
 *   调用 Supabase Auth API 注册新用户。注册成功后 Supabase 自动登录该用户。
 *
 * 【输入】
 *   email — String
 *   password — String
 *
 * 【输出】
 *   Boolean — 注册成功返回 true，失败返回 false
 *
 * 【副作用】
 *   - 显示/隐藏 loading 遮罩
 *   - 失败时在 #loginError 显示错误消息
 *   - 成功时显示 toast 提示
 *
 * 【调用者】
 *   注册表单提交事件（如果存在注册按钮）
 *
 * 【注意】
 *   Supabase signUp 默认会发送确认邮件。如果项目配置关闭了邮件确认，
 *   则注册后直接登录。此处没有设置 window._isLoggedIn，
 *   因为注册成功后用户需通过 Supabase session 事件感知登录状态。
 */
async function sbRegister(email, password) {
if (!sb) { showToast('服务不可用', 'warn'); return false; }
showLoading('注册中...');
var result = await sb.auth.signUp({ email: email, password: password });
hideLoading();
if (result.error) {
  var errEl = document.getElementById('loginError');
  if (errEl) errEl.textContent = result.error.message;
  return false;
}
showToast('注册成功！已自动登录。', 'success');
return true;
}

/**
 * sbLogout — Supabase 登出
 *
 * 【它做什么】
 *   调用 Supabase Auth API 登出当前用户，清除 session。
 *
 * 【输入】无
 *
 * 【输出】无
 *
 * 【副作用】
 *   清除 Supabase 本地 session（由 SDK 内部处理）
 *
 * 【调用者】
 *   handleLockBtnClick() — 用户点击锁按钮确认登出时
 */
async function sbLogout() {
if (!sb) return;
await sb.auth.signOut();
}

// ============================================================================
// 设置云同步 — 将 localStorage 设置与 Supabase user_settings 表双向同步
// ============================================================================

/**
 * syncSettingsToCloud — 将本地设置推送到 Supabase
 *
 * 【它做什么】
 *   读取当前本地设置，使用 upsert 写入 Supabase 的 user_settings 表。
 *   如果该用户已有记录则更新，无记录则插入。
 *   未登录或 Supabase 不可用时静默跳过。
 *
 * 【输入】无（从 loadSettings 获取）
 *
 * 【输出】无
 *
 * 【副作用】
 *   写入 Supabase 数据库（user_settings 表）
 *
 * 【调用者】
 *   applyAllSettings() 末尾自动调用（每次设置变更时自动同步）
 *
 * 【为什么静默失败】
 *   云同步是辅助功能，不应因为网络问题或数据库故障阻断用户本地操作。
 *   下次成功调用时会覆盖旧数据（upsert 幂等）。
 *
 * 【为什么用 upsert + onConflict: 'user_id'】
 *   每个用户只需一条设置记录，upsert 避免了先查后插的竞态条件。
 */
async function syncSettingsToCloud() {
if (!sb || !window._isLoggedIn) return;
try {
  var user = await getCachedUser();
  if (!user) return;
  var s = loadSettings();
  await sb.from('user_settings').upsert({
    user_id: user.id,
    settings: s,
    updated_at: new Date(),
  }, { onConflict: 'user_id' });
} catch (e) { /* 静默失败 */ }
}

/**
 * syncSettingsFromCloud — 从 Supabase 拉取设置并覆盖本地
 *
 * 【它做什么】
 *   查询 Supabase user_settings 表中当前用户的设置记录，
 *   如果存在则覆盖 localStorage 并刷新 UI。
 *
 * 【输入】无
 *
 * 【输出】无
 *
 * 【副作用】
 *   写入 localStorage（通过 saveSettings），
 *   刷新全部 UI（通过 applyAllSettings）
 *
 * 【调用者】
 *   登录成功后的初始化流程（main.js 中调用）
 *
 * 【为什么失败时保持本地设置】
 *   云端可能没有记录（新用户）或网络异常，本地设置是用户已有的数据，
 *   不应因云同步失败而丢失。
 */
async function syncSettingsFromCloud() {
if (!sb || !window._isLoggedIn) return;
try {
  var user = await getCachedUser();
  if (!user) return;
  var result = await sb.from('user_settings')
    .select('settings')
    .eq('user_id', user.id)
    .limit(1);
  if (result.data && result.data.length > 0 && result.data[0].settings) {
    saveSettings(result.data[0].settings);
    applyAllSettings();
  }
} catch (e) { /* 保持本地设置 */ }
}

// ============================================================================
// 社交链接渲染
// ============================================================================

/**
 * renderSocialLinks — 渲染首页社交链接图标
 *
 * 【它做什么】
 *   读取设置中填写的社交链接，过滤掉空值和危险协议（javascript: / data: / vbscript:），
 *   在 #socialLinks 容器中渲染为带图标的 <a> 标签。
 *
 * 【为什么过滤 javascript:/data:/vbscript: 协议】
 *   社交链接是用户输入的数据，虽然存储在自己浏览器中不太可能被 XSS 利用，
 *   但作为一种纵深防御，防止用户误粘贴恶意链接后点击触发脚本执行。
 *   这是对 escHtml 的补充——escHtml 防止 HTML 注入，协议过滤防止 URL scheme 攻击。
 *
 * 【输入】无（从 loadSettings 获取）
 *
 * 【输出】无
 *
 * 【副作用】修改 #socialLinks 的 innerHTML
 *
 * 【调用者】
 *   applyAllSettings() 中调用，
 *   社交链接输入框 change 事件回调中也单独调用
 */
function renderSocialLinks() {
var s = loadSettings();
var links = [
  { key: 'socialGitHub', icon: '⌨', label: 'GitHub' },
  { key: 'socialQQ', icon: '💬', label: 'QQ' },
  { key: 'socialBilibili', icon: '📺', label: 'Bilibili' },
  { key: 'socialEmail', icon: '✉', label: 'Email' },
];
var container = document.getElementById('socialLinks');
if (!container) return;
container.innerHTML = links
  .filter(function(l) {
    var v = (s[l.key] || '').trim();
    // 过滤空值和危险 URL 协议
    return v && !/^\s*(javascript|data|vbscript)\s*:/i.test(v);
  })
  .map(function(l) { return '<a href="' + escHtml(s[l.key]) + '" target="_blank" rel="noopener noreferrer" title="' + l.label + '">' + l.icon + '</a>'; })
  .join('');
}

// ============================================================================
// applyAllSettings — 核心设置应用函数，将内存设置同步到页面 DOM
// ============================================================================

/**
 * applyAllSettings — 将当前设置状态应用到页面所有相关元素
 *
 * 【它做什么】
 *   这是 settings 模块最核心的函数。它从 localStorage 读取全部设置，
 *   逐一更新页面 DOM：樱花开关/Canvas、云盘/文章导航入口显隐、
 *   昵称/签名/介绍文案、社交链接输入框和图标、以及所有设置面板的开关状态。
 *   最后自动触发云同步。
 *
 * 【数据流】
 *   localStorage('siteSettings') → loadSettings() → 对象 s
 *     → window.sakuraEnabled（全局标志，其他模块读取）
 *     → Canvas 显隐、樱花动画启停
 *     → 侧边栏 .side-nav-item 显隐
 *     → #displayName、.signature、#introText、社交图标
 *     → 设置面板各输入框 value
 *     → syncSettingsToCloud()（推送到 Supabase）
 *
 * 【输入】无
 *
 * 【输出】无
 *
 * 【副作用】大量 DOM 操作（详见以上数据流），以及一次 Supabase 写入
 *
 * 【调用者】
 *   - 页面初始化时（main.js）
 *   - toggleSetting() 切换开关后
 *   - syncSettingsFromCloud() 拉取云端设置后
 *   - profile 输入框 change 事件
 *   - resetAllSettings() 重置后
 */
function applyAllSettings() {
var s = loadSettings();

// ---- 樱花粒子动画 ----
// 读取设置值（未设置时默认 true，即默认开启樱花）
var sakuraEnabledVal = s.sakuraEnabled !== undefined ? s.sakuraEnabled : true;
window.sakuraEnabled = sakuraEnabledVal;  // 全局标志，供 sakura.js 的动画循环判断是否停止

// 更新设置面板中的樱花开关按钮样式
var toggleSakura = document.getElementById('toggleSakura');
if (toggleSakura) toggleSakura.classList.toggle('on', sakuraEnabledVal);

// 控制樱花 Canvas 元素的显隐（_sakuraCanvas 由 sakura.js 创建并挂到 window）
var c = window._sakuraCanvas;
if (c) c.style.display = sakuraEnabledVal ? '' : 'none';

// 如果樱花已关闭但动画还在跑（sakuraAnimId 非空），tickSakura 内部会检查 sakuraEnabled 自行停止
// 如果樱花重新开启且动画已停止，则重新启动动画循环
if (sakuraEnabledVal && !window.sakuraAnimId) window.tickSakura();

// ---- 云盘导航入口显隐 ----
var cloudVis = s.cloudVisible !== undefined ? s.cloudVisible : true;
var toggleCloud = document.getElementById('toggleCloud');
if (toggleCloud) toggleCloud.classList.toggle('on', cloudVis);
var cloudNav = document.querySelector('.side-nav-item[data-section="cloud"]');
if (cloudNav) cloudNav.style.display = cloudVis ? '' : 'none';

// ---- 文章导航入口显隐 ----
var artVis = s.articlesVisible !== undefined ? s.articlesVisible : true;
var toggleArticles = document.getElementById('toggleArticles');
if (toggleArticles) toggleArticles.classList.toggle('on', artVis);
var artNav = document.querySelector('.side-nav-item[data-section="articles"]');
if (artNav) artNav.style.display = artVis ? '' : 'none';

// ---- 个人资料（昵称、签名、介绍） ----
// 更新首页展示区
document.getElementById('displayName').textContent = s.nickname || defaultSettings.nickname;

// 回填设置面板中的昵称输入框
var nickInput = document.getElementById('settingNickname');
if (nickInput) nickInput.value = s.nickname || defaultSettings.nickname;

// 回填签名输入框 + 首页签名展示
var sigInput = document.getElementById('settingSignature');
if (sigInput) sigInput.value = s.signature || defaultSettings.signature;
var sigEl = document.querySelector('.signature');
if (sigEl) sigEl.textContent = s.signature || defaultSettings.signature;

// 回填介绍输入框
var introInput = document.getElementById('settingIntro');
if (introInput) introInput.value = s.intro || defaultSettings.intro;

// 渲染介绍文案到首页（需要 HTML 转义防止 XSS，同时换行符转 <br>）
var rawIntro = s.intro || defaultSettings.intro;
var escaped = rawIntro.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
document.getElementById('introText').innerHTML = escaped.replace(/\n/g, '<br>');

// ---- 社交链接输入框回填 ----
['GitHub', 'QQ', 'Bilibili', 'Email'].forEach(function(platform) {
  var input = document.getElementById('settingSocial' + platform);
  if (input) input.value = s['social' + platform] || '';
});

// 重新渲染社交链接图标
renderSocialLinks();

// 自动同步到云端
syncSettingsToCloud();
}

/**
 * resetAllSettings — 重置所有设置为默认值
 *
 * 【它做什么】
 *   弹出确认对话框，确认后删除 localStorage 中的设置和壁纸索引，
 *   清除内存缓存，重新应用默认设置，并刷新壁纸和文件列表。
 *
 * 【输入】无
 *
 * 【输出】无
 *
 * 【副作用】
 *   - 删除 localStorage 中的 'siteSettings' 和 'wallpaperIdx'
 *   - 重置 _settingsCache 为 null
 *   - 调用 applyAllSettings、applyWallpaper、renderFileList
 *
 * 【调用者】
 *   设置面板中的「重置所有设置」按钮
 */
function resetAllSettings() {
if (confirm('确定要重置所有设置为默认值吗？')) {
  localStorage.removeItem('siteSettings');
  localStorage.removeItem('wallpaperIdx');
  _settingsCache = null;
  applyAllSettings();
  if (typeof window.applyWallpaper === 'function') window.applyWallpaper(0);
  if (typeof window.renderFileList === 'function') window.renderFileList();
  showToast('已重置所有设置！', 'success');
}
}

// ============================================================================
// 侧边栏锁按钮 — 登录/登出切换
// ============================================================================

/**
 * handleLockBtnClick — 处理侧边栏锁按钮点击
 *
 * 【它做什么】
 *   检查当前 Supabase session：如果已登录则确认登出并刷新页面；
 *   如果未登录则跳转到登录界面（auth section）。
 *
 * 【输入】无
 *
 * 【输出】无
 *
 * 【副作用】
 *   已登录时：调用 sbLogout + location.reload() 整页刷新
 *   未登录时：调用 switchSection('auth') 跳转
 *
 * 【调用者】
 *   - 侧边栏锁按钮点击（nav.js 中 more-menu 的 login action）
 *   - 其他需要触发登录/登出的入口
 *
 * 【为什么登出后要 location.reload】
 *   登出后需要清除 Supabase SDK 内存中的 session、重置所有登录相关状态，
 *   reload 是最彻底的清理方式，比逐个重置全局变量更可靠。
 */
async function handleLockBtnClick() {
if (!sb) return;
var sessionResult = await sb.auth.getSession();
if (sessionResult.data.session) {
  if (confirm('确定要登出吗？')) {
    await sbLogout();
    location.reload();
  }
} else {
  if (typeof window.switchSection === 'function') {
    window.switchSection('auth');
  }
}
}

// ============================================================================
// 事件绑定 — 将设置面板中的所有按钮/输入框连接到对应处理函数
// ============================================================================

/**
 * bindSettingsEvents — 绑定设置面板所有 UI 控件的交互事件
 *
 * 【它做什么】
 *   集中注册所有事件监听器：
 *   - 登录按钮点击 + 回车键登录
 *   - 密码修改（先验证旧密码再更新）
 *   - 昵称/签名/介绍输入框 change 事件（输入失焦时保存）
 *   - 社交链接输入框 change 事件
 *   - 设置开关按钮（data-action="toggle" + data-key）的委托点击
 *   - 云端迁移按钮
 *   - 清空网盘按钮
 *   - 重置设置按钮
 *
 * 【为什么用委托而不是逐个绑定】
 *   settings 面板中的 toggle 按钮使用 data-action="toggle" 属性标记，
 *   委托到父容器 #sec-settings 上，新增开关无需修改 JS 代码，
 *   只需在 HTML 中添加对应 data-key 即可。
 *
 * 【输入】无
 *
 * 【输出】无
 *
 * 【副作用】在多个 DOM 元素上添加事件监听器
 *
 * 【调用者】
 *   main.js 在 DOMContentLoaded 时调用一次
 */
function bindSettingsEvents() {
// ---- 登录按钮 ----
var btnLogin = document.getElementById('btnLogin');
if (btnLogin) {
  btnLogin.addEventListener('click', async function() {
    var email = document.getElementById('loginEmail').value.trim();
    var password = document.getElementById('loginPassword').value;
    if (!email || !password) {
      var errEl = document.getElementById('loginError');
      if (errEl) errEl.textContent = '请填写邮箱和密码';
      return;
    }
    await sbLogin(email, password);
  });
}

// ---- 密码框回车登录（便捷操作，无需移动鼠标） ----
var loginPassword = document.getElementById('loginPassword');
if (loginPassword) {
  loginPassword.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      var btn = document.getElementById('btnLogin');
      if (btn) btn.click();
    }
  });
}

// ---- 密码修改 —— 两步验证：先验证旧密码，再更新新密码 ----
var btnChangePwd = document.getElementById('btnChangePassword');
if (btnChangePwd) {
  btnChangePwd.addEventListener('click', async function() {
    var oldPwd = document.getElementById('settingOldPassword').value;
    var newPwd = document.getElementById('settingChangePassword').value;
    if (!oldPwd) {
      showToast('请输入旧密码', 'warn');
      return;
    }
    if (!newPwd || newPwd.length < 6) {
      showToast('新密码至少 6 位', 'warn');
      return;
    }
    if (!sb) { showToast('服务不可用', 'warn'); return; }
    showLoading('验证旧密码...');

    // 先获取当前用户的邮箱（用于重新登录验证）
    var userResult = await sb.auth.getUser();
    if (!userResult.data.user) {
      hideLoading();
      showToast('请先登录', 'warn');
      return;
    }

    // 用旧密码重新登录以验证身份
    var signInResult = await sb.auth.signInWithPassword({
      email: userResult.data.user.email,
      password: oldPwd,
    });
    if (signInResult.error) {
      hideLoading();
      showToast('旧密码不正确', 'error');
      return;
    }

    // 旧密码验证通过，更新密码
    showLoading('更新密码中...');
    var result = await sb.auth.updateUser({ password: newPwd });
    hideLoading();
    if (result.error) {
      showToast('修改失败: ' + result.error.message, 'error');
    } else {
      // 清空敏感输入框
      document.getElementById('settingOldPassword').value = '';
      document.getElementById('settingChangePassword').value = '';
      showToast('密码已更新！', 'success');
    }
  });
}

// ---- Profile 输入框绑定 ----
// 昵称、签名、介绍 三个输入框使用相同的模式：
// change 事件（焦点离开时触发）→ 读取当前值 → 写入设置 → applyAllSettings 刷新全页面

var nickInput = document.getElementById('settingNickname');
if (nickInput) {
  nickInput.addEventListener('change', function() {
    var s = loadSettings();
    s.nickname = this.value || defaultSettings.nickname;
    saveSettings(s);
    applyAllSettings();
  });
}

var sigInput = document.getElementById('settingSignature');
if (sigInput) {
  sigInput.addEventListener('change', function() {
    var s = loadSettings();
    s.signature = this.value || defaultSettings.signature;
    saveSettings(s);
    applyAllSettings();
  });
}

var introInput = document.getElementById('settingIntro');
if (introInput) {
  introInput.addEventListener('change', function() {
    var s = loadSettings();
    s.intro = this.value || defaultSettings.intro;
    saveSettings(s);
    applyAllSettings();
  });
}

// ---- 社交链接输入框绑定 ----
// 通过 ID 规则 batch 绑定：settingSocialGitHub → socialGitHub
// 与 role 输入不同，社交链接只渲染图标不触发全量 applyAllSettings（减少 DOM 操作）
['settingSocialGitHub', 'settingSocialQQ', 'settingSocialBilibili', 'settingSocialEmail'].forEach(function(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', function() {
    var s = loadSettings();
    // 'settingSocialGitHub' → 'socialGitHub'：去掉 'setting' 前缀
    var key = id.replace('settingSocial', 'social');
    s[key] = this.value.trim();
    saveSettings(s);
    renderSocialLinks();
  });
});

// ---- 设置开关按钮（委托模式） ----
// 所有包含 data-action="toggle" 和 data-key="<设置项名>" 的元素，
// 点击时自动调用 toggleSetting(key)
var settingsContainer = document.getElementById('sec-settings');
if (settingsContainer) {
  settingsContainer.addEventListener('click', function(e) {
    var toggle = e.target.closest('[data-action="toggle"]');
    if (toggle) {
      toggleSetting(toggle.getAttribute('data-key'));
    }
  });
}

// ---- 云端迁移按钮 —— 委托给外部模块 ----
var btnMigrate = document.getElementById('btnMigrateToCloud');
if (btnMigrate) {
  btnMigrate.addEventListener('click', function() {
    if (typeof window.migrateLocalToCloud === 'function') window.migrateLocalToCloud();
  });
}

// ---- 清空网盘文件按钮 —— 委托给 cloud.js ----
var btnClear = document.getElementById('btnClearCloudData');
if (btnClear) {
  btnClear.addEventListener('click', function() {
    if (typeof window.clearCloudData === 'function') window.clearCloudData();
  });
}

// ---- 重置所有设置按钮 ----
var btnReset = document.getElementById('btnResetAllSettings');
if (btnReset) {
  btnReset.addEventListener('click', function() {
    if (typeof window.resetAllSettings === 'function') window.resetAllSettings();
  });
}
}

// ============================================================================
// 导出到 window 全局 — 供其他模块和 HTML inline 事件调用
// ============================================================================

window.defaultSettings = defaultSettings;
window.loadSettings = loadSettings;
window.saveSettings = saveSettings;
window.getSetting = getSetting;
window.toggleSetting = toggleSetting;
window.applyAllSettings = applyAllSettings;
window.resetAllSettings = resetAllSettings;
window.bindSettingsEvents = bindSettingsEvents;
window.handleLockBtnClick = handleLockBtnClick;
window.syncSettingsFromCloud = syncSettingsFromCloud;

export { defaultSettings, loadSettings, saveSettings, getSetting, toggleSetting, applyAllSettings, resetAllSettings, bindSettingsEvents, handleLockBtnClick, syncSettingsFromCloud };

