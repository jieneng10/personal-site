/**
 * main.js — 应用启动入口与全局状态初始化
 *
 * 【它是什么】
 *   整个站点的"开机脚本"。以 ES Module（type="module"）方式加载执行。
 *   负责：恢复登录会话、绑定跨模块事件、按顺序初始化各个子系统、
 *   恢复壁纸/BGM/URL 状态、注册 Service Worker、显示 AI 免责弹窗。
 *
 * 【运行时机】
 *   index.html 中各模块脚本（supabase.js、auth.js、common.js 等）加载完成 → 本脚本立即执行。
 *   【为什么放在最后】 因为它依赖所有其他模块暴露的 window.* 函数，
 *   必须在它们之后运行。
 *
 * 【数据流向】
 *   sb (从 supabase.mjs import)   →  init() 检查会话
 *                                 →  若已登录：显示管理 UI、同步设置
 *                                 →  按顺序初始化各子系统（applyAvatar → renderFileList → ...）
 *                                 →  恢复壁纸/BGM/URL hash 状态
 *
 *   EventBus 事件流：
 *     auth.js 登录成功 → emit('auth:login') → main.js onLoginSuccess()
 *     admin.js 数据变更 → emit('cache:invalidate:*') → 其他模块刷新
 *
 *   浏览器存储：
 *     localStorage  ←→  BGM 音量/曲目索引
 *     sessionStorage ←→  AI 免责弹窗已读标记
 *
 * 【依赖（由 import 或 window 全局变量注入）】
 *   import { sb }                   — Supabase 客户端（supabase.mjs → window.sb）
 *   import { getCachedUser }        — 获取缓存用户（supabase.mjs → window）
 *   import { showLoading/hideLoading } — 加载动画（supabase.mjs → window）
 *   import { showToast }            — toast 通知（supabase.mjs → window）
 *   import { escHtml }              — HTML 转义（supabase.mjs → window）
 *   window.EventBus                 — 事件总线（event-bus.js）
 *   window.handleLockBtnClick()     — 锁按钮点击处理（auth.js）
 *   window.syncSettingsFromCloud()  — 从云端同步设置（settings.js）
 *   window.applyAvatar()            — 应用头像（auth.js）
 *   window.renderFileList()         — 渲染文件列表（cloud.js）
 *   window.renderBGMPlaylist()     — 渲染 BGM 列表（bgm.js）
 *   window.initSakura()             — 初始化樱花特效（sakura.js）
 *   window.applyAllSettings()      — 应用所有设置（settings.js）
 *   window.renderWallpaperDots()   — 渲染壁纸指示点（wallpaper.js）
 *   window.loadArticles()           — 加载文章列表（articles.js）
 *   window.applyWallpaper(idx,silent) — 应用壁纸（wallpaper.js）
 *   window.getAllWallpapers()       — 获取所有壁纸（wallpaper.js）
 *   window.getAllTracks()           — 获取所有 BGM（bgm.js）
 *   window.playCurrentTrack()      — 播放当前 BGM（bgm.js）
 *   window.restoreFromHash()        — 从 URL hash 恢复状态（nav.js）
 *   window.safeSetItem(key,val)    — 安全 localStorage 写入（common.js）
 *   window._refreshNewsPanel()     — 刷新资讯面板（anime-news.js）
 *   window._reloadAdminData()      — 重载管理面板数据（admin.js）
 *   window.bindWallpaperEvents()   — 绑定壁纸事件（wallpaper.js）
 *   window.bindBGMEvents()         — 绑定 BGM 事件（bgm.js）
 *   window.bindCloudEvents()       — 绑定云盘事件（cloud.js）
 *   window.bindSettingsEvents()    — 绑定设置事件（settings.js）
 *   window.bindNavEvents()         — 绑定导航事件（nav.js）
 *   window.bindSubmitEvents()      — 绑定上传提交事件（cloud.js）
 *   window.bindAdminEvents()       — 绑定管理面板事件（admin.js）
 *
 * 【对外暴露的 window 接口】
 *   无新增——此脚本仅协调已有模块，不向外暴露新的 API。
 *
 * 【为什么用 ES Module】
 *   ESM 自动提供模块作用域：顶级 var/function 不会污染全局命名空间。
 *   内部变量 _inited、函数 onLoginSuccess/bindGlobalEvents 自动模块私有。
 *   通过 import 声明显式依赖 supabase.mjs 提供的工具函数。
 */

import { sb, getCachedUser, showLoading, hideLoading, showToast, escHtml } from './supabase.mjs';

// =========================================================================
// 模块级变量
// =========================================================================

/**
 * _inited — 初始化守卫，防止 init() 被多次调用
 *
 * 【为什么需要这个守卫】
 *   虽然 init() 目前只被调用一次（模块顶层），但如果将来
 *   有其他模块也调用 init()（如 EventBus 事件触发），
 *   这个守卫可以防止重复初始化。
 */
var _inited = false;

// =========================================================================
// DOM 事件绑定（不依赖异步数据的事件）
// =========================================================================

/**
 * bindGlobalEvents — 绑定页面级的 DOM 事件
 *
 * 【作用】
 *   绑定两个事件：
 *   1. 锁按钮的点击 → window.handleLockBtnClick（登录/登出切换）
 *   2. 社交链接编辑器的切换按钮
 *
 * 【输入】 无参数。依赖 DOM 元素存在。
 * 【输出】 无返回值。副作用：添加事件监听器。
 *
 * 【为什么不在各模块内部绑定这些事件】
 *   锁按钮和社交编辑器是全局 UI 元素，不属于单一模块。
 *   由 main.js 统一绑定，其他模块只负责业务逻辑（handleLockBtnClick 在 auth.js）。
 *
 * 【调用者】
 *   init() — 页面启动流程中调用
 */
function bindGlobalEvents() {
  document.getElementById('btnLock').addEventListener('click', window.handleLockBtnClick);

  // 社交链接编辑器：点击按钮切换编辑器显示/隐藏
  var socialEditBtn = document.getElementById('btnSocialEdit');
  var socialEditor = document.getElementById('socialEditor');
  if (socialEditBtn && socialEditor) {
    socialEditBtn.addEventListener('click', function() {
      // classList.toggle 返回是否可见，同步更新按钮的 active 样式
      var visible = socialEditor.classList.toggle('visible');
      socialEditBtn.classList.toggle('active', visible);
    });
  }
}

// =========================================================================
// 登录成功处理
// =========================================================================

/**
 * onLoginSuccess — 用户登录成功后的响应处理
 *
 * 【作用】
 *   更新 UI 状态（切换用户图标、显示管理徽章、显示管理员专属元素），
 *   然后刷新所有可能因登录而新增可见内容的数据。
 *
 *   UI 变更:
 *   1. btnLock: 锁图标 → 用户头像图标（表示已登录，点击可登出）
 *      title 属性改为「登出」
 *   2. adminBadge: 显示管理徽章
 *   3. .admin-only 元素: 显示所有管理员专属 UI
 *
 *   数据刷新:
 *   4. applyAvatar — 加载用户头像
 *   5. renderFileList — 刷新文件列表（登录后可看到自己的上传）
 *   6. renderBGMPlaylist — 刷新 BGM 列表
 *   7. renderWallpaperDots — 刷新壁纸指示点
 *   8. loadArticles — 重新加载文章（RLS 放开后可见未发布文章）
 *   9. _refreshNewsPanel — 刷新资讯面板
 *   10. _reloadAdminData — 重载管理面板所有数据
 *   11. applyWallpaper + playCurrentTrack — 重新应用壁纸/BGM
 *       （登录后可能有更多可用资源）
 *
 * 【输入】 无参数。依赖全局状态。
 * 【输出】 无返回值。
 *
 * 【副作用】
 *   - 修改 window._isLoggedIn = true
 *   - 修改多个 DOM 元素的 innerHTML / display
 *   - 触发多个异步数据刷新
 *
 * 【调用者】
 *   由 EventBus 自动调用 — 在 init() 中注册了事件监听：
 *   EventBus.on('auth:login', onLoginSuccess)
 *   当 auth.js 调用 EventBus.emit('auth:login') 时触发。
 *
 * 【为什么用 EventBus 而不是直接函数调用】
 *   auth.js 登录成功后不知道"谁需要刷新"——可能是 main.js、admin.js、
 *   cloud.js 等。通过事件总线解耦：
 *   发送方 (auth.js) 只发出信号 → 接收方 (各个模块) 自己决定是否响应。
 *   这样增加新模块时不需要改 auth.js。
 */
function onLoginSuccess() {
  // 更新全局登录状态
  window._isLoggedIn = true;

  // ---- UI 更新 ----

  // 锁按钮 → 用户图标（SVG 表示已登录用户）
  var lockBtn = document.getElementById('btnLock');
  if (lockBtn) {
    lockBtn.innerHTML = '<svg viewBox="0 0 24 24" class="nav-icon nav-icon-sys"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    lockBtn.title = '登出';
  }

  // 显示管理徽章
  var badge = document.getElementById('adminBadge');
  if (badge) badge.style.display = '';

  // 显示所有带 admin-only 类的元素
  // 【为什么用 CSS 类控制而不是 JS 条件渲染】
  //   管理员专属元素在 HTML 中始终存在但默认 display:none，
  //   登录后统一显示。避免 JS 条件渲染导致 DOM 结构变化。
  var adminOnly = document.querySelectorAll('.admin-only');
  for (var i = 0; i < adminOnly.length; i++) { adminOnly[i].style.display = ''; }

  // ---- 数据刷新 ----
  window.applyAvatar();
  window.renderFileList();
  window.renderBGMPlaylist();
  window.renderWallpaperDots();
  window.loadArticles();

  // 刷新资讯和管理面板（这两个仅在已登录时存在）
  if (typeof window._refreshNewsPanel === 'function') window._refreshNewsPanel();
  if (typeof window._reloadAdminData === 'function') window._reloadAdminData();

  // 重新应用壁纸
  window.applyWallpaper(window.currentWallpaper);

  // 重新加载 BGM 列表并播放
  // 【为什么重新获取所有曲目】 登录后 BGM 列表可能包含
  //   用户上传的待审核曲目（管理员可见），需要刷新播放列表。
  window.getAllTracks().then(function(t) {
    // 纠正越界索引（如果当前索引超出新列表范围）
    if (window.currentTrackIdx < 0 || window.currentTrackIdx >= t.length) window.currentTrackIdx = 0;
    window.playCurrentTrack();
  });
}

// =========================================================================
// 主初始化流程
// =========================================================================

/**
 * init — 应用主启动流程
 *
 * 【作用】
 *   这是整个站点的"开机"函数，按以下顺序执行：
 *
 *   第一阶段：事件监听注册（同步，确保在任何数据操作前就位）
 *     1. EventBus 注册 auth:login 监听
 *     2. 绑定所有模块的 DOM 事件
 *
 *   第二阶段：会话恢复（异步）
 *     3. 检查 Supabase 会话 → 如果已登录，设置 UI 并同步云端设置
 *
 *   第三阶段：子系统初始化（异步，独立 try/catch，互不阻塞）
 *     4. applyAvatar        — 应用头像
 *     5. renderFileList     — 渲染文件列表
 *     6. renderBGMPlaylist — 渲染 BGM 播放列表
 *     7. initSakura         — 初始化樱花特效
 *     8. applyAllSettings   — 应用所有设置
 *     9. renderWallpaperDots — 渲染壁纸指示点
 *     10. loadArticles      — 加载文章列表
 *     11. (若已登录) refreshNewsPanel + reloadAdminData
 *
 *   第四阶段：状态恢复（异步）
 *     12. 恢复壁纸
 *     13. 恢复 BGM（曲目索引 + 音量）
 *     14. 恢复 URL hash 导航状态
 *
 * 【输入】 无参数。
 * 【输出】 Promise<void>。
 *
 * 【副作用】
 *   - 绑定 9 个模块的事件处理
 *   - 触发所有子系统的初始化
 *   - 修改 DOM
 *   - 可能发送多个 Supabase 请求
 *
 * 【设计决策 — 为什么用 _safeAwait 包装每个步骤】
 *   如果某个子系统初始化失败（如 Supabase 断网导致 renderFileList 失败），
 *   不应阻塞其他子系统的初始化。每个步骤独立 try/catch，
 *   失败时只打印 console.warn，不影响后续步骤。
 *   这种"fail-soft"策略保证站点核心功能始终可用。
 *
 * 【调用者】
 *   模块顶层直接调用 init() — 页面加载时自动执行。
 */
async function init() {
  if (_inited) return;
  _inited = true;

  // 预加载 i18n 语言包，确保后续 tSync() 调用不会拿到空值
  if (typeof window.initI18n === 'function') {
    await window.initI18n().catch(function() {});
  }

  // ===== 第一阶段：注册事件监听（必须在数据加载前完成） =====

  // 监听 auth:login 事件 — auth.js 登录成功后触发
  if (typeof window.EventBus !== 'undefined') {
    window.EventBus.on('auth:login', onLoginSuccess);
  }

  // 绑定所有模块的 DOM 事件
  // 【为什么在数据加载前绑定】
  //   有些模块在绑定事件的同时也会加载数据（如 bindAdminEvents 会调用 loadArticles），
  //   但绑定事件本身是同步操作。确保事件的「框架」先就位。
  window.bindWallpaperEvents();
  window.bindBGMEvents();
  window.bindCloudEvents();
  window.bindSettingsEvents();
  window.bindNavEvents();
  bindGlobalEvents();
  window.bindSubmitEvents();
  if (typeof window.bindAdminEvents === 'function') window.bindAdminEvents();

  // ===== 第二阶段：检查现有会话 =====

  if (sb) {
    try {
      // 尝试获取当前 Supabase 会话
      // 【为什么用 getSession 而不是刷新 token】
      //   Supabase SDK 会自动管理 token 刷新。getSession 只检查本地是否有
      //   有效的 session。如果 session 已过期，SDK 会在下次请求时自动尝试刷新。
      var sessionResult = await sb.auth.getSession();
      if (sessionResult.data.session) {
        // ---- 已有会话 → 恢复登录态 UI ----
        window._isLoggedIn = true;
        var lockBtn = document.getElementById('btnLock');
        if (lockBtn) {
          lockBtn.innerHTML = '<svg viewBox="0 0 24 24" class="nav-icon nav-icon-sys"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
          lockBtn.title = '登出';
        }
        var badge = document.getElementById('adminBadge');
        if (badge) badge.style.display = '';
        var adminOnly = document.querySelectorAll('.admin-only');
        for (var i = 0; i < adminOnly.length; i++) { adminOnly[i].style.display = ''; }
        // 从云端同步用户设置（主题、音量偏好等）
        await window.syncSettingsFromCloud();
      }
    } catch (e) { /* guest mode — 无会话或网络错误，以游客身份继续 */ }
  }

  // ===== 第三阶段：子系统初始化（每个步骤独立 try/catch） =====

  /**
   * _safeAwait — 安全执行一个初始化步骤
   *
   * 【作用】
   *   执行传入的函数 fn()，如果 fn 返回 Promise 则等待。
   *   任何错误都会被 catch 并打印到 console.warn，不会向上抛出。
   *
   * 【为什么每个初始化步骤都要 _safeAwait】
   *   Fail-soft 策略：单个子系统失败不应阻止整个站点启动。
   *   例如，如果 Supabase 不可用导致 renderFileList 失败，
   *   用户仍然可以看壁纸、听 BGM、浏览文章（如果有缓存）。
   */
  var _safeAwait = async function(fn, label) {
    try {
      var r = fn();
      if (r && typeof r.then === 'function') await r;
    } catch (e) {
      console.warn('[init] ' + label + ' 失败:', e);
    }
  };

  // 按依赖顺序初始化各子系统
  // 【为什么是这个顺序】
  //   applyAvatar 和 renderFileList 不依赖其他子系统，可以最先执行。
  //   applyAllSettings 应在前几个 UI 渲染完成后执行，
  //   因为它可能修改主题/字体等影响所有 UI 的设置。
  //   loadArticles 放在最后，因为文章列表渲染较重，不阻塞视觉首屏。
  await _safeAwait(function() { return window.applyAvatar(); }, 'applyAvatar');
  await _safeAwait(function() { return window.renderFileList(); }, 'renderFileList');
  await _safeAwait(function() { return window.renderBGMPlaylist(); }, 'renderBGMPlaylist');
  await _safeAwait(function() { window.initSakura(); }, 'initSakura');
  await _safeAwait(function() { window.applyAllSettings(); }, 'applyAllSettings');
  await _safeAwait(function() { return window.renderWallpaperDots(); }, 'renderWallpaperDots');
  await _safeAwait(function() { return window.loadArticles(); }, 'loadArticles');

  // 登录后才加载管理面板和资讯面板数据
  if (window._isLoggedIn) {
    if (typeof window._refreshNewsPanel === 'function') {
      await _safeAwait(function() { return window._refreshNewsPanel(); }, 'refreshNewsPanel');
    }
    if (typeof window._reloadAdminData === 'function') {
      await _safeAwait(function() { return window._reloadAdminData(); }, 'reloadAdminData');
    }
  }

  // ===== 第四阶段：恢复持久化状态 =====

  // 恢复壁纸
  // 【数据来源】 window.getAllWallpapers() 返回合并后的壁纸列表
  //   （内置默认壁纸 + Supabase 已发布壁纸 + 已登录时包含自己的上传）
  var items = await window.getAllWallpapers();
  if (items.length > 0) {
    // 如果当前壁纸索引越界（如之前用的壁纸被删除），回退到第一张
    if (window.currentWallpaper >= items.length) window.currentWallpaper = 0;
    // silent=true：启动时不播放切换动画，直接显示
    window.applyWallpaper(window.currentWallpaper, true);
  }

  // 恢复 BGM
  // 【数据来源】
  //   tracks 来自 window.getAllTracks()（内置 + 云端）
  //   曲目索引和音量来自 localStorage（上次使用时保存的）
  var tracks = await window.getAllTracks();
  var savedIdx = parseInt(localStorage.getItem('bgmTrackIdx') || '0');
  // 确保索引不越界
  window.currentTrackIdx = Math.min(savedIdx, tracks.length - 1);
  // 恢复音量，默认 0.4（40%）
  window.bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
  window.playCurrentTrack();

  // 恢复 URL hash 导航状态
  // 例如用户刷新页面时，URL hash #section-articles 仍然存在，
  // restoreFromHash 会将页面滚动/切换到对应区域。
  if (typeof window.restoreFromHash === 'function') {
    window.restoreFromHash();
  }
}

// =========================================================================
// 页面卸载时的状态保存
// =========================================================================

/**
 * beforeunload 事件 — 在页面关闭/刷新前保存 BGM 状态
 *
 * 【保存内容】
 *   - bgmTrackIdx: 当前播放曲目的索引
 *   - bgmVolume:   当前音量
 *
 * 【为什么用 beforeunload 而不是 visibilitychange】
 *   visibilitychange 在切标签页时也会触发，但我们只需要在页面真正关闭/导航时保存。
 *   beforeunload 更精确。
 *
 * 【为什么用 window.safeSetItem 而不是原生 localStorage.setItem】
 *   safeSetItem（common.js）在 localStorage 满或隐私模式下会降级处理，
 *   避免抛出 QuotaExceededError 导致页面卸载中断。
 */
window.addEventListener('beforeunload', function() {
  if (window.currentTrackIdx >= 0) window.safeSetItem('bgmTrackIdx', window.currentTrackIdx);
  window.safeSetItem('bgmVolume', window.bgmAudio.volume);
});

// =========================================================================
// Service Worker 注册
// =========================================================================

/**
 * Service Worker — 离线缓存支持
 *
 * 【作用】
 *   注册 /personal-site/sw.js 作为 Service Worker，
 *   缓存静态资源（JS/CSS/图片/字体），实现离线访问和更快的二次加载。
 *
 * 【为什么 catch 空函数】
 *   如果 Service Worker 注册失败（如不支持、路径错误），
 *   站点仍然正常工作，只是没有离线缓存能力。
 *   这不是致命错误，静默忽略即可。
 *
 * 【注意】 路径是 /personal-site/sw.js（带有 base path），
 *   因为站点部署在 /personal-site/ 子路径下。
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/personal-site/sw.js').catch(function() {});
}

// =========================================================================
// 启动
// =========================================================================

// 初始化登录状态为 false（会在 init() 中根据会话检测结果更新）
window._isLoggedIn = false;

// 执行主启动流程
init();

// 通知 ESM 模块（如 comments.js）初始化——它们在本脚本之后加载
if (typeof window.EventBus !== 'undefined') {
  window.EventBus.emit('init:ready');
}

// =========================================================================
// AI 免责声明弹窗
// =========================================================================

/**
 * AI 免责声明弹窗 — 首次访问自动显示，1 秒后自动消失
 *
 * 【设计意图】
 *   告知用户站点内容可能由 AI 辅助生成，存在不准确的风险。
 *   首次访问时显示，之后不再显示（用 sessionStorage 记录）。
 *
 * 【显示逻辑】
 *   - 只在首次访问时显示（sessionStorage 无 'aiAnnounceSeen' 标记）
 *   - 延迟 1200ms 后显示（让页面先渲染完成，视觉效果更好）
 *   - 1 秒后自动开始消失动画
 *
 * 【关闭方式】
 *   1. 1 秒后自动消失
 *   2. 点击关闭按钮
 *   3. 点击弹窗背景（overlay）
 *
 * 【为什么用 sessionStorage 而不是 localStorage】
 *   sessionStorage 在浏览器关闭后清除，下次打开浏览器时再次显示。
 *   如果用 localStorage，用户可能永远看不到更新后的免责声明。
 *   sessionStorage 在"同一次浏览器会话"中只显示一次，更合理。
 *
 * 【为什么设置标记在动画开始时而不是结束后】
 *   确保即使动画被中断，也不会重复显示。
 */
setTimeout(function() {
  var overlay = document.getElementById('announcementOverlay');
  // 已经显示过 → 跳过
  if (!overlay || sessionStorage.getItem('aiAnnounceSeen')) return;

  overlay.style.display = '';
  var autoTimer = setTimeout(dismissAnnouncement, 1000);

  /**
   * dismissAnnouncement — 关闭免责声明弹窗
   *
   * 【作用】
   *   触发 CSS 退出动画（opacity + transform），动画结束后隐藏元素。
   *   写入 sessionStorage 标记，防止本次会话再次显示。
   */
  function dismissAnnouncement() {
    clearTimeout(autoTimer);  // 清除自动计时器（防止重复调用）
    overlay.classList.add('dismissing');
    // 等待 CSS 动画完成（animationend 事件），然后隐藏元素
    // { once: true } 确保监听器只触发一次后自动移除
    overlay.addEventListener('animationend', function() {
      overlay.style.display = 'none';
    }, { once: true });
    sessionStorage.setItem('aiAnnounceSeen', '1');
  }

  // 关闭按钮点击
  var closeBtn = document.getElementById('btnAnnouncementClose');
  if (closeBtn) { closeBtn.addEventListener('click', dismissAnnouncement); }

  // 点击背景遮罩层关闭
  // 【为什么判断 e.target === overlay】
  //   防止点击弹窗内部内容时误关闭。只有点击遮罩本身（不是子元素）才关闭。
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) dismissAnnouncement();
  });
}, 1200);
