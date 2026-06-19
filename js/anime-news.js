/**
 * anime-news.js — 二次元资讯右侧侧边栏
 *
 * 【它做什么】
 *   从 Supabase 拉取每日二次元资讯，渲染到右侧滑出侧边栏。
 *   支持缓存、定时刷新、置顶/热门标记、管理员前台删除、点击查看详情。
 *   当 Supabase 不可用时，自动降级到本地 static/data/anime-news.json。
 *
 * 【数据流】
 *   Supabase (anime_news 表) ──→ localStorage 缓存 ──→ renderNewsPanel() ──→ DOM (#newsSidebar)
 *   降级路径: static/data/anime-news.json ──→ 同上
 *
 * 【与 window 全局变量的关系】
 *   读取:
 *     sb (imported)              — Supabase client 实例
 *     escHtml (imported)         — HTML 转义函数
 *     showToast (imported)       — Toast 通知函数
 *     safeSetItem (imported)     — 安全的 localStorage.setItem
 *     window.sanitizeHtml        — HTML 净化函数 (由 articles.js 注入)
 *     window.EventBus            — 事件总线 (由 event-bus.js 注入)
 *     window._isLoggedIn         — 登录状态标记 (由 settings.js 注入)
 *     window.onNewsPanelOpened   — 旧版回调兼容 (由 main.js 或其他脚本设置)
 *     window.onNewsPanelClosed   — 旧版回调兼容
 *     marked                     — Markdown 解析器 (由 marked.js CDN 注入)
 *
 *   写入 (暴露给外部):
 *     window._refreshNewsPanel   — 刷新资讯面板 (供管理面板调用)
 *     window._getNewsData        — 获取资讯数据 (供管理面板/调试调用)
 *     window.openNewsPanel       — 打开资讯侧栏 (供 nav 按钮调用)
 *     window.closeNewsPanel      — 关闭资讯侧栏 (供其他面板互斥用)
 *     window.toggleNewsPanel     — 切换资讯侧栏
 *
 * 【副作用】
 *   - 读写 localStorage (key: 'animeNewsCache')
 *   - 修改 DOM (#newsSidebar, #articleModal 等)
 *   - 设置/清除全局定时器 (_newsRefreshTimer)
 *   - 监听 EventBus 的 'news:refresh' 事件
 *   - 发送 EventBus 的 'news:panelOpened' / 'news:panelClosed' 事件
 *   - 操作浏览器 history (replaceState 清除 #news hash)
 */

import { sb, escHtml, showToast } from './supabase.mjs';
import { createCache } from './cache.mjs';
import { tSync } from './i18n.js';

// ==================== Anime News — Right Sidebar ====================

// ============================
// 缓存 & 状态变量
// ============================

// 资讯侧栏是否处于打开状态
var panelOpen = false;

// 定时刷新计时器句柄，用于取消/重建定时器
var _newsRefreshTimer = null;

// ============================
// 日期工具
// ============================

// ============================
// 数据获取 (三层降级策略：createCache 统一缓存层)
// ============================

/**
 * fetchSupabaseNews()
 *
 * 【它做什么】
 *   从 Supabase 的 anime_news 表拉取全部资讯。
 *   先按 news_date 降序，再按 id 降序排列。
 *
 * 【为什么按 news_date + id 双重排序】
 *   同一天可能有多条资讯，news_date 保证按天分组，
 *   id 保证同一天内新插入的排前面。
 *
 * 【输入】无
 * 【输出】Array|null — Supabase 返回的数据数组，或 null 表示失败
 * 【副作用】发送 HTTPS 请求到 Supabase REST API
 * 【调用者】getNews()
 */
async function fetchSupabaseNews() {
  if (!sb) return null; // Supabase client 未初始化 (如未加载 supabase.js)
  try {
    var result = await sb.from('anime_news')
      .select('*')
      .order('news_date', { ascending: false })
      .order('id', { ascending: false });
    if (!result.error && result.data && result.data.length > 0) return result.data;
  } catch (e) { /* Supabase 不可用 — 静默降级到本地 JSON */ }
  return null;
}

/**
 * fetchLocalNews()
 *
 * 【它做什么】
 *   从 static/data/anime-news.json 读取本地资讯兜底数据。
 *   这个 JSON 由 GitHub Actions 每天自动生成并部署。
 *
 * 【为什么需要兜底】
 *   Supabase 可能因网络问题、服务宕机、免费计划暂停等原因不可用。
 *   本地 JSON 由 CI/CD 生成并随站点一起部署，是可靠的 fallback。
 *
 * 【输入】无
 * 【输出】Array — 资讯对象数组 (失败时返回空数组 [])
 * 【副作用】发送 HTTP GET 请求
 * 【调用者】getNews()
 */
async function fetchLocalNews() {
  try {
    var res = await fetch('data/anime-news.json');
    return await res.json();
  } catch (e) { return []; } // 本地 JSON 也不可用，返回空数组
}

/**
 * _fetchNews —— 从 Supabase 或本地 JSON 获取资讯（未缓存版本）。
 *
 * 【它做什么】
 *   合并原有 fetchSupabaseNews() + fetchLocalNews() 的降级逻辑，
 *   并对 Supabase 返回的行做字段标准化映射。
 *   此函数作为 createCache 的 factory，由缓存层控制调用频率和 TTL。
 *
 * 【数据流向】
 *   Supabase anime_news 表 → 标准化映射 → 返回
 *   若 Supabase 不可用 → fetch('data/anime-news.json') → 返回
 *
 * 【输入】无
 * 【输出】Promise<Array> — 资讯对象数组
 * 【调用者】_newsCache（createCache 内部）
 */
async function _fetchNews() {
  var supabaseNews = await fetchSupabaseNews();
  if (supabaseNews) {
    return supabaseNews.map(function(n) {
      return {
        id: n.id, title: n.title, summary: n.summary,
        content: n.content, source: n.source, url: n.url,
        date: n.news_date, pinned: n.pinned, heat: n.heat
      };
    });
  }
  return await fetchLocalNews();
}

/**
 * _newsCache —— 资讯数据缓存（1 小时 TTL）。
 *
 * 【为什么 1 小时】
 *   1. 资讯变更频率低（GitHub Actions 每日一次 + 管理员手动编辑）
 *   2. 与定时刷新间隔对齐（scheduleNextRefresh 每小时触发）
 *   3. 使用 createCache 统一缓存层，与 articles/wallpaper/bgm 保持一致
 */
var _newsCache = createCache
  ? createCache(_fetchNews, 3600000)
  : null;

/**
 * getNews()
 *
 * 【它做什么】
 *   获取资讯的核心函数。通过 _newsCache.get() 走 createCache 缓存层。
 *   缓存有效则直接返回；缓存过期或不存在则触发 _fetchNews 重新获取。
 *
 * 【输入】无
 * 【输出】Array — 标准化的资讯对象数组
 * 【调用者】init()、refreshNews()、deleteNewsItem()、window._getNewsData
 */
async function getNews() {
  if (_newsCache) return _newsCache.get();
  return _fetchNews();
}

// ============================
// 刷新
// ============================

/**
 * refreshNews()
 *
 * 【它做什么】
 *   清除缓存 → 重新拉取 → 重新渲染 → 显示 Toast。
 *   操作期间给刷新按钮添加旋转动画并禁用，防止重复点击。
 *
 * 【为什么先清除缓存再拉取】
 *   如果不清除，readCache() 直接返回旧数据，getNews() 不会发起网络请求。
 *
 * 【输入】无
 * 【输出】无 (void)
 * 【副作用】
 *   - 删除 localStorage 缓存
 *   - 重新渲染 DOM (renderNewsPanel)
 *   - 操作按钮 CSS class 和 disabled 状态
 *   - 调用 showToast
 * 【调用者】
 *   - #btnNewsRefresh 按钮点击事件
 *   - scheduleNextRefresh() 定时器
 *   - EventBus 'news:refresh' 事件
 *   - window._refreshNewsPanel 外部调用
 */
async function refreshNews() {
  var btn = document.getElementById('btnNewsRefresh');
  // 旋转动画 + 禁用双击 — 防止短时间内重复刷新导致数据竞态
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  try {
    if (_newsCache) _newsCache.invalidate();
    var items = await getNews();
    renderNewsPanel(items);
    if (typeof showToast === 'function') {
      showToast(tSync('news.updated'), 'success');
    }
  } catch (e) {
    if (typeof showToast === 'function') {
      showToast(tSync('news.refreshFailed'), 'warn');
    }
  } finally {
    // 无论成功失败，恢复按钮状态
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

// ============================
// 资讯数据存储 & 删除
// ============================

/**
 * _newsData — 当前渲染的资讯完整数据
 *
 * 【用途】
 *   点击卡片时，通过索引从 _newsData 获取资讯对象，打开详情 Modal。
 *   不能直接存 DOM 里 (不安全/数据量可能很大)，
 *   也不适合每次重新查询 Supabase (慢)，所以用内存数组做中介。
 */
var _newsData = [];

/**
 * deleteNewsItem()
 *
 * 【它做什么】
 *   管理员前台删除一条资讯。只有满足条件的条目才能删除:
 *   - 必须是 Supabase 条目 (有数字 id，id > 0)
 *   - 必须是手写/curated 条目 (有 content 或 pinned)
 *   本地 JSON 的条目不能在这里删除 (需要改 JSON 并重新部署)。
 *
 * 【为什么限制删除条件】
 *   1. 只有 Supabase 条目才能通过 API 删除 — 本地 JSON 条目没有后端
 *   2. 只有手写/置顶条目才允许管理员前台删除，自动抓取的条目应通过管理面板/数据源管理
 *
 * 【输入】
 *   id       — number|null，要删除的资讯 id
 *   newsDate — string，资讯日期 (目前未直接使用，保留以备日志)
 * 【输出】无 (void)
 * 【副作用】
 *   - 调用 confirm() 弹窗
 *   - 调用 Supabase DELETE API
 *   - 删除 localStorage 缓存
 *   - 重新渲染资讯面板
 *   - 发送 EventBus 'news:refresh' 事件 (通知管理面板同步)
 * 【调用者】资讯卡片上的删除按钮点击事件 (事件委托)
 */
async function deleteNewsItem(id, newsDate) {
  if (!id) {
    // 本地 JSON 条目无法通过 API 删除
    if (typeof showToast === 'function') showToast(tSync('news.adminDeleteOnly'), 'warn');
    return;
  }
  if (!confirm('确定删除这条资讯？')) return;
  if (!sb) {
    if (typeof showToast === 'function') showToast(tSync('news.serviceDown'));
    return;
  }
  try {
    var r = await sb.from('anime_news').delete().eq('id', id);
    if (r.error) {
      if (typeof showToast === 'function') showToast(tSync('news.deleteFailed') +  r.error.message);
      return;
    }
    if (typeof showToast === 'function') showToast(tSync('news.deleted'), 'success');
    // 刷新缓存 + 重新渲染，确保 UI 与数据库一致
    if (_newsCache) _newsCache.invalidate();
    var items = await getNews();
    renderNewsPanel(items);
    // 通知管理面板同步更新
    if (typeof window.EventBus !== 'undefined') window.EventBus.emit('news:refresh');
  } catch (e) { console.warn('[anime-news] 删除资讯失败:', e); }
}

// ============================
// 渲染
// ============================

/**
 * renderNewsPanel()
 *
 * 【它做什么】
 *   将资讯数组渲染为 HTML 卡片列表，写入 #newsList。
 *   每条资讯渲染: 标题 + 来源标签 + 置顶/热门徽章 + 删除按钮(管理员可见) + 摘要 + 外链
 *
 * 【渲染决策】
 *   - 来源标签: 显示在标题右侧，帮助用户识别资讯来源
 *   - 置顶徽章: pinned 为 true 时显示 📌
 *   - 热门徽章: heat >= 50 时显示 🔥 (threshold 可调)
 *   - 删除按钮: 仅管理员可用 + 仅 Supabase 手写条目可删除
 *   - 外链: 新标签页打开，rel="noopener" 防止 window.opener 攻击
 *
 * 【为什么用 innerHTML 而不是 createElement】
 *   资讯卡片结构简单、无用户交互控件 (除了删除按钮)、数据来自可信源。
 *   innerHTML 性能更好，且已通过 escHtml() 转义。
 *
 * 【输入】
 *   items — Array，资讯对象数组 (可选，为空时复用 _newsData)
 * 【输出】无 (void)
 * 【副作用】修改 #newsList 的 innerHTML (DOM 写入)
 * 【调用者】
 *   - init() — 首次渲染
 *   - refreshNews() — 刷新后重新渲染
 *   - deleteNewsItem() — 删除后重新渲染
 */
function renderNewsPanel(items) {
  _newsData = items || [];
  var list = document.getElementById('newsList');
  if (!list) return; // DOM 元素不存在 (不在首页)
  if (!items || !items.length) {
    list.innerHTML = '<div class="news-empty">暂无今日资讯 ✦</div>';
    return;
  }
  list.innerHTML = items.map(function(item, idx) {
    // ---- 构建卡片各个组件 ----
    var srcTag = item.source ? '<span class="news-source-tag">' + escHtml(item.source) + '</span>' : '';
    var pinnedBadge = item.pinned ? ' <span class="news-pin-badge">📌置顶</span>' : '';
    var heatBadge = (item.heat && item.heat >= 50) ? ' <span class="news-heat-badge">🔥热门</span>' : '';

    // 管理员可删除 Supabase 资讯（id 为正整数的条目）
    // 本地 JSON 条目（id 为字符串或 0）需进管理面板删除
    var canDelete = window._isLoggedIn && typeof item.id === 'number' && item.id > 0;
    var delBtn = canDelete
      ? '<button class="inline-delete-btn news-card-del-btn" data-card-delete-news="' + (item.id || '') + '" data-news-date="' + escHtml(item.date || '') + '" title="删除此资讯">✕</button>'
      : '';

    // data-news-idx 存储索引，点击时回查 _newsData[idx]
    return '<div class="news-card" data-news-idx="' + idx + '">' +
      '<div class="news-card-title">' + escHtml(item.title) + srcTag + pinnedBadge + heatBadge + delBtn + '</div>' +
      '<div class="news-card-summary">' + escHtml(item.summary) + '</div>' +
      (item.url ? '<a class="news-card-link" href="' + escHtml(item.url) + '" target="_blank" rel="noopener">查看来源 →</a>' : '') +
    '</div>';
  }).join('');
}

// escHtml is now imported from supabase.mjs — no local fallback wrapper needed.

// ============================
// 资讯详情弹窗
// ============================

/**
 * openNewsDetail()
 *
 * 【它做什么】
 *   复用文章 Modal (#articleModal) 展示资讯详情。
 *   填入标题、来源、日期、正文内容 (Markdown 渲染)。
 *   隐藏文章专属元素 (封面图、剧透警告)。
 *
 * 【为什么复用文章 Modal 而不是新建】
 *   1. 减少 DOM 节点，保持页面简洁
 *   2. 资讯和文章的内容结构相似 (标题 + 元信息 + 正文)
 *   3. 复用已有的 CSS 样式和关闭逻辑
 *   4. 避免维护两套几乎相同的弹窗代码
 *
 * 【内容策略】
 *   - 有 content 字段 → 渲染 Markdown 正文
 *   - 只有 summary   → 显示摘要
 *   - 有 url 但无 content → 末尾追加原文链接提示
 *
 * 【输入】
 *   idx — number，_newsData 数组的索引
 * 【输出】无 (void)
 * 【副作用】修改 #articleModal 内部多个元素的 textContent / innerHTML / style
 * 【调用者】资讯卡片点击事件 (事件委托)
 */
function openNewsDetail(idx) {
  var item = _newsData[idx];
  if (!item) return;

  // 填内容到已有 article modal
  document.getElementById('articleModalTitle').textContent = item.title;
  document.getElementById('articleModalMeta').textContent = '📡 ' + (item.source || '二次元资讯') + ' · ' + (item.date || '').slice(0, 10);
  document.getElementById('articleModalTags').innerHTML = item.source ? '<span class="tag blue">' + escHtml(item.source) + '</span>' : '';

  // 隐藏文章专属元素 — 资讯没有封面图、没有剧透警告
  var coverEl = document.getElementById('articleModalCover');
  if (coverEl) coverEl.style.display = 'none';
  var spoilerWarn = document.getElementById('articleModalSpoilerWarn');
  if (spoilerWarn) spoilerWarn.style.display = 'none';

  // 外链: 有 url 时显示链接按钮
  var linkWrap = document.getElementById('articleModalLinkWrap');
  if (linkWrap) linkWrap.style.display = item.url ? '' : 'none';
  if (linkWrap && item.url) {
    linkWrap.innerHTML = '<a href="' + escHtml(item.url) + '" target="_blank" rel="noopener" class="modal-link-btn">🔗 查看原文</a>';
  }

  // 正文: 有 content 用 content (Markdown)，否则展示完整 summary + source
  var body = item.content || item.summary || '';
  if (!item.content && item.url) {
    body += '\n\n> 原文链接：' + item.url;
  }
  document.getElementById('articleModalContent').innerHTML = window.renderMarkdown(body);

  document.getElementById('articleModal').classList.remove('hidden');
}

// ============================
// 侧栏开关
// ============================

/**
 * openNewsPanel()
 *
 * 【它做什么】
 *   打开资讯侧边栏: 添加 CSS class + 按钮激活态 + 通知导航栏同步状态。
 *
 * 【面板互斥机制】
 *   通过 EventBus 发送 'news:panelOpened' 事件，导航栏接收后
 *   关闭其他面板 (如收藏面板)，避免同时打开多个侧栏。
 *   如果 EventBus 不可用，fallback 到 window.onNewsPanelOpened 回调。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】
 *   - 修改 #newsSidebar 的 CSS class
 *   - 修改 #btnNewsToggle 的 CSS class
 *   - 发送 EventBus 事件
 * 【调用者】
 *   - #btnNewsToggle 按钮点击 → toggleNewsPanel()
 *   - window.openNewsPanel 外部调用
 */
function openNewsPanel() {
  panelOpen = true;
  var panel = document.getElementById('newsSidebar');
  if (panel) panel.classList.add('open');
  var trigger = document.getElementById('btnNewsToggle');
  if (trigger) trigger.classList.add('active');
  // 同步 nav 状态 — 使用 EventBus 实现松耦合
  if (typeof window.EventBus !== 'undefined') { window.EventBus.emit('news:panelOpened'); }
  else if (typeof window.onNewsPanelOpened === 'function') { window.onNewsPanelOpened(); }
}

/**
 * closeNewsPanel()
 *
 * 【它做什么】
 *   关闭资讯侧边栏: 移除 CSS class + 取消按钮激活态 + 清除 URL hash + 通知导航栏。
 *
 * 【为什么清除 #news hash】
 *   打开资讯面板时可能设置了 location.hash = '#news' (由外部设置)。
 *   关闭时需要清除，否则刷新页面可能再次打开面板。
 *   使用 replaceState 而不是 pushState，避免增加历史记录。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】
 *   - 修改 #newsSidebar 的 CSS class
 *   - 修改 #btnNewsToggle 的 CSS class
 *   - 修改浏览器 URL (history.replaceState)
 *   - 发送 EventBus 事件
 * 【调用者】
 *   - 遮罩层点击事件
 *   - 外部点击关闭 (document click 事件)
 *   - toggleNewsPanel()
 *   - window.closeNewsPanel 外部调用
 */
function closeNewsPanel() {
  panelOpen = false;
  var panel = document.getElementById('newsSidebar');
  if (panel) panel.classList.remove('open');
  var trigger = document.getElementById('btnNewsToggle');
  if (trigger) trigger.classList.remove('active');
  // 清除 news hash — 防止刷新后自动打开面板
  if (window.location.hash === '#news') {
    try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
  }
  // 同步 nav 状态
  if (typeof window.EventBus !== 'undefined') { window.EventBus.emit('news:panelClosed'); }
  else if (typeof window.onNewsPanelClosed === 'function') { window.onNewsPanelClosed(); }
}

/**
 * toggleNewsPanel()
 *
 * 【它做什么】
 *   切换侧边栏开关状态。如果当前打开则关闭，否则打开。
 *
 * 【输入】无
 * 【输出】无
 * 【调用者】#btnNewsToggle 按钮点击事件
 */
function toggleNewsPanel() {
  if (panelOpen) { closeNewsPanel(); } else { openNewsPanel(); }
}

// ============================
// 定时刷新
// ============================

/**
 * scheduleNextRefresh()
 *
 * 【它做什么】
 *   计算到下一个整点 + 2 分钟的时间，设置 setTimeout 到时触发刷新。
 *   刷新完成后递归调用自己，重新计算下一次刷新时间。
 *
 * 【为什么是 "整点 + 2 分钟"】
 *   GitHub Actions 通常在整点或半点触发更新（cron 表达式：每小时或每半小时）。
 *   加 2 分钟缓冲确保 Actions 有足够时间完成数据生成和部署。
 *   如果 Actions 配置改变，这个缓冲保证了兼容性。
 *
 * 【为什么用 setTimeout 而不是 setInterval】
 *   setInterval 不考虑操作耗时。如果刷新过程超过间隔，
 *   可能导致多个刷新并发执行。setTimeout 递归保证了串行执行。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】设置/清除 _newsRefreshTimer
 * 【调用者】init()
 */
function scheduleNextRefresh() {
  if (_newsRefreshTimer) clearTimeout(_newsRefreshTimer);
  // 计算下一个整点 + 2 分钟缓冲
  var now = new Date();
  var next = new Date(now);
  next.setHours(next.getHours() + 1, 0, 0, 0);
  var delay = next - now + 120000; // 120000ms = 2 分钟缓冲
  _newsRefreshTimer = setTimeout(function() {
    refreshNews();
    scheduleNextRefresh(); // 递归: 刷新完成后重新安排下一次
  }, delay);
}

// ============================
// 事件绑定
// ============================

/**
 * bindAnimeNewsEvents()
 *
 * 【它做什么】
 *   绑定所有资讯面板相关的事件监听器:
 *     1. 切换按钮 → toggleNewsPanel
 *     2. 刷新按钮 → refreshNews
 *     3. 遮罩层点击 → closeNewsPanel
 *     4. 资讯卡片点击 → openNewsDetail (事件委托)
 *     5. 删除按钮点击 → deleteNewsItem (事件委托)
 *     6. 外部点击关闭 → 点侧栏外部区域时关闭
 *
 * 【为什么用事件委托】
 *   卡片是动态渲染的 (innerHTML 更新)，不能直接在卡片元素上绑定事件。
 *   在 #newsList 上委托是唯一可靠的方式。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】添加事件监听器到多个 DOM 元素
 * 【调用者】init()
 */
function bindAnimeNewsEvents() {
  // 1. 切换按钮
  var trigger = document.getElementById('btnNewsToggle');
  if (trigger) trigger.addEventListener('click', toggleNewsPanel);

  var panel = document.getElementById('newsSidebar');
  if (panel) {
    // 2. 刷新按钮
    var refreshBtn = document.getElementById('btnNewsRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshNews);

    // 3. 点遮罩层 (panel 本身，非子元素) 关闭
    panel.addEventListener('click', function(e) {
      if (e.target === panel) closeNewsPanel();
    });

    // 4. 资讯列表事件委托
    var newsList = document.getElementById('newsList');
    if (newsList) {
      newsList.addEventListener('click', function(e) {
        // 外链不拦截 — 让浏览器默认行为处理
        if (e.target.closest('.news-card-link')) return;

        // 管理员删除按钮
        var delBtn = e.target.closest('[data-card-delete-news]');
        if (delBtn) {
          e.stopPropagation(); // 防止触发展开详情
          var nid = delBtn.getAttribute('data-card-delete-news');
          deleteNewsItem(nid ? parseInt(nid) : null, delBtn.getAttribute('data-news-date'));
          return;
        }

        // 卡片点击 → 打开详情
        var card = e.target.closest('.news-card[data-news-idx]');
        if (card) {
          openNewsDetail(parseInt(card.getAttribute('data-news-idx')));
        }
      });
    }
  }

  // 5. 全局点击关闭: 点侧栏外部区域时关闭面板
  document.addEventListener('click', function(e) {
    if (!panelOpen) return; // 面板未打开，无需处理
    // 点击侧栏内部 或 切换按钮 → 不关闭
    if (e.target.closest('#newsSidebar') || e.target.closest('#btnNewsToggle')) return;
    // 点击底部导航栏 → 不关闭 (移动端切换标签页不应关闭面板)
    if (e.target.closest('.side-nav-item') || e.target.closest('#btnMore') || e.target.closest('.more-menu')) return;
    closeNewsPanel();
  });
}

// ============================
// 初始化
// ============================

/**
 * init() — 脚本入口
 *
 * 【它做什么】
 *   1. 绑定所有事件监听器
 *   2. 设置日期标题
 *   3. 拉取并渲染资讯
 *   4. 启动定时刷新循环
 *   5. 暴露 API 到 window 全局
 *
 * 【为什么暴露到 window】
 *   其他脚本 (管理面板、导航栏) 需要通过 window.xxx 调用这些函数。
 *   EventBus 是首选的通信方式，window 变量是 fallback 兼容。
 *
 * 【副作用】
 *   - 发起网络请求 (Supabase 或 fetch)
 *   - 写入 DOM
 *   - 写入 localStorage
 *   - 设置定时器
 *   - 注册 EventBus 监听器
 *   - 写入 window 全局变量
 */
(async function init() {
  bindAnimeNewsEvents();

  // 设置日期标题: 格式 "📡 MM-DD"
  var now = new Date();
  if (now.getHours() < 6) now.setDate(now.getDate() - 1);
  var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  var headerEl = document.getElementById('newsHeaderDate');
  if (headerEl) { headerEl.textContent = '📡 ' + today.slice(5); } // slice(5) 去掉 "YYYY-"

  // 拉取数据并渲染
  var items = await getNews();
  renderNewsPanel(items);

  // 启动定时刷新
  scheduleNextRefresh();

  // 对外 API:
  // EventBus 方式 (首选) — 松耦合，不依赖全局变量
  if (typeof window.EventBus !== 'undefined') {
    window.EventBus.on('news:refresh', refreshNews);
  }
  // window 变量方式 (兼容) — 旧代码或直接调用
  window._refreshNewsPanel = refreshNews;   // 管理面板调用的刷新
  window._getNewsData = getNews;             // 获取原始数据 (调试/管理用)
  window.openNewsPanel = openNewsPanel;      // 打开侧栏
  window.closeNewsPanel = closeNewsPanel;    // 关闭侧栏
  window.toggleNewsPanel = toggleNewsPanel;  // 切换侧栏
})();

// ---------------------------------------------------------------
// ES Module 导出
// ---------------------------------------------------------------

export { openNewsPanel, closeNewsPanel, toggleNewsPanel, refreshNews, getNews };
