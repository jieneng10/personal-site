/**
 * wallpaper.js — 壁纸与头像管理系统
 *
 * 【这是什么】
 *   本站壁纸功能的全栈前端模块。管理壁纸的获取、切换、上传、删除，以及用户头像的
 *   加载与上传。支持三种数据源（内置默认 → Supabase 云端 → IndexedDB 本地），
 *   包含桌面端交叉淡入淡出动画、移动端滑动手势切换、拖拽上传等交互。
 *
 * 【数据流向（壁纸）】
 *   数据获取:
 *     getAllWallpapers() → createCache 缓存层 → _fetchAllWallpapers()
 *       → DEFAULT_WALLPAPERS（内置 6 张）
 *       → Supabase user_files WHERE category='wallpaper'（云端）
 *       → IndexedDB wallpapers store（本地）
 *     → 合并返回 WallpaperItem[]
 *
 *   数据消费:
 *     applyWallpaper(idx)     → 读取 items[idx]，设置 body.style.backgroundImage
 *     renderWallpaperDots()   → 读取 items，渲染底部圆点选择器
 *     移动端滑动              → swipeTransition()，同上
 *
 *   数据写入:
 *     addCustomWallpapers()   → 登录用户 → Supabase insert + storage upload
 *                            → 游客     → Supabase insert(published=false) 或 IndexedDB
 *     removeCustomWallpaper() → Supabase delete + storage delete 或 IndexedDB delete
 *
 *   缓存失效:
 *     上传/删除后调用 invalidateWallpaperCache() → 下次 getAllWallpapers() 强制重新拉取
 *
 * 【数据流向（头像）】
 *   applyAvatar() → Supabase avatars 表查询 → 设置 #avatarDisplay 背景图
 *   saveAvatar()  → Supabase storage upload + avatars 表 upsert → 重新 applyAvatar()
 *
 * 【依赖】
 *   - DOM: #bgLayer, #wallpaperPicker, #wallpaperInput, #wpUploadBtn,
 *          #avatarRing, #avatarDisplay, #avatarInput
 *   - window.sb          : Supabase 客户端（由 supabase.js 提供）
 *   - window.createCache : 缓存工厂函数（由 cache.js 提供）
 *   - window.EventBus    : 事件总线（由 event-bus.js 提供，可选）
 *   - 全局辅助函数: sbPublicUrl(), sbStoragePath(), sbUpload(), sbDelete(),
 *                  getCachedUser(), escHtml(), showLoading(), hideLoading(),
 *                  showToast(), saveToLocalDB(), window.safeSetItem()
 *
 * 【全局变量关系（window 导出）】
 *   - window.DEFAULT_WALLPAPERS     : 内置壁纸列表（供 admin.js 读取）
 *   - window.getAllWallpapers()     : 获取全部壁纸（被多个模块调用）
 *   - window.applyWallpaper()       : 切换壁纸（settings.js、事件绑定调用）
 *   - window.renderWallpaperDots()  : 渲染圆点选择器
 *   - window.triggerWallpaperUpload(): 触发文件选择对话框
 *   - window.addCustomWallpapers()  : 上传自定义壁纸
 *   - window.removeCustomWallpaper(): 删除壁纸
 *   - window.applyAvatar()          : 加载头像（登录后调用）
 *   - window.saveAvatar()           : 保存头像
 *   - window.bindWallpaperEvents()  : 绑定所有事件（main.js 初始化时调用）
 *   - window.invalidateWallpaperCache(): 供 admin.js 强制刷新缓存
 *   - window.currentWallpaper       : getter/setter — 当前壁纸索引
 */

// ==================== Wallpaper System ====================

import { sb, sbStoragePath, sbUpload, sbPublicUrl, sbDelete, saveToLocalDB, getCachedUser, showLoading, hideLoading, showToast, escHtml } from './supabase.mjs';
import { createCache } from './cache.mjs';
import { safeSetItem } from './config.mjs';

// ---------------------------------------------------------------
// 内置默认壁纸列表
// ---------------------------------------------------------------

/**
 * 内置的 6 张默认壁纸。
 *
 * 【为什么是 6 张】
 *   提供基本选择多样性而不冗余。用户在未上传自定义壁纸或离线时也有可用壁纸。
 *   这些文件放在 static/wallpapers/ 目录，构建时直接复制到站点根目录。
 */
/** @type {{ name: string, path: string }[]} */
var DEFAULT_WALLPAPERS = [
  { name: '壁纸 1', path: 'static/wallpapers/1.webp' },
  { name: '壁纸 2', path: 'static/wallpapers/2.webp' },
  { name: '壁纸 3', path: 'static/wallpapers/3.webp' },
  { name: '壁纸 4', path: 'static/wallpapers/4.webp' },
  { name: '壁纸 5', path: 'static/wallpapers/5.webp' },
  { name: '壁纸 6', path: 'static/wallpapers/6.webp' },
];

// ---------------------------------------------------------------
// 模块级状态变量
// ---------------------------------------------------------------

/**
 * 当前壁纸在合并列表中的索引。
 * 初始化时从 localStorage 读取键 wallpaperIdx，默认值为 2（第 3 张壁纸）。
 *
 * 【为什么默认是 2 而不是 0】
 *   — 设计偏好：第 3 张壁纸视觉效果最平衡，作为首页默认。
 */
var currentWallpaper = parseInt(localStorage.getItem('wallpaperIdx') || '2');

/**
 * applyWallpaper 的竞态守卫计数器。
 * 每次调用 applyWallpaper 时自增，异步操作完成后检查 gen 是否仍匹配。
 * 不匹配说明有新的 applyWallpaper 调用覆盖了本次操作，应放弃副作用。
 *
 * 【为什么需要竞态守卫】
 *   壁纸切换涉及 Image 预加载 + setTimeout，是多个异步步骤。
 *   用户快速连续切换时，旧壁纸的 Image.onload 可能在切换完成后才触发，
 *   导致背景图回退。gen 计数器确保只有最新一次调用的回调能生效。
 */
var _wallpaperGen = 0; // race-condition guard (applyWallpaper)

/**
 * renderWallpaperDots 的竞态守卫计数器。
 * 原理同 _wallpaperGen，防止快速切换壁纸时旧渲染覆盖新结果。
 */
var _wallpaperDotsGen = 0; // race-condition guard (renderWallpaperDots)

/**
 * 最后一次触摸手势的时间戳。
 *
 * 【为什么需要这个】
 *   移动端滑动切换壁纸后，浏览器会在 touchend 之后触发 click 事件。
 *   如果不加防护，click 事件可能再次触发 applyWallpaper，导致双重切换或
 *   切换到错误的壁纸。_wpLastTouchTime 记录 touchend 时刻，
 *   click 处理器发现 300ms 内刚处理过触摸则忽略。
 */
var _wpLastTouchTime = 0; // B-12: 防止 touchend → click 双重触发

// ---------------------------------------------------------------
// 数据获取层（由 createCache 包装为缓存版本）
// ---------------------------------------------------------------

/**
 * @typedef {object} WallpaperItem
 * @property {string|number} id       - 唯一标识（default_0~5 / Supabase row id / local_wp_xxx）
 * @property {string}        name     - 显示名称
 * @property {string}        value    - CSS `url(...)` 格式的图片地址（可直接用于 background）
 * @property {boolean}       [isDefault] - 是否为内置默认壁纸（默认壁纸不可删除）
 */

/**
 * 从所有数据源获取壁纸列表（未缓存版本）。
 *
 * 【数据来源优先级】
 *   1. DEFAULT_WALLPAPERS — 内置 6 张，始终可用
 *   2. Supabase user_files 表 — 云端壁纸（登录用户：published=true 的自己的；
 *      游客：所有 published=true 的公共壁纸。RLS 自动过滤）
 *   3. IndexedDB wallpapers store — 本地未迁移数据（旧版遗留或离线保存）
 *
 * 【返回】
 *   Promise<WallpaperItem[]> — 三源合并后的壁纸列表
 *
 * 【调用者】
 *   getAllWallpapers()（缓存层）→ 最终被 applyWallpaper / renderWallpaperDots / swipeTransition 消费
 *
 * 【为什么 Supabase 失败时静默跳过】
 *   云端不可用不应阻止用户使用默认壁纸和本地壁纸。
 *   降级策略：云失败 → 用默认 + 本地；本地失败 → 只用默认 + 云。
 */
async function _fetchAllWallpapers() {
  // 第 1 层：内置默认壁纸（始终可用）
  var defaults = DEFAULT_WALLPAPERS.map(function(d, i) {
    return { id: 'default_' + i, name: d.name, value: 'url(' + d.path + ')', isDefault: true };
  });

  var cloudItems = [];
  var localItems = [];

  // 第 2 层：Supabase 云端壁纸
  // RLS（Row Level Security）自动按登录用户过滤：登录用户只能看到自己的 published 壁纸
  // 游客可以通过其他策略看到公共壁纸（由 Supabase 策略决定）
  if (sb) {
    try {
      var result = await sb
        .from('user_files')
        .select('*')
        .eq('category', 'wallpaper')
        .eq('published', true)
        .order('created_at');
      cloudItems = (result.data || []).map(function(c) {
        return {
          id: c.id,
          name: c.name,
          value: 'url(' + sbPublicUrl('wallpapers', c.storage_path) + ')',
        };
      });
    } catch (e) { /* cloud unavailable — skip */ }
  }

  // 第 3 层：IndexedDB 本地壁纸（旧数据 / 离线保存）
  try {
    localItems = await _readLocalWallpapers();
  } catch (e) { /* local read failed — skip */ }

  // 三源合并，默认壁纸在前，云端其次，本地最后
  return defaults.concat(cloudItems).concat(localItems);
}

/**
 * 壁纸列表缓存实例（10 分钟 TTL）。
 *
 * 【为什么是 10 分钟】
 *   壁纸列表变化频率极低（用户主动上传/删除），10 分钟缓存可以避免
 *   每次渲染圆点选择器都走 Supabase 查询，同时保证用户上传后能较快看到结果。
 *   上传/删除操作后显式调用 invalidateWallpaperCache() 立即失效。
 */
/** 10-minute cache for wallpaper list */
var _wallpaperCache = createCache
  ? createCache(_fetchAllWallpapers, 600000)
  : null;

/**
 * 获取全部壁纸列表（带缓存）。
 *
 * 【输入】无
 * 【输出】Promise<WallpaperItem[]>
 *
 * 【调用者】
 *   - applyWallpaper() — 切换壁纸时读取
 *   - renderWallpaperDots() — 渲染圆点选择器
 *   - swipeTransition() — 移动端滑动切换
 *   - addCustomWallpapers() — 上传后刷新
 *   - removeCustomWallpaper() — 删除后刷新
 */
async function getAllWallpapers() {
  if (_wallpaperCache) return _wallpaperCache.get();
  // 降级：如果 createCache 不可用（cache.js 未加载），直接查询
  return _fetchAllWallpapers();
}

/**
 * 立即使壁纸列表缓存失效。
 * 下次调用 getAllWallpapers() 时将强制重新从数据源拉取。
 *
 * 【调用者】
 *   - addCustomWallpapers() — 上传新壁纸后
 *   - removeCustomWallpaper() — 删除壁纸后
 *   - admin.js 通过 window.invalidateWallpaperCache() — 管理员审核通过后
 *   - EventBus 'cache:invalidate:wallpaper' 事件 — 管理员从管理面板触发
 */
function invalidateWallpaperCache() {
  if (_wallpaperCache) _wallpaperCache.invalidate();
}

// ---------------------------------------------------------------
// IndexedDB 辅助函数（本地壁纸读写）
// ---------------------------------------------------------------

/**
 * 从 IndexedDB 读取所有本地壁纸。
 *
 * 【它做什么】
 *   打开 IndexedDB 数据库 → 读取 wallpapers object store 全部记录
 *   → 转换为 WallpaperItem[] 格式（将 Blob/ArrayBuffer 转换为 Object URL）。
 *
 * 【为什么需要 IndexedDB】
 *   支持未登录用户保存自定义壁纸。Supabase 需要登录，IndexedDB 提供离线/游客的
 *   本地持久化方案。登录后可通过迁移功能上传到云端。
 *
 * 【输入】无
 * 【输出】Promise<WallpaperItem[]>
 *
 * 【调用者】
 *   _fetchAllWallpapers() — 合并壁纸列表时
 */
async function _readLocalWallpapers() {
  // 打开数据库（DB_NAME 由 main.js 通过 window 注入，默认为 'PersonalSiteDB'）
  var db = await new Promise(function(res, rej) {
    var req = indexedDB.open(window.DB_NAME || 'PersonalSiteDB', window.DB_VERSION || 1);
    req.onsuccess = function(e) { res(e.target.result); };
    req.onerror = function() { rej(req.error); };
  });
  // 如果数据库中没有 wallpapers store，返回空
  if (!db.objectStoreNames.contains('wallpapers')) { db.close(); return []; }
  // 读取全部记录
  var rows = await new Promise(function(res, rej) {
    try {
      var tx = db.transaction('wallpapers', 'readonly');
      var req = tx.objectStore('wallpapers').getAll();
      req.onsuccess = function() { res(req.result || []); };
      req.onerror = function() { rej(req.error); };
    } catch (e) { res([]); }
  });
  db.close();
  // 转换为 WallpaperItem 格式
  return rows.map(function(r) {
    // 优先使用 dataUrl；否则从 ArrayBuffer 创建 Blob URL
    var url = r.dataUrl || (r.data ? URL.createObjectURL(new Blob([r.data], { type: r.type || 'image/png' })) : '');
    return { id: 'local_wp_' + (r.id || r.addedAt), name: r.name, value: 'url(' + url + ')', isDefault: false };
  });
}

/**
 * 从 IndexedDB 删除一张本地壁纸。
 *
 * 【输入】
 *   id — 壁纸的键（与 _readLocalWallpapers 生成的 id 对应）
 *
 * 【副作用】
 *   从 IndexedDB wallpapers store 中删除对应记录
 *
 * 【调用者】
 *   removeCustomWallpaper() — 当删除的是 local_wp_xxx 类型时
 */
async function _deleteLocalWallpaper(id) {
  var db = await new Promise(function(res, rej) {
    var req = indexedDB.open(window.DB_NAME || 'PersonalSiteDB', window.DB_VERSION || 1);
    req.onsuccess = function(e) { res(e.target.result); };
    req.onerror = function() { rej(req.error); };
  });
  if (!db.objectStoreNames.contains('wallpapers')) { db.close(); return; }
  var tx = db.transaction('wallpapers', 'readwrite');
  tx.objectStore('wallpapers').delete(id);
  await new Promise(function(res, rej) {
    tx.oncomplete = res; tx.onerror = function() { rej(tx.error); };
  });
  db.close();
}

// =========================================================================
// Apply wallpaper to body background
// =========================================================================

/**
 * 将 body 背景切换到指定索引的壁纸。
 *
 * 【它做什么】
 *   读取壁纸列表 → 取出对应 WallpaperItem → 设置 document.body.style.backgroundImage。
 *   桌面端使用双层交叉淡入淡出动画（bgLayer → body），移动端或 instant 模式直接切换。
 *
 * 【交叉淡入淡出流程（桌面端）】
 *   1. 用 Image 对象预加载壁纸
 *   2. onload: 将 bgLayer（前景层）的 background 设为新壁纸，opacity → 1
 *   3. 850ms 后：body 的 background 切换为新壁纸
 *   4. 等两帧后：bgLayer opacity → 0（通过 CSS transition 平滑过渡）
 *   5. 如果 1.5s 内图片未加载完成，直接切换（防止卡住）
 *
 * 【为什么需要 bgLayer】
 *   body 的 backgroundImage 直接切换是瞬间的，没有过渡效果。
 *   bgLayer 是一个绝对定位的覆盖层，通过 opacity CSS transition 实现从
 *   旧壁纸到新壁纸的平滑交叉淡入淡出。
 *
 * 【输入】
 *   idx     — 壁纸在合并列表中的索引（0-based）
 *   instant — 是否跳过动画直接切换（默认 false）
 *
 * 【副作用】
 *   - 修改 document.body.style.backgroundImage
 *   - 修改 #bgLayer 的 opacity 和 backgroundImage
 *   - 更新 localStorage 中的 wallpaperIdx
 *   - 更新模块级 currentWallpaper 变量
 *   - 调用 renderWallpaperDots() 更新圆点选择器
 *
 * 【调用者】
 *   - 圆点选择器 click 事件
 *   - 移动端滑动 touchend 事件（通过 swipeTransition）
 *   - addCustomWallpapers() — 上传后自动切换到新壁纸
 *   - removeCustomWallpaper() — 删除后调整索引
 *   - settings.js — 用户从设置面板切换
 *   - admin.js — 管理员切换壁纸
 */
async function applyWallpaper(idx, instant) {
  currentWallpaper = idx;
  // 竞态守卫：自增计数
  var gen = ++_wallpaperGen;

  var items = await getAllWallpapers();
  // 如果 async 期间有新的 applyWallpaper 调用，放弃本次
  if (gen !== _wallpaperGen) return;

  // 无壁纸可用时清空背景
  if (!items || items.length === 0) {
    document.body.style.backgroundImage = 'none';
    var bgLayer0 = document.getElementById('bgLayer');
    if (bgLayer0) bgLayer0.style.opacity = '0';
    return;
  }

  // 索引越界保护：回卷到 0
  if (idx >= items.length) currentWallpaper = 0;

  var wp = items[currentWallpaper];
  // 从 CSS url() 中提取纯 URL 字符串（用于 Image 预加载）
  var url = wp.value.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
  var bgLayer = document.getElementById('bgLayer');
  var isMobile = window.innerWidth < 540;

  if (isMobile || instant || !url) {
    // 移动端或即时模式：跳过交叉淡入淡出动画
    if (gen !== _wallpaperGen) return;
    if (url && !instant) {
      // 有 URL 但非 instant：预加载后设置（避免白屏闪烁）
      var preload = new Image();
      preload.onload = function() {
        if (gen !== _wallpaperGen) return;
        document.body.style.backgroundImage = wp.value;
      };
      preload.src = url;
    } else {
      // instant 或无 URL：直接设置
      document.body.style.backgroundImage = wp.value;
    }
    if (bgLayer) bgLayer.style.opacity = '0';
  } else if (url) {
    // 桌面端交叉淡入淡出动画
    var img = new Image();
    img.onload = function() {
      if (gen !== _wallpaperGen) return;
      // 阶段 1: 将新壁纸加载到 bgLayer 并显示（opacity 1）
      if (bgLayer) {
        bgLayer.style.backgroundImage = wp.value;
        bgLayer.style.opacity = '1';
      }
      // 阶段 2: 850ms 后切换 body 背景 + 淡出 bgLayer
      setTimeout(function() {
        if (gen !== _wallpaperGen) return;
        document.body.style.backgroundImage = wp.value;
        // 等待两帧确保 body 背景已渲染，再淡出 bgLayer
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            if (gen !== _wallpaperGen) return;
            if (bgLayer) bgLayer.style.opacity = '0';
          });
        });
      }, 850);
    };
    img.src = url;

    // 超时保护：1.5s 后如果图片仍未加载完成，强制切换
    setTimeout(function() {
      if (!img.complete) {
        if (gen !== _wallpaperGen) return;
        document.body.style.backgroundImage = wp.value;
        if (bgLayer) bgLayer.style.opacity = '0';
      }
    }, 1500);
  }

  // 持久化当前壁纸索引到 localStorage
  safeSetItem('wallpaperIdx', currentWallpaper);
  // 更新圆点选择器的激活状态
  if (gen === _wallpaperGen) renderWallpaperDots();
}

/**
 * 渲染底部左侧的壁纸圆点选择器。
 *
 * 【它做什么】
 *   读取壁纸列表 → 为每张壁纸生成一个带缩略图的圆点按钮
 *   → 标记当前激活的圆点 → 自定义壁纸额外显示删除按钮
 *   → 渲染上传按钮（+） → 预加载相邻壁纸（优化切换体验）
 *
 * 【副作用】
 *   修改 #wallpaperPicker 的 innerHTML（完全重绘）
 *
 * 【调用者】
 *   - applyWallpaper() — 每次切换壁纸后更新选中状态
 *   - swipeTransition() — 移动端滑动后更新
 *
 * 【为什么预加载相邻壁纸】
 *   用户最可能的操作是切换到上一张或下一张。
 *   提前加载这两张到浏览器缓存，切换时 Image.onload 几乎是同步的，
 *   消除白屏等待时间。
 */
async function renderWallpaperDots() {
  var gen = ++_wallpaperDotsGen;
  var picker = document.getElementById('wallpaperPicker');
  var items = await getAllWallpapers();
  // B-5: 竞态守卫，快速连切时放弃过期渲染
  if (gen !== _wallpaperDotsGen) return;

  // 为每张壁纸生成 HTML 片段
  var dots = items.map(function(wp, i) {
    // 非默认壁纸（自定义）显示删除按钮
    var delBtn = !wp.isDefault ? '<span class="delete-custom" data-remove-wp-id="' + wp.id + '">✕</span>' : '';
    return '<div class="wp-dot' + (i === currentWallpaper ? ' active' : '') + (!wp.isDefault ? ' custom' : '') + '"' +
      ' style="background:' + wp.value + ';background-size:cover;background-position:center;"' +
      ' title="' + escHtml(wp.name) + '" data-wp-idx="' + i + '">' + delBtn + '</div>';
  }).join('');

  // 渲染圆点 + 上传按钮
  picker.innerHTML = dots + '<div class="wp-upload-btn" id="wpUploadBtn" title="上传自定义壁纸">+</div>';

  // 预加载相邻壁纸（左右各一张）
  var next = currentWallpaper + 1 < items.length ? currentWallpaper + 1 : 0;
  var prev = currentWallpaper - 1 >= 0 ? currentWallpaper - 1 : items.length - 1;
  [next, prev].forEach(function(i) {
    var u = items[i].value.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    if (u) { var pre = new Image(); pre.src = u; }
  });
}

/**
 * 触发隐藏的 <input type="file"> 打开文件选择对话框。
 *
 * 【调用者】
 *   - #wpUploadBtn click 事件
 *   - 其他需要程序化触发上传的场景
 */
function triggerWallpaperUpload() {
  document.getElementById('wallpaperInput').click();
}

// =========================================================================
// Upload custom wallpapers
// =========================================================================

/**
 * 添加一张或多张自定义壁纸。
 *
 * 【它做什么】
 *   接收用户选择的图片文件（FileList），根据登录状态选择上传策略：
 *
 *   登录用户: Supabase storage 上传 + user_files 表插入 (published=true)
 *             → 立即可见
 *
 *   游客 + Supabase 可用: Supabase storage 上传 + user_files 表插入 (published=false)
 *                        → 等待管理员审核，审核通过后可见
 *                        → 同时保存到 IndexedDB 本地备份
 *
 *   游客 + Supabase 不可用: 仅保存到 IndexedDB 本地
 *                          → 提示用户登录后可云端同步
 *
 * 【输入】
 *   fileList — 用户选择的文件列表（来自 <input type="file"> 或拖拽事件）
 *
 * 【副作用】
 *   - 上传文件到 Supabase Storage
 *   - 写入 Supabase user_files 表
 *   - 写入 IndexedDB wallpapers store
 *   - 使壁纸缓存失效
 *   - 自动切换到最新上传的壁纸
 *   - 显示 toast 提示
 *
 * 【调用者】
 *   - #wallpaperInput change 事件
 *   - 拖拽上传 drop 事件
 */
async function addCustomWallpapers(fileList) {
  // 过滤：只接受 image/* 类型的文件
  var imgFiles = [];
  for (var i = 0; i < fileList.length; i++) {
    if (fileList[i].type.startsWith('image/')) imgFiles.push(fileList[i]);
  }
  if (imgFiles.length === 0) return;

  // 检查登录状态
  var user = null;
  if (sb && window._isLoggedIn) {
    user = await getCachedUser();
  }

  var items = await getAllWallpapers();
  var uploaded = 0;

  if (user) {
    // 策略 A：登录用户 → Supabase 直接发布
    showLoading('上传壁纸中...');
    try {
      for (var j = 0; j < imgFiles.length; j++) {
        var file = imgFiles[j];
        // 生成存储路径：{user_id}/wallpaper/{filename}
        var path = sbStoragePath(user.id, 'wallpaper', file.name);
        // 上传到 Supabase Storage bucket 'wallpapers'
        await sbUpload('wallpapers', file, path);
        // 插入 user_files 元数据记录
        await sb.from('user_files').insert({
          user_id: user.id, category: 'wallpaper', published: true,
          name: file.name, size: file.size, mime_type: file.type, storage_path: path,
        });
        uploaded++;
      }
      showToast('已上传 ' + uploaded + ' 张到云端', 'success');
    } catch (e) {
      showToast('云端上传失败: ' + (e.message || '请检查网络'), 'error');
      // 云端失败 → 降级到本地保存
      await _saveWallpapersToLocalDB(imgFiles);
      uploaded = imgFiles.length;
    } finally { hideLoading(); }
  } else if (sb) {
    // 策略 B：游客 + Supabase 可用 → 上传到云端待审核 + 本地备份
    showLoading('上传壁纸中...');
    try {
      for (var k = 0; k < imgFiles.length; k++) {
        var gf = imgFiles[k];
        // 游客路径：guest/{timestamp}_{safe_filename}
        var gpath = 'guest/' + Date.now().toString(36) + '_' + gf.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        await sbUpload('wallpapers', gf, gpath);
        await sb.from('user_files').insert({
          category: 'wallpaper', published: false,  // 游客上传默认待审核
          name: gf.name, size: gf.size, mime_type: gf.type, storage_path: gpath,
        });
        uploaded++;
      }
      showToast('已上传 ' + uploaded + ' 张，等待管理员审核通过后可见', 'success');
    } catch (e) {
      // 云端失败 → 降级到本地保存
      await _saveWallpapersToLocalDB(imgFiles);
      uploaded = imgFiles.length;
      showToast('壁纸已保存到本地。登录后可云端同步，跨设备访问。', 'success');
    } finally { hideLoading(); }
  } else {
    // 策略 C：完全离线 → 仅本地 IndexedDB
    await _saveWallpapersToLocalDB(imgFiles);
    uploaded = imgFiles.length;
    showToast('壁纸已保存到本地。登录后可云端同步，跨设备访问。', 'success');
  }

  // 如果成功上传/保存了至少一张，刷新并切换到最新壁纸
  if (uploaded > 0) {
    invalidateWallpaperCache();
    // B-6: 缓存失效后重新拉取，用最新数据算索引，避免旧 items.length
    var freshItems = await getAllWallpapers();
    currentWallpaper = freshItems.length - 1;
    safeSetItem('wallpaperIdx', currentWallpaper);
    applyWallpaper(currentWallpaper);
  }
}

/**
 * 将壁纸图片文件保存到 IndexedDB 本地存储。
 *
 * 【输入】
 *   imgFiles — File 对象数组
 *
 * 【副作用】
 *   读取文件的 ArrayBuffer → 写入 IndexedDB wallpapers store → 显示 toast
 *
 * 【调用者】
 *   addCustomWallpapers() — 作为云端上传失败或离线时的降级方案
 */
async function _saveWallpapersToLocalDB(imgFiles) {
  showLoading('保存到本地...');
  try {
    var entries = [];
    for (var k = 0; k < imgFiles.length; k++) {
      var f = imgFiles[k];
      var buf = await f.arrayBuffer();
      entries.push({ name: f.name, data: buf, size: f.size, type: f.type, addedAt: Date.now() });
    }
    await saveToLocalDB('wallpapers', entries);
    showToast('已保存本地（登录后可云端迁移上传）', 'success');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

// =========================================================================
// Remove wallpaper
// =========================================================================

/**
 * 删除一张自定义壁纸（默认壁纸不可删除）。
 *
 * 【它做什么】
 *   根据 id 类型选择删除策略：
 *   - string 类型 id（local_wp_xxx）→ 从 IndexedDB 删除
 *   - number 类型 id（Supabase row id）→ 从 Supabase storage + user_files 表删除
 *
 *   删除后刷新缓存、调整索引（如果当前索引越界）、重新应用壁纸。
 *
 * 【输入】
 *   id — 壁纸标识符（string = IndexedDB 本地 / number = Supabase 云端）
 *
 * 【副作用】
 *   - 从 IndexedDB 或 Supabase 删除数据
 *   - 使壁纸缓存失效
 *   - 重新渲染圆点选择器
 *   - 可能切换壁纸（若删除的是当前壁纸）
 *
 * 【调用者】
 *   - 圆点选择器中自定义壁纸的 ✕ 按钮 click 事件
 */
async function removeCustomWallpaper(id) {
  if (typeof id === 'string') {
    await _deleteLocalWallpaper(id);
  } else if (sb) {
    await window._deleteUserFile(id);
  } else { return; }

  // 删除后刷新列表
  invalidateWallpaperCache();
  var items = await getAllWallpapers();
  if (currentWallpaper >= items.length) currentWallpaper = Math.max(0, items.length - 1);
  safeSetItem('wallpaperIdx', currentWallpaper);
  applyWallpaper(currentWallpaper);
}

// =========================================================================
// Avatar（头像）
// =========================================================================

/**
 * 加载当前登录用户的头像并显示在个人资料环上。
 *
 * 【它做什么】
 *   1. 如果 Supabase 不可用 → 使用默认头像
 *   2. 获取当前登录用户
 *   3. 查询 avatars 表（按 user_id）
 *   4. 如果有头像记录 → 显示云端头像
 *   5. 如果没有记录 → 显示默认头像
 *
 * 【副作用】
 *   修改 #avatarDisplay 元素的 style.backgroundImage 和 textContent
 *
 * 【调用者】
 *   - main.js 初始化时调用
 *   - saveAvatar() 上传成功后调用
 *   - 用户登录成功后调用
 */
async function applyAvatar() {
  var avatarEl = document.getElementById('avatarDisplay');
  var defaultUrl = 'static/images/default-avatar.png';

  // Supabase 不可用 → 默认头像
  if (!sb) {
    avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
    avatarEl.textContent = '';
    return;
  }

  try {
    var user = await getCachedUser();
    // 未登录 → 默认头像
    if (!user) {
      avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
      avatarEl.textContent = '';
      return;
    }

    // 查询 avatars 表
    var result = await sb.from('avatars').select('storage_path').eq('user_id', user.id);
    if (result.data && result.data.length > 0) {
      avatarEl.style.backgroundImage = 'url(' + sbPublicUrl('avatars', result.data[0].storage_path) + ')';
    } else {
      avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
    }
  } catch (e) {
    avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
  }
  // 清空可能存在的文字内容（头像用背景图显示，不需要文字）
  avatarEl.textContent = '';
}

/**
 * 上传新头像到 Supabase 并更新显示。
 *
 * 【它做什么】
 *   1. 将头像文件上传到 Supabase Storage bucket 'avatars'
 *   2. 在 avatars 表中 upsert 记录（存在则更新，不存在则插入）
 *   3. 重新调用 applyAvatar() 刷新显示
 *
 * 【输入】
 *   file — 用户选择的图片文件
 *
 * 【副作用】
 *   - 上传文件到 Supabase Storage
 *   - 写入 Supabase avatars 表
 *   - 调用 applyAvatar() 刷新显示
 *   - 显示 loading / toast
 *
 * 【调用者】
 *   #avatarInput change 事件
 */
async function saveAvatar(file) {
  if (!sb) return;
  try {
    var user = await getCachedUser();
    if (!user) return;
    showLoading('上传头像中...');
    try {
      // 生成存储路径：{user_id}/avatar/{filename}
      var path = sbStoragePath(user.id, 'avatar', file.name);
      await sbUpload('avatars', file, path);
      // upsert：同一用户只有一条头像记录
      await sb.from('avatars').upsert({
        user_id: user.id,
        storage_path: path,
        updated_at: new Date(),
      });
    } finally {
      hideLoading();
    }
    applyAvatar();
  } catch (e) {
    showToast('上传失败: ' + e.message, 'error');
  }
}

// =========================================================================
// Event bindings（事件绑定）
// =========================================================================

/**
 * 绑定壁纸和头像相关的所有 DOM 事件。
 *
 * 【它做什么】
 *   一次性注册以下事件：
 *   - #wallpaperInput change → 上传壁纸
 *   - #wallpaperPicker click → 圆点切换 / 删除 / 上传按钮
 *   - #wallpaperPicker dragover/dragenter/dragleave/drop → 拖拽上传
 *   - #avatarRing click → 打开头像文件选择
 *   - #avatarInput change → 上传头像
 *
 * 【调用者】
 *   main.js 在 DOMContentLoaded 后调用 window.bindWallpaperEvents()
 *
 * 【为什么拖拽用 dragCounter 而不是 dragenter/dragleave 直接 toggle】
 *   拖拽进入子元素时会触发 dragleave + dragenter（冒泡），
 *   直接 toggle 会导致 drag-over 样式闪烁。dragCounter 记录进入/离开次数，
 *   只有 counter 归零时才移除样式，正确反映"鼠标是否还在 picker 区域内"。
 */
function bindWallpaperEvents() {
  // 文件选择上传
  document.getElementById('wallpaperInput').addEventListener('change', async function() {
    if (this.files.length > 0) {
      await addCustomWallpapers(this.files);
      this.value = ''; // 清空以允许重复选择同一文件
    }
  });

  var picker = document.getElementById('wallpaperPicker');
  var wpDragCounter = 0; // 拖拽层级计数器

  // 圆点选择器：click 事件（切换壁纸 / 删除 / 上传）
  picker.addEventListener('click', function(e) {
    // B-12: 若刚刚通过触摸手势处理过（300ms 内），忽略后续 click
    // 防止移动端滑动切换后 touchend 触发的 click 再次切换壁纸
    if (Date.now() - _wpLastTouchTime < 300) return;

    // 删除按钮
    var delBtn = e.target.closest('.delete-custom[data-remove-wp-id]');
    if (delBtn) {
      e.stopPropagation();
      var $wpDelId = delBtn.getAttribute('data-remove-wp-id');
      // 判断 id 类型：纯数字 = Supabase id，否则 = IndexedDB 本地 id
      removeCustomWallpaper(/^\d+$/.test($wpDelId) ? parseInt($wpDelId) : $wpDelId);
      return;
    }
    // 上传按钮
    if (e.target.closest('#wpUploadBtn')) {
      triggerWallpaperUpload();
      return;
    }
    // 壁纸圆点
    var dot = e.target.closest('.wp-dot[data-wp-idx]');
    if (dot) {
      applyWallpaper(parseInt(dot.getAttribute('data-wp-idx')));
    }
  });

  // 拖拽上传事件
  picker.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); });
  picker.addEventListener('dragenter', function(e) {
    e.preventDefault(); e.stopPropagation();
    wpDragCounter++;
    picker.classList.add('drag-over');
  });
  picker.addEventListener('dragleave', function(e) {
    e.preventDefault(); e.stopPropagation();
    wpDragCounter--;
    // 只有完全离开 picker 区域时才移除高亮
    if (wpDragCounter === 0) picker.classList.remove('drag-over');
  });
  picker.addEventListener('drop', async function(e) {
    e.preventDefault(); e.stopPropagation();
    wpDragCounter = 0;
    picker.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      await addCustomWallpapers(e.dataTransfer.files);
    }
  });

  // 头像：点击头像环 → 打开文件选择
  document.getElementById('avatarRing').addEventListener('click', function() {
    document.getElementById('avatarInput').click();
  });
  // 头像：选择文件后上传
  document.getElementById('avatarInput').addEventListener('change', async function() {
    var file = this.files[0];
    if (!file) return;
    await saveAvatar(file);
    this.value = ''; // 清空以允许重复选择同一文件
  });
}

// ---- 监听管理面板的缓存失效事件 ----
// 当管理员从管理面板审核通过了游客上传的壁纸后，EventBus 会发出此事件
// 收到后立即使本地壁纸缓存失效，下次渲染时可看到新审核通过的壁纸
if (typeof window.EventBus !== 'undefined') {
  window.EventBus.on('cache:invalidate:wallpaper', function() {
    invalidateWallpaperCache();
  });
}

// =========================================================================
// window exports（全局导出）
// =========================================================================

/** @type {typeof DEFAULT_WALLPAPERS} */
window.DEFAULT_WALLPAPERS = DEFAULT_WALLPAPERS;

/** @type {typeof getAllWallpapers} */
window.getAllWallpapers = getAllWallpapers;

/** @type {typeof applyWallpaper} */
window.applyWallpaper = applyWallpaper;

/** @type {typeof renderWallpaperDots} */
window.renderWallpaperDots = renderWallpaperDots;

/** @type {typeof triggerWallpaperUpload} */
window.triggerWallpaperUpload = triggerWallpaperUpload;

/** @type {typeof addCustomWallpapers} */
window.addCustomWallpapers = addCustomWallpapers;

/** @type {typeof removeCustomWallpaper} */
window.removeCustomWallpaper = removeCustomWallpaper;

/** @type {typeof applyAvatar} */
window.applyAvatar = applyAvatar;

/** @type {typeof saveAvatar} */
window.saveAvatar = saveAvatar;

/** @type {typeof bindWallpaperEvents} */
window.bindWallpaperEvents = bindWallpaperEvents;

/**
 * 供 admin.js 在管理员审核壁纸后强制刷新缓存。
 * 命名为 invalidateWallpaperCache（下划线前缀）表示这是内部方法，
 * 外部模块仅在特殊场景（管理面板）下使用。
 */
/** @type {typeof invalidateWallpaperCache} */
window.invalidateWallpaperCache = invalidateWallpaperCache;

// currentWallpaper 通过 getter/setter 暴露给外部
// 外部可以直接读取 window.currentWallpaper 获取当前索引，
// 或设置 window.currentWallpaper = 3 来程序化切换（但不推荐，应使用 applyWallpaper）
Object.defineProperty(window, 'currentWallpaper', {
  get: function() { return currentWallpaper; },
  set: function(v) { currentWallpaper = v; }
});

// =========================================================================
// Mobile swipe-to-switch wallpaper (touch gesture)
// 移动端滑动手势切换壁纸
// =========================================================================

/**
 * 内嵌 IIFE：移动端触摸手势子系统。
 *
 * 【它做什么】
 *   在移动端（<=540px 宽度）监听全局 touch 事件：
 *   - touchstart: 记录起始坐标，预加载相邻壁纸
 *   - touchmove:  判断滑动方向（水平 vs 垂直），水平滑动时实时偏移背景位置
 *   - touchend:   如果水平滑动距离 >= 50px，切换到相邻壁纸并执行交叉淡入淡出
 *   - touchcancel: 清理状态
 *
 * 【为什么不在非交互区域也能滑动】
 *   isInteractingWithUI() 检测触摸目标是否在侧边栏、模态框、按钮等交互元素上。
 *   在这些元素上不触发壁纸滑动，避免与正常 UI 操作冲突。
 *   在页面空白区域（如内容区背景）滑动即可切换壁纸。
 */
(function() {
  var _touchStartX = 0;    // 触摸起始 X 坐标
  var _touchStartY = 0;    // 触摸起始 Y 坐标
  var _touchActive = false; // 触摸是否活跃（用于 move/end 判断）
  var _touchSwiping = false; // 是否已确认为水平滑动（vs 垂直滚动）
  var SWIPE_THRESHOLD = 50;  // 触发切换的最小滑动距离（px）

  /** 判断当前是否为移动端（宽度 <= 540px） */
  function isMobile() { return window.innerWidth <= 540; }

  /**
   * 判断触摸目标是否在可交互 UI 元素上。
   * 如果在侧边栏、内容面板、模态框、按钮等元素上，不应触发壁纸滑动。
   *
   * 【为什么包含这么多选择器】
   *   所有需要正常交互的元素都应排除，否则滑动切换壁纸会与
   *   页面滚动、按钮点击、模态框操作等产生手势冲突。
   */
  function isInteractingWithUI(target) {
    return target.closest('.sidebar, .content-panel, .modal-overlay:not(.hidden), .wallpaper-picker, .bgm-player, #sakuraCanvas, button, input, textarea, select, a');
  }

  /**
   * 预加载相邻壁纸（左右各一张），优化滑动切换后的视觉体验。
   */
  function preloadAdjacent() {
    getAllWallpapers().then(function(items) {
      if (!items || items.length < 2) return;
      var next = currentWallpaper + 1 < items.length ? currentWallpaper + 1 : 0;
      var prev = currentWallpaper - 1 >= 0 ? currentWallpaper - 1 : items.length - 1;
      [next, prev].forEach(function(i) {
        var u = items[i].value.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
        if (u) { var img = new Image(); img.src = u; }
      });
    });
  }

  /**
   * 执行滑动切换壁纸的动画。
   *
   * 【与 applyWallpaper 的区别】
   *   swipeTransition 是独立实现的交叉淡入淡出，不使用 applyWallpaper。
   *   因为它有自己的动画参数（0.45s 淡入 / 0.8s 淡出）和回调时序，
   *   且需要与滑动手势的视觉反馈配合。
   *
   * 【输入】
   *   targetIdx — 目标壁纸在列表中的索引
   *   items     — 壁纸列表（从 getAllWallpapers 获取，避免 async 竞态）
   */
  function swipeTransition(targetIdx, items) {
    var wp = items[targetIdx];
    var url = wp.value.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    var bgLayer = document.getElementById('bgLayer');

    var prev = currentWallpaper;
    currentWallpaper = targetIdx;
    safeSetItem('wallpaperIdx', currentWallpaper);
    renderWallpaperDots();

    if (!url || !bgLayer) {
      document.body.style.backgroundImage = wp.value || '';
      preloadAdjacent();
      return;
    }

    var gen = ++_wallpaperGen;
    var img = new Image();
    img.onload = function() {
      if (gen !== _wallpaperGen) return;
      // 淡入阶段：bgLayer 显示新壁纸（0.45s transition）
      bgLayer.style.backgroundImage = wp.value;
      bgLayer.style.transition = 'opacity 0.45s ease';
      bgLayer.style.opacity = '1';

      // 500ms 后切换 body 背景并淡出 bgLayer（0.8s transition）
      setTimeout(function() {
        if (gen !== _wallpaperGen) return;
        document.body.style.backgroundImage = wp.value;
        bgLayer.style.transition = 'opacity 0.8s ease-in-out';
        bgLayer.style.opacity = '0';
      }, 500);
    };
    img.src = url;

    // 超时保护：2s 后如果图片仍未加载完成，强制切换
    setTimeout(function() {
      if (!img.complete && gen === _wallpaperGen) {
        document.body.style.backgroundImage = wp.value;
        bgLayer.style.opacity = '0';
      }
    }, 2000);

    preloadAdjacent();
  }

  // touchstart: 记录起始坐标，预加载相邻壁纸
  document.addEventListener('touchstart', function(e) {
    if (!isMobile() || e.touches.length !== 1) return; // 非移动端或多指 → 忽略
    if (isInteractingWithUI(e.target)) return;          // 交互元素 → 忽略
    _touchStartX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
    _touchActive = true;
    _touchSwiping = false;
    preloadAdjacent(); // 提前加载，优化切换体验
  }, { passive: true });

  // touchmove: 判断滑动方向，实时偏移背景位置作为视觉反馈
  document.addEventListener('touchmove', function(e) {
    if (!_touchActive) return;
    var dx = e.touches[0].clientX - _touchStartX;
    var dy = e.touches[0].clientY - _touchStartY;

    if (!_touchSwiping) {
      // 尚未确定方向：水平位移 > 12px 且水平位移 > 垂直位移 * 1.3 → 水平滑动
      // 垂直位移 > 12px → 放弃（用户想滚动页面）
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        _touchSwiping = true;
      } else if (Math.abs(dy) > 12) {
        _touchActive = false; // 垂直滚动，取消本次手势
        return;
      } else {
        return; // 尚未超过判定阈值，等待更多移动
      }
    }

    // 确认为水平滑动 → 阻止默认行为（防止页面回弹/返回手势）
    e.preventDefault();
    // 实时偏移背景位置，给用户视觉反馈（最多偏移 ±60%）
    var shift = (dx / window.innerWidth) * 60;
    document.body.style.backgroundPositionX = 'calc(50% - ' + shift + '%)';
  }, { passive: false }); // passive: false 以允许 preventDefault

  // touchend: 判断是否触发切换
  document.addEventListener('touchend', function(e) {
    if (!_touchActive) return;
    var endX = (e.changedTouches[0] || { clientX: _touchStartX }).clientX;
    var dx = endX - _touchStartX;

    // B-12: 标记触摸处理时间，防止后续 click 事件重复触发
    _wpLastTouchTime = Date.now();

    // 重置背景偏移
    document.body.style.backgroundPositionX = '';
    var wasSwiping = _touchSwiping;
    _touchActive = false;
    _touchSwiping = false;

    // 未确认为滑动 或 滑动距离不足 → 不触发切换
    if (!wasSwiping || Math.abs(dx) < SWIPE_THRESHOLD) return;

    // 异步获取壁纸列表并执行切换
    getAllWallpapers().then(function(items) {
      if (!items || items.length < 2) return;
      var target;
      if (dx > 0) {
        // 向右滑 → 上一张（循环）
        target = currentWallpaper - 1 >= 0 ? currentWallpaper - 1 : items.length - 1;
      } else {
        // 向左滑 → 下一张（循环）
        target = currentWallpaper + 1 < items.length ? currentWallpaper + 1 : 0;
      }
      swipeTransition(target, items);
    });
  }, { passive: true });

  // touchcancel: 清理手势状态
  document.addEventListener('touchcancel', function() {
    document.body.style.backgroundPositionX = '';
    _touchActive = false;
    _touchSwiping = false;
  }, { passive: true });
})();

export { DEFAULT_WALLPAPERS, getAllWallpapers, applyWallpaper, renderWallpaperDots, triggerWallpaperUpload, addCustomWallpapers, removeCustomWallpaper, applyAvatar, saveAvatar, bindWallpaperEvents, invalidateWallpaperCache };

