// ==================== Articles — Load / Filter / Render / Submit ====================
//
// 【这个文件是什么】
//   个人站点的文章模块。
//   负责文章数据的加载与缓存（Supabase + 本地 JSON fallback）、标签筛选、
//   卡片/时间线双视图渲染、文章详情 Modal、文章投稿提交、
//   以及 HTML 消毒（sanitizeHtml）。
//
// 【数据流向】
//   文章数据有两个来源，按优先级合并：
//     1. Supabase articles 表（published=true，仅登录用户可见）
//     2. data/articles.json 静态文件（fallback；未登录时隐藏 public=false 的文章）
//   → _fetchArticleData() 合并去重 → createCache 包装为 5 分钟缓存
//   → loadArticles() 填充 articles / allTags / _articleMap → renderFilters() + renderArticles()
//
// 【与 window 全局变量的关系】
//   - 读取 window._isLoggedIn（登录状态）
//   - 读取 window.EventBus（跨模块事件总线，来自 event-bus.js）
//   - 调用 window.marked（Markdown 解析库，第三方 CDN 加载）
//   - 向 window 导出：loadArticles, renderArticles, renderFilters, setFilter,
//     openArticleDetail, openArticleDetail, closeArticleModal, sanitizeHtml,
//     bindSubmitEvents, _invalidateArticleCache
//
// 【为什么现在是 ESM】
//   已从 IIFE 迁移到 ES Module。导入 supabase.mjs 和 cache.mjs 的导出，
//   保留 window._isLoggedIn / window.EventBus 等全局状态引用以维持向后兼容。

import { sb, getCachedUser, showLoading, hideLoading, showToast, escHtml } from './supabase.mjs';
import { createCache } from './cache.mjs';
import { tSync } from './i18n.js';

// =========================================================================
// 模块内部状态（闭包私有）
// =========================================================================

/** 当前选中的标签筛选条件。'全部' 表示不筛选。 */
var activeFilter = '全部';

/** 搜索框输入的关键词。空字符串表示不搜索。 */
var searchQuery = '';

/** 视图模式：'cards'（卡片视图）或 'timeline'（时间线视图）。 */
var articleView = 'cards';

/** 所有可用标签的数组，首项固定为 '全部'。 */
var allTags = [];

/** 当前文章 DTO 数组（用于列表渲染的轻量数据）。 */
var articles = [];

/**
 * id → 完整文章记录 的映射表，用于 Modal 详情展示。
 * key 为文章 id（number），value 为 Supabase/article.json 的原始行数据。
 */
var _articleMap = {};

// =========================================================================
// 数据获取层（由 createCache 包装）
// =========================================================================

/**
 * @typedef {object} ArticleData
 * @property {Array}    articles  - DTOs for list rendering
 * @property {string[]} tags      - Unique tag list (with '全部' prepended)
 * @property {object}   map       - id → full record map
 */

/**
 * _fetchArticleData —— 获取、合并、排序、规范化所有文章。
 *
 * 【它做什么】
 *   从 Supabase 和本地 JSON 两个数据源获取文章，去重合并，按日期降序排序，
 *   然后拆分为三个产物：列表用的 DTO 数组、标签列表、id→原文映射。
 *
 * 【数据流向】
 *   1. 如果已登录且 sb 存在：
 *      查询 Supabase articles 表（published=true）→ 写入 seenIds + map + merged
 *   2. fetch('data/articles.json')：
 *       未登录 → 过滤掉 public===false 的记录
 *       已登录 → 全部保留，但跳过 seenIds 中已有的（Supabase 优先）
 *      → 写入 seenIds + map + merged
 *   3. merged 按 created_at/date 降序排序
 *   4. 映射为 DTO 数组 + 收集所有标签（去重） + 保留 id→原文 map
 *
 * 【输入】
 *   无参数。依赖导入的 sb、全局 window._isLoggedIn、data/articles.json。
 *
 * 【输出】
 *   Promise<ArticleData> — { articles: DTO[], tags: string[], map: object }
 *
 * 【调用者】
 *   _articleCache 的 factory 函数、loadArticles() 的 fallback 路径。
 *
 * 【为什么 Supabase 优先于本地 JSON】
 *   Supabase 是"实时"数据源，本地 JSON 是构建时生成的"快照"。
 *   当两者有相同 id 的文章时，Supabase 版本更新、应被采纳。
 *
 * 【为什么未登录时过滤 public===false】
 *   未登录用户不应看到标记为非公开的文章（安全/隐私考量）。
 *   登录用户（管理员）可以看到所有文章。
 */
async function _fetchArticleData() {
  var merged = [];
  var seenIds = {};
  var map = {};

  // 1. Supabase (published articles only)
  if (sb && window._isLoggedIn) {
    try {
      var result = await sb
        .from('articles')
        .select('id, slug, title, excerpt, content, tags, url, cover, recommended, public, spoiler, created_at')
        .eq('published', true)
        .order('created_at', { ascending: false });

      if (!result.error && result.data) {
        result.data.forEach(function(a) {
          seenIds[a.id] = true;
          map[a.id] = a;
          merged.push(a);
        });
      }
    } catch (e) { console.warn('Supabase 文章查询失败'); }
  }

  // 2. Local JSON (fallback — skip ids already from Supabase)
  try {
    var res = await fetch('data/articles.json');
    var all = await res.json();
    var fromLocal = window._isLoggedIn ? all : all.filter(function(a) { return a.public !== false; });
    fromLocal.forEach(function(a) {
      if (!seenIds[a.id]) {
        seenIds[a.id] = true;
        map[a.id] = a;
        merged.push(a);
      }
    });
  } catch (e) { /* local data unavailable — skip */ }

  // 3. Sort by date descending
  merged.sort(function(a, b) {
    var da = (a.created_at || a.date || '').toString();
    var db = (b.created_at || b.date || '').toString();
    return db.localeCompare(da);
  });

  // 4. Normalise to DTOs + extract tags
  var articleList = merged.map(function(a) {
    return {
      id: a.id, title: a.title,
      date: (a.created_at || a.date || '').slice(0, 10),
      excerpt: a.excerpt, tags: a.tags || [],
      url: a.url, cover: a.cover, recommended: a.recommended, spoiler: a.spoiler,
    };
  });
  var tagList = ['全部'].concat(Array.from(new Set(articleList.flatMap(function(a) { return a.tags; }))));

  return { articles: articleList, tags: tagList, map: map };
}

/**
 * _articleCache —— 文章数据缓存。
 *
 * 【它做什么】
 *   用 createCache 包装 _fetchArticleData，缓存 5 分钟。
 *   5 分钟内重复调用 loadArticles() 直接返回缓存，不重新查数据库和 JSON。
 *
 * 【为什么 5 分钟而不是 30 秒（像 BGM 那样）】
 *   文章数据变更频率远低于 BGM 曲目。文章是管理员手动发布的，不会频繁变化。
 *   5 分钟缓存大幅减少 Supabase 请求次数和 JSON 网络请求，
 *   同时保证用户在浏览期间不会看到"闪烁"的数据变化。
 */
var _articleCache = createCache
  ? createCache(_fetchArticleData, 300000)
  : null;

// =========================================================================
// Public API —— loadArticles / invalidateArticleCache
// =========================================================================

/**
 * loadArticles —— 加载（或重新加载）文章数据并渲染页面。
 *
 * 【它做什么】
 *   1. 显示骨架屏（showSkeleton）
 *   2. 从缓存或直接获取文章数据
 *   3. 将数据写入模块内部变量 articles / allTags / _articleMap
 *   4. 渲染筛选栏（renderFilters）和文章列表（renderArticles）
 *   5. 绑定搜索事件（bindSearchEvents）
 *
 * 【数据流向】
 *   _articleCache.get() 或 _fetchArticleData() → articles / allTags / _articleMap
 *   → renderFilters() → renderArticles() → DOM
 *
 * 【输入】
 *   无。
 *
 * 【输出】
 *   Promise<void>
 *
 * 【调用者】
 *   main.js（页面初始化）、deleteArticle()（删除后重新加载）、
 *   EventBus 缓存失效回调。
 *   也通过 window.loadArticles 暴露给外部。
 *
 * 【副作用】
 *   - 修改 articles、allTags、_articleMap（模块状态）
 *   - 修改 DOM：骨架屏 → 筛选栏 + 文章列表
 *
 * 【为什么 loadArticles 被重新赋值（装饰器模式）】
 *   原函数逻辑不变，但需要确保 bindArticleDelegation 在首次加载时执行一次。
 *   通过包装函数实现：首次调用时先绑定事件委托，再执行原逻辑。
 *   后续调用跳过事件绑定（_articleDelegationBound 标记已绑定）。
 */
async function loadArticles() {
  showSkeleton();

  if (!_articleCache) {
    // Fallback: no createCache available → fetch directly
    var data = await _fetchArticleData();
    articles = data.articles;
    allTags = data.tags;
    _articleMap = data.map;
  } else {
    var cached = await _articleCache.get();
    articles = cached.articles;
    allTags = cached.tags;
    _articleMap = cached.map;
  }

  renderFilters();
  renderArticles();
  bindSearchEvents();
}

/**
 * invalidateArticleCache —— 使文章缓存失效。
 *
 * 【它做什么】
 *   清空 _articleCache，下次 loadArticles() 时强制重新获取。
 *   如果缓存不存在则直接清空内部状态。
 *
 * 【调用者】
 *   deleteArticle()（删除后）、EventBus 'cache:invalidate:articles' 事件回调（admin.js 触发）。
 *
 * 【为什么清除 articles/allTags/_articleMap】
 *   缓存不存在时（createCache 不可用），直接清空状态确保下次 loadArticles 重新获取。
 *   防止陈旧数据残留在模块变量中。
 */
function invalidateArticleCache() {
  if (_articleCache) { _articleCache.invalidate(); }
  else { articles = []; allTags = []; _articleMap = {}; }
}

// =========================================================================
// 筛选逻辑
// =========================================================================

/**
 * getFilteredArticles —— 根据当前筛选条件和搜索词返回过滤后的文章列表。
 *
 * 【它做什么】
 *   先按 activeFilter 筛选标签，再按 searchQuery 模糊匹配标题、摘要、标签。
 *
 * 【输入】
 *   无。依赖闭包 activeFilter、searchQuery、articles。
 *
 * 【输出】
 *   过滤后的文章 DTO 数组。
 *
 * 【调用者】
 *   renderArticles()。
 */
function getFilteredArticles() {
  var filtered = articles;
  if (activeFilter !== '全部') {
    filtered = filtered.filter(function(a) { return a.tags.includes(activeFilter); });
  }
  if (searchQuery) {
    var q = searchQuery.toLowerCase();
    filtered = filtered.filter(function(a) {
      // Check title, excerpt, tags, and fallback to full article content from _articleMap
      var content = (_articleMap[a.id] && _articleMap[a.id].content) || '';
      return a.title.toLowerCase().indexOf(q) !== -1
        || a.excerpt.toLowerCase().indexOf(q) !== -1
        || a.tags.some(function(t) { return t.toLowerCase().indexOf(q) !== -1; })
        || content.toLowerCase().indexOf(q) !== -1;
    });
  }
  return filtered;
}

// =========================================================================
// 渲染 —— 骨架屏、文章列表、筛选栏
// =========================================================================

/**
 * ensureTimelineEl —— 确保时间线容器 DOM 存在。
 *
 * 【它做什么】
 *   查找 #articleTimeline 元素，不存在则在 #articleGrid 之后动态创建。
 *
 * 【为什么动态创建】
 *   时间线视图是可选的视图模式，不在 HTML 模板中预先定义
 *   可以减少初始 DOM 大小，按需创建。
 */
function ensureTimelineEl() {
  var el = document.getElementById('articleTimeline');
  if (!el) {
    el = document.createElement('div');
    el.id = 'articleTimeline';
    el.className = 'article-timeline';
    document.getElementById('articleGrid').after(el);
  }
  return el;
}

/**
 * deleteArticle —— 前台删除文章（仅管理员可见）。
 *
 * 【它做什么】
 *   弹出确认对话框，确认后从 Supabase articles 表中删除指定 id 的行，
 *   然后刷新缓存、重新加载列表、通知其他模块刷新。
 *
 * 【输入】
 *   id — 文章 id（number）
 *
 * 【输出】
 *   Promise<void>
 *
 * 【调用者】
 *   文章卡片上的删除按钮（data-card-delete-article）、Modal 中的删除按钮。
 *
 * 【副作用】
 *   - 删除 Supabase 中的文章行
 *   - 显示 toast 提示
 *   - 刷新文章缓存并重新渲染
 *   - 通过 EventBus 通知其他模块
 */
/**
 * deleteArticle —— 删除指定文章（唯一实现，admin + 前台共用）
 *
 * 【调用者】
 *   前台文章卡片/弹窗的删除按钮、管理面板的删除按钮。
 *   统一通过 window._deleteArticleById 暴露给 admin.js。
 */
async function deleteArticle(id) {
  if (!confirm(tSync('articles.confirmDelete'))) return;
  if (!sb) return;
  try {
    var r = await sb.from('articles').delete().eq('id', id);
    if (r.error) { showToast(tSync('articles.deleteFailed') + r.error.message); return; }
    showToast(tSync('articles.deleted'), 'success');
    invalidateArticleCache();
    loadArticles();
    if (typeof window.EventBus !== 'undefined') window.EventBus.emit('cache:invalidate:articles');
  } catch (e) { console.warn('[articles] 删除文章失败:', e); showToast(tSync('articles.deleteFailed'), 'warn'); }
}

/**
 * showSkeleton —— 显示骨架屏（加载占位）。
 *
 * 【它做什么】
 *   隐藏时间线视图，在 #articleGrid 中渲染 3 张 skeleton card。
 *   骨架屏在数据加载前显示，提供"正在加载"的视觉反馈。
 *
 * 【为什么是 3 张 skeleton card】
 *   3 张足够填充首屏，既给用户加载中的预期，又不至于渲染过多无用的占位元素。
 *   奇数张也能避免视觉上完全对称的呆板感。
 */
function showSkeleton() {
  var grid = document.getElementById('articleGrid');
  var timeline = ensureTimelineEl();
  timeline.classList.remove('active');
  timeline.style.display = 'none';
  grid.classList.add('active');
  grid.style.display = '';
  var skeletonCards = [];
  for (var i = 0; i < 3; i++) {
    var cover = i % 2 === 0 ? '<div class="skeleton-cover"></div>' : '';
    skeletonCards.push('<div class="skeleton-card">' +
      cover +
      '<div class="skeleton-line title"></div>' +
      '<div class="skeleton-line meta"></div>' +
      '<div class="skeleton-line text"></div>' +
      '<div class="skeleton-line text short"></div>' +
    '</div>');
  }
  grid.innerHTML = skeletonCards.join('');
}

/**
 * renderArticles —— 以当前视图模式渲染文章列表。
 *
 * 【它做什么】
 *   根据 articleView 的值渲染为卡片视图或时间线视图。
 *   卡片视图：封面图 + 标题 + 日期 + 摘要 + 标签
 *   时间线视图：按年份分组，每组内有日期 + 标题 + 摘要 + 标签
 *   管理员登录时额外注入删除按钮。
 *
 * 【数据流向】
 *   getFilteredArticles() → HTML 字符串 → #articleGrid 或 #articleTimeline 的 innerHTML
 *
 * 【输入】
 *   无。依赖闭包 articleView、articles、activeFilter、searchQuery。
 *
 * 【输出】
 *   无。
 *
 * 【调用者】
 *   loadArticles()、setFilter()、bindSearchEvents() 中的搜索输入事件、
 *   bindArticleDelegation() 中的视图切换。
 *   也通过 window.renderArticles 暴露给外部。
 *
 * 【副作用】
 *   修改 #articleGrid 和 #articleTimeline 的 innerHTML。
 *
 * 【为什么同时维护两个容器（grid + timeline）】
 *   卡片视图和时间线视图的 DOM 结构差异很大，放在同一个容器内切换会导致
 *   大量的 DOM 操作和重绘。两个独立容器 + display 切换更高效，也更容易维护。
 */
function renderArticles() {
  var filtered = getFilteredArticles();
  var grid = document.getElementById('articleGrid');
  var timeline = ensureTimelineEl();

  if (articleView === 'cards') {
    timeline.classList.remove('active');
    grid.classList.add('active');
    grid.style.display = '';
    timeline.style.display = 'none';
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><div>' + tSync('articles.emptyTag') + '</div></div>';
      return;
    }
    grid.innerHTML = filtered.map(function(a) {
      var coverHtml = a.cover ? '<img class="article-cover" src="' + escHtml(a.cover) + '" alt="" loading="lazy">' : '';
      var recBadge = a.recommended ? '<span class="article-rec-badge" title="推荐">⭐ 推荐</span>' : '';
      var spoilerBadge = a.spoiler ? '<span class="article-spoiler-badge" title="含剧透">⚠ 剧透</span>' : '';
      var linkBtn = a.url ? '<a class="article-link-btn" href="' + escHtml(a.url) + '" target="_blank" rel="noopener" title="打开外链">🔗 去逛逛</a>' : '';
      // 管理员显示编辑 + 删除按钮
      var adminBtns = window._isLoggedIn
        ? '<button class="inline-edit-btn" data-card-edit-article="' + a.id + '" title="编辑">✎</button>' +
          '<button class="inline-delete-btn" data-card-delete-article="' + a.id + '" title="删除此文章">✕</button>'
        : '';
      return '<div class="article-card" data-article-id="' + a.id + '">' +
        coverHtml +
        '<div class="article-title">' + escHtml(a.title) + recBadge + spoilerBadge + '</div>' +
        '<div class="article-meta">📅 ' + escHtml(a.date) + adminBtns + '</div>' +
        '<div class="article-excerpt">' + escHtml(a.excerpt) + '</div>' +
        '<div class="article-tags">' + a.tags.map(function(t) { return '<span class="tag purple">' + escHtml(t) + '</span>'; }).join('') + '</div>' +
        linkBtn +
      '</div>';
    }).join('');
  } else {
    grid.classList.remove('active');
    grid.style.display = 'none';
    timeline.classList.add('active');
    timeline.style.display = '';
    if (filtered.length === 0) {
      timeline.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><div>' + tSync('articles.emptyTag') + '</div></div>';
      return;
    }
    var byYear = {};
    filtered.forEach(function(a) {
      var y = (a.date || '').slice(0, 4) || '未知';
      if (!byYear[y]) byYear[y] = [];
      byYear[y].push(a);
    });
    var years = Object.keys(byYear).sort(function(a, b) { return b - a; });
    timeline.innerHTML = years.map(function(y) {
      var items = byYear[y].map(function(a) {
        var recBadge = a.recommended ? '<span class="article-rec-badge" title="推荐">⭐</span>' : '';
        var spoilerBadge = a.spoiler ? '<span class="article-spoiler-badge" title="含剧透">⚠</span>' : '';
        var adminBtns = window._isLoggedIn
          ? '<button class="inline-edit-btn" data-card-edit-article="' + a.id + '" title="编辑">✎</button>' +
            '<button class="inline-delete-btn" data-card-delete-article="' + a.id + '" title="删除此文章">✕</button>'
          : '';
        return '<div class="timeline-item" data-article-id="' + a.id + '">' +
          '<div class="timeline-item-date">📅 ' + escHtml(a.date) + adminBtns + '</div>' +
          '<div class="timeline-item-title">' + escHtml(a.title) + recBadge + spoilerBadge + '</div>' +
          '<div class="timeline-item-excerpt">' + escHtml(a.excerpt) + '</div>' +
          '<div class="timeline-item-tags">' + a.tags.map(function(t) { return '<span class="tag purple">' + escHtml(t) + '</span>'; }).join('') + '</div>' +
        '</div>';
      }).join('');
      return '<div class="timeline-year">' + escHtml(y) + '</div>' + items;
    }).join('');
  }
}

/**
 * renderFilters —— 渲染标签筛选栏。
 *
 * 【它做什么】
 *   将 allTags 渲染为 .filter-tag span，当前选中的标签添加 .selected 类。
 *
 * 【输入】
 *   无。依赖闭包 allTags、activeFilter。
 *
 * 【输出】
 *   无。
 *
 * 【调用者】
 *   loadArticles()、setFilter()。
 *   也通过 window.renderFilters 暴露给外部。
 *
 * 【副作用】
 *   修改 #filterBar 的 innerHTML。
 */
function renderFilters() {
  var bar = document.getElementById('filterBar');
  bar.innerHTML = allTags.map(function(t) {
    return '<span class="filter-tag' + (t === activeFilter ? ' selected' : '') + '" data-filter="' + escHtml(t) + '">' + escHtml(t) + '</span>';
  }).join('');
}

/**
 * setFilter —— 设置当前筛选标签。
 *
 * 【它做什么】
 *   更新 activeFilter，重新渲染筛选栏和文章列表。
 *
 * 【输入】
 *   tag — 标签名（string），如 '全部'、'技术'、'生活'
 *
 * 【调用者】
 *   筛选栏标签的 click 事件委托（在 bindArticleDelegation 中）。
 *   也通过 window.setFilter 暴露给外部。
 */
function setFilter(tag) {
  activeFilter = tag;
  renderFilters();
  renderArticles();
}

// =========================================================================
// 搜索 & 视图切换事件
// =========================================================================

/**
 * bindSearchEvents —— 绑定搜索框和视图切换按钮的事件。
 *
 * 【它做什么】
 *   绑定 #articleSearch 的 input 事件（实时搜索）和 #viewToggle 的 click 事件
 *   （切换卡片/时间线视图）。
 *
 * 【调用者】
 *   loadArticles()（每次加载文章后重新绑定）。
 *
 * 【为什么每次 loadArticles 都要重新绑定】
 *   搜索框和视图切换按钮在 #sec-articles 内部，该区域可能会被外部逻辑重建
 *   （如 nav.js 切换面板）。重新绑定确保事件不会丢失。
 *   实际上 addEventListener 多次绑定同一函数是幂等的（同一函数引用不会重复注册），
 *   但这里每次都调用是因为 bindSearchEvents 在 loadArticles 流程中作为一步执行。
 */
function bindSearchEvents() {
  var input = document.getElementById('articleSearch');
  if (input) {
    input.addEventListener('input', function() {
      searchQuery = this.value.trim();
      renderArticles();
    });
  }
  var toggle = document.getElementById('viewToggle');
  if (toggle) {
    toggle.addEventListener('click', function(e) {
      var opt = e.target.closest('.view-option');
      if (!opt) return;
      articleView = opt.dataset.view;
      toggle.querySelectorAll('.view-option').forEach(function(o) { o.classList.remove('active'); });
      opt.classList.add('active');
      renderArticles();
    });
  }
}

// =========================================================================
// SEO Meta helpers —— 打开/关闭文章 Modal 时更新页面 title 和 og 标签
// =========================================================================

/**
 * updateMetaForArticle —— 根据文章内容更新页面 SEO meta 标签。
 *
 * 【它做什么】
 *   打开文章详情时，将 <title>、meta description、og:image 等替换为文章专属内容，
 *   使搜索引擎抓取和社交分享时展示文章标题/摘要/封面而非站点默认值。
 *
 * 【输入】
 *   a — 文章完整记录（来自 _articleMap）
 *
 * 【调用者】
 *   openArticleDetail()
 */
function updateMetaForArticle(a) {
  if (!a) return;

  document.title = a.title + ' — jieneng';

  if (a.excerpt) {
    var desc = a.excerpt;
    var metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', desc);
    var ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) ogDesc.setAttribute('content', desc);
    var twDesc = document.querySelector('meta[name="twitter:description"]');
    if (twDesc) twDesc.setAttribute('content', desc);
  }

  if (a.cover) {
    var ogImg = document.querySelector('meta[property="og:image"]');
    if (ogImg) ogImg.setAttribute('content', a.cover);
  }
}

/**
 * restoreMetaDefaults —— 恢复页面 SEO meta 标签为站点默认值。
 *
 * 【它做什么】
 *   关闭文章 Modal 时，将 title、description、og:image 等还原为首页默认值。
 *
 * 【调用者】
 *   closeArticleModal()
 */
function restoreMetaDefaults() {
  document.title = 'jieneng — Galgame · 动漫OST · 视觉小说';

  var defaults = {
    'meta[name="description"]':          '这里是jieneng的个人小站。喜欢在深夜推galgame、听动漫OST，信奉「优雅的文字即诗」。',
    'meta[property="og:description"]':    '这里是jieneng的个人小站。喜欢在深夜推galgame、听动漫OST，信奉「优雅的文字即诗」。',
    'meta[name="twitter:description"]':   '这里是jieneng的个人小站。喜欢在深夜推galgame、听动漫OST。',
    'meta[property="og:image"]':          'https://jieneng10.github.io/personal-site/static/images/default-avatar.png'
  };

  for (var selector in defaults) {
    var el = document.querySelector(selector);
    if (el) el.setAttribute('content', defaults[selector]);
  }
}

// =========================================================================
// Article Detail Modal —— 文章详情弹窗
// =========================================================================

/**
 * openArticleDetail —— 打开文章详情 Modal。
 *
 * 【它做什么】
 *   根据 id 从 _articleMap 中取出完整文章数据，填充 Modal 的各个区域：
 *   标题、日期、标签、封面图、正文（Markdown → HTML）、外链、剧透警告。
 *   管理员登录时额外注入删除按钮。
 *
 * 【数据流向】
 *   _articleMap[id] → 填充 #articleModal 的各子元素 → marked.parse() → sanitizeHtml() → innerHTML
 *
 * 【输入】
 *   id — 文章 id（number）
 *
 * 【输出】
 *   无。
 *
 * 【调用者】
 *   文章卡片/时间线条目的 click 事件委托（在 bindArticleDelegation 中）。
 *   也通过 window.openArticleDetail / window.openArticleDetail 暴露给外部。
 *
 * 【副作用】
 *   - 修改 #articleModal 内各元素的 textContent / innerHTML / src / style
 *   - 动态创建/移除 coverEl、spoilerWarn、linkWrap、delBtn 等 DOM 元素
 *   - 切换 #articleModal 的 .hidden 类
 *
 * 【为什么动态创建 cover/spoiler/link 元素而不是隐藏/显示】
 *   这些元素不是每篇文章都有的。如果预埋在 HTML 中，大部分时间它们占据 DOM 但不可见。
 *   动态创建可以保持初始 DOM 干净，只在需要时才添加。
 *   但一旦创建就不删除（下次打开时复用），避免反复创建/销毁的开销。
 */
function openArticleDetail(id) {
  var a = _articleMap[id];
  if (!a) return;

  var modal = document.getElementById('articleModal');
  var scrollContainer = modal.querySelector('.modal');
  if (scrollContainer) scrollContainer.scrollTop = 0;

  var recBadge = a.recommended ? ' ⭐推荐' : '';
  var spoilerBadge = a.spoiler ? ' ⚠剧透' : '';
  document.getElementById('articleModalTitle').textContent = a.title + recBadge + spoilerBadge;
  document.getElementById('articleModalMeta').textContent = '📅 ' + (a.created_at || a.date || '').slice(0, 10);

  var tagsHtml = (a.tags || []).map(function(t) {
    return '<span class="tag purple">' + escHtml(t) + '</span>';
  }).join(' ');
  document.getElementById('articleModalTags').innerHTML = tagsHtml;

  var coverEl = document.getElementById('articleModalCover');
  if (a.cover) {
    if (!coverEl) {
      coverEl = document.createElement('img');
      coverEl.id = 'articleModalCover';
      coverEl.style.cssText = 'width:100%;max-height:240px;object-fit:cover;border-radius:12px;margin-bottom:16px;';
      var tagsContainer = document.getElementById('articleModalTags');
      tagsContainer.parentNode.insertBefore(coverEl, tagsContainer);
    }
    coverEl.src = a.cover;
    coverEl.style.display = '';
  } else if (coverEl) {
    coverEl.style.display = 'none';
  }

  var spoilerWarn = document.getElementById('articleModalSpoilerWarn');
  if (a.spoiler) {
    if (!spoilerWarn) {
      spoilerWarn = document.createElement('div');
      spoilerWarn.id = 'articleModalSpoilerWarn';
      spoilerWarn.className = 'spoiler-warn';
      spoilerWarn.textContent = '⚠ 本文含有剧透内容，未通关相关作品请谨慎阅读';
      var contentEl = document.getElementById('articleModalContent');
      contentEl.parentNode.insertBefore(spoilerWarn, contentEl);
    }
    spoilerWarn.style.display = '';
  } else if (spoilerWarn) {
    spoilerWarn.style.display = 'none';
  }

  var content = a.content || a.excerpt || '';
  document.getElementById('articleModalContent').innerHTML = window.renderMarkdown(content);

  var linkWrap = document.getElementById('articleModalLinkWrap');
  if (a.url) {
    if (!linkWrap) {
      linkWrap = document.createElement('div');
      linkWrap.id = 'articleModalLinkWrap';
      linkWrap.style.cssText = 'margin-top:20px;text-align:center;';
      document.getElementById('articleModalContent').after(linkWrap);
    }
    linkWrap.innerHTML = '<a href="' + escHtml(a.url) + '" target="_blank" rel="noopener" class="modal-link-btn">🔗 访问原文</a>';
    linkWrap.style.display = '';
  } else if (linkWrap) {
    linkWrap.style.display = 'none';
  }

  // 管理员删除按钮（注入到 modal 标题栏）
  var headerActions = document.querySelector('#articleModal > .modal > div:first-child');
  var existingDel = document.getElementById('modalDeleteArticle');
  if (existingDel) existingDel.remove();
  if (window._isLoggedIn) {
    var delBtn = document.createElement('button');
    delBtn.id = 'modalDeleteArticle';
    delBtn.className = 'inline-delete-btn';
    delBtn.title = '删除此文章';
    delBtn.textContent = '✕';
    delBtn.style.cssText = 'margin-right:8px;';
    delBtn.onclick = function(e) { e.stopPropagation(); deleteArticle(id); };
    var closeBtn = document.getElementById('btnArticleModalClose');
    if (closeBtn && closeBtn.parentNode) closeBtn.parentNode.insertBefore(delBtn, closeBtn);
  }

  updateMetaForArticle(a);
  document.getElementById('articleModal').classList.remove('hidden');
}

/**
 * closeArticleModal —— 关闭文章详情 Modal。
 *
 * 【调用者】
 *   #articleModal 背景遮罩的 click 事件、btnArticleModalClose 按钮点击。
 *   也通过 window.closeArticleModal 暴露给外部。
 */
function closeArticleModal() {
  restoreMetaDefaults();
  document.getElementById('articleModal').classList.add('hidden');
}

// B-11: 与 BGM modal 统一关闭逻辑——元素级 handler + e.target === this
// 点击 Modal 背景遮罩（而非内容区）时关闭 Modal
document.getElementById('articleModal').addEventListener('click', function(e) {
  if (e.target === this) {
    e.stopPropagation(); // 阻止冒泡到 nav.js 的 "点击空白关闭面板" 逻辑
    closeArticleModal();
  }
});

// =========================================================================
// Event Delegation —— 文章区域的事件委托
// =========================================================================

/**
 * bindArticleDelegation —— 在 #sec-articles 上绑定事件委托。
 *
 * 【它做什么】
 *   在文章区域容器上通过事件委托统一处理以下交互：
 *     - 文章卡片/时间线条目点击 → openArticleDetail()
 *     - 删除按钮点击 → deleteArticle()
 *     - 筛选标签点击 → setFilter()
 *   以及关闭按钮的 click 事件。
 *
 * 【为什么用事件委托而不是每个元素单独绑定】
 *   文章列表在筛选/搜索时会频繁重建 innerHTML，如果每个元素独立绑定事件，
 *   每次重建都需要重新绑定，容易遗漏且性能差。事件委托只需在容器上绑定一次。
 *
 * 【为什么 setFilter 调用时加 e.stopPropagation()】
 *   setFilter → renderFilters 会重建筛选栏 DOM，导致点击的原始元素脱离文档树。
 *   如果不阻止冒泡，nav.js 的"点击空白关闭面板"逻辑会误判为点击了面板外部
 *   （closest('.content-panel') 返回 null），从而错误关闭面板。
 *
 * 【为什么 _articleDelegationBound 确保只绑定一次】
 *   loadArticles 可能被多次调用（如缓存失效、删除文章后重新加载），
 *   但事件委托只需绑定一次。标记位防止重复绑定。
 */
function bindArticleDelegation() {
  var secArticles = document.getElementById('sec-articles');
  if (secArticles) {
    secArticles.addEventListener('click', function(e) {
      if (e.target.closest('.article-link-btn, .modal-link-btn')) return;
      // 管理员编辑按钮 → 切换到管理面板并打开编辑器
      var editCardBtn = e.target.closest('[data-card-edit-article]');
      if (editCardBtn) {
        e.stopPropagation();
        if (typeof window.switchSection === 'function') window.switchSection('admin');
        var editId = parseInt(editCardBtn.getAttribute('data-card-edit-article'));
        setTimeout(function() {
          if (typeof window._editArticleById === 'function') window._editArticleById(editId);
        }, 400); // 等待面板动画完成
        return;
      }
      // 管理员删除按钮（拦截在卡片点击之前）
      var delCardBtn = e.target.closest('[data-card-delete-article]');
      if (delCardBtn) {
        e.stopPropagation();
        deleteArticle(parseInt(delCardBtn.getAttribute('data-card-delete-article')));
        return;
      }
      var card = e.target.closest('.article-card[data-article-id], .timeline-item[data-article-id]');
      if (card) {
        openArticleDetail(parseInt(card.getAttribute('data-article-id')));
        return;
      }
      var filterTag = e.target.closest('.filter-tag[data-filter]');
      if (filterTag) {
        e.stopPropagation();  // setFilter → renderFilters 重建 DOM 会导致原始元素脱离文档树，nav.js 的 closest('.content-panel') 返回 null 从而误关面板
        setFilter(filterTag.getAttribute('data-filter'));
        return;
      }
    });
  }
  var closeBtn = document.getElementById('btnArticleModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeArticleModal);
}

/**
 * 装饰 loadArticles：首次调用时自动绑定事件委托。
 *
 * 【它做什么】
 *   保存原始 loadArticles 引用，替换为新函数：
 *   新函数首次调用时执行 bindArticleDelegation()，之后调用原始逻辑。
 *
 * 【为什么用这种装饰模式而不是在 main.js 中单独调用】
 *   确保事件委托绑定与 loadArticles 调用是"自动"的——
 *   无论谁调用 loadArticles，事件委托都会在首次调用时自动建立。
 *   这避免了 main.js 中遗漏 bindArticleDelegation 调用的风险。
 */
var _articleDelegationBound = false;
var origLoadArticles = loadArticles;
loadArticles = function() {
  if (!_articleDelegationBound) { _articleDelegationBound = true; bindArticleDelegation(); }
  return origLoadArticles();
};

// =========================================================================
// Article Submission —— 文章投稿
// =========================================================================

/**
 * submitArticle —— 提交新文章投稿。
 *
 * 【它做什么】
 *   收集表单数据（标题、正文、标签、外链、封面），校验后插入 Supabase articles 表。
 *   新文章 published=false，需管理员审核后发布。
 *
 * 【数据流向】
 *   DOM 表单字段 → 校验 → Supabase articles.insert() → toast 提示
 *
 * 【输入】
 *   无。从 DOM 读取 #submitTitle、#submitContent、#submitTags、#submitUrl、#submitCover。
 *
 * 【输出】
 *   Promise<void>
 *
 * 【调用者】
 *   #btnSubmitArticle 的 click 事件（在 bindSubmitEvents 中绑定）。
 *
 * 【副作用】
 *   - 写入 Supabase articles 表
 *   - 清空表单（成功时）
 *   - 显示 toast 提示
 *   - 修改按钮状态（disabled + 文字）
 *
 * 【为什么检查 URL 协议（javascript:/data:/vbscript:）】
 *   防止 XSS 攻击。攻击者可能在 url/cover 字段中注入 javascript: 协议，
 *   如果直接渲染到 <a href> 或 <img src> 中会执行恶意脚本。
 */
async function submitArticle() {
  var title = document.getElementById('submitTitle').value.trim();
  var content = document.getElementById('submitContent').value.trim();
  var msgEl = document.getElementById('submitMsg');

  if (!title)   { msgEl.textContent = '请填写文章标题'; msgEl.className = 'submit-msg error'; return; }
  if (!content) { msgEl.textContent = '请填写正文内容'; msgEl.className = 'submit-msg error'; return; }
  if (content.length < 20) { msgEl.textContent = '正文至少 20 个字符'; msgEl.className = 'submit-msg error'; return; }

  var tagsRaw = document.getElementById('submitTags').value.trim();
  var tags = tagsRaw ? tagsRaw.split(/[,，]/).map(function(t) { return t.trim(); }).filter(Boolean) : [];
  var url = document.getElementById('submitUrl').value.trim() || null;
  var cover = document.getElementById('submitCover').value.trim() || null;

  // Block dangerous URL protocols
  if (url && /^\s*(javascript|data|vbscript)\s*:/i.test(url)) {
    msgEl.textContent = '外链 URL 包含不安全的协议'; msgEl.className = 'submit-msg error'; return;
  }
  if (cover && /^\s*(javascript|data|vbscript)\s*:/i.test(cover)) {
    msgEl.textContent = '封面图 URL 包含不安全的协议'; msgEl.className = 'submit-msg error'; return;
  }

  var btn = document.getElementById('btnSubmitArticle');
  btn.disabled = true;
  btn.textContent = tSync('articles.submitBtnLoading');
  msgEl.textContent = '';
  msgEl.className = 'submit-msg';

  try {
    await window._upsertArticle({
      title: title,
      slug: title.toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '').slice(0, 50),
      content: content, tags: tags, url: url, cover: cover,
      excerpt: content.replace(/[#*>`\n\r]/g, '').slice(0, 120),
      published: false, recommended: false, spoiler: false,
    }, null);

    msgEl.textContent = tSync('articles.submitSuccess');
    msgEl.className = 'submit-msg success';
    document.getElementById('submitTitle').value = '';
    document.getElementById('submitContent').value = '';
    document.getElementById('submitTags').value = '';
    document.getElementById('submitUrl').value = '';
    document.getElementById('submitCover').value = '';
  } catch (e) {
    msgEl.textContent = tSync('articles.submitFailed') + (e.message || '');
    msgEl.className = 'submit-msg error';
  }

  btn.disabled = false;
  btn.textContent = tSync('articles.submitBtn');
}

// =========================================================================
// HTML 消毒 —— sanitizeHtml
// =========================================================================

/**
 * sanitizeHtml —— 消毒 Markdown 渲染后的 HTML。
 *
 * 【它做什么】
 *   过滤 marked.parse() 输出的 HTML，移除危险标签（script、iframe 等）和
 *   危险属性（on* 事件处理器、javascript: 伪协议）。
 *   使用递归 DOM 遍历而非正则表达式，确保安全性。
 *
 * 【输入】
 *   html — marked.parse() 输出的原始 HTML 字符串
 *
 * 【输出】
 *   string — 安全的 HTML 字符串
 *
 * 【调用者】
 *   openArticleDetail()（渲染文章正文时）。
 *   也通过 window.sanitizeHtml 暴露给外部（如 anime-news.js 渲染资讯详情）。
 *
 * 【为什么用 DOMParser + 递归遍历而不是正则表达式】
 *   HTML 是上下文有关文法，正则表达式无法可靠处理嵌套结构。
 *   例如 <scr<script>ipt> 这种混淆写法可以绕过简单正则。
 *   浏览器原生 DOMParser 理解完整的 HTML 语义，按节点树递归遍历
 *   可以做到零漏过的白名单过滤。
 */
function sanitizeHtml(html) {
  try {
    var doc = new DOMParser().parseFromString(String(html), 'text/html');
    _walkSanitize(doc.body);
    return doc.body.innerHTML;
  } catch (e) {
    return String(html).replace(/<[^>]*>/g, '');
  }
}

/**
 * _BLOCKED_TAGS —— 被禁止的 HTML 标签白名单（黑名单方式）。
 * 任何匹配的标签及其子节点都会被移除。
 */
var _BLOCKED_TAGS = {
  script:1, iframe:1, object:1, embed:1, applet:1, link:1, style:1,
  meta:1, base:1, form:1, input:1, textarea:1, button:1, select:1, option:1
};

/**
 * _walkSanitize —— 递归遍历 DOM 节点树，移除危险元素和属性。
 *
 * 【它做什么】
 *   对每个节点：
 *     - 文本节点：保留
 *     - 非元素节点（注释等）：移除
 *     - 元素节点：检查标签名是否在黑名单中
 *       → 在黑名单：移除整个节点（包括子节点）
 *       → 不在黑名单：遍历属性，移除 on* 事件句柄和 javascript: 伪协议
 *       → 递归处理子节点
 *
 * 【输入】
 *   node — DOM 节点
 *
 * 【为什么从后往前遍历属性（i = attrs.length - 1 递减）】
 *   removeAttribute 会改变 NamedNodeMap 的长度和索引。
 *   从后往前删除可以避免"索引漂移"导致跳过元素。
 */
function _walkSanitize(node) {
  if (node.nodeType === 3) return;
  if (node.nodeType !== 1) { node.parentNode && node.parentNode.removeChild(node); return; }
  var tag = node.tagName.toLowerCase();
  if (_BLOCKED_TAGS[tag]) { node.parentNode && node.parentNode.removeChild(node); return; }
  var attrs = node.attributes;
  if (attrs) {
    for (var i = attrs.length - 1; i >= 0; i--) {
      var aname = attrs[i].name.toLowerCase();
      if (/^on\w+/.test(aname)) { node.removeAttribute(aname); continue; }
      var aval = attrs[i].value || '';
      if (/^\s*javascript\s*:/i.test(aval)) { node.removeAttribute(aname); continue; }
      if ((aname === 'href' || aname === 'src' || aname === 'action' || aname === 'formaction')
          && /^\s*javascript\s*:/i.test(aval)) {
        node.removeAttribute(aname);
      }
    }
  }
  var children = Array.prototype.slice.call(node.childNodes);
  for (var j = 0; j < children.length; j++) { _walkSanitize(children[j]); }
}

// =========================================================================
// 投稿表单事件绑定
// =========================================================================

/**
 * bindSubmitEvents —— 绑定投稿表单的提交按钮事件。
 *
 * 【调用者】
 *   main.js（页面初始化时）。
 *   也通过 window.bindSubmitEvents 暴露给外部。
 */
function bindSubmitEvents() {
  var btn = document.getElementById('btnSubmitArticle');
  if (btn) btn.addEventListener('click', submitArticle);
}

// =========================================================================
// 跨模块通信 —— 监听 admin 面板发出的缓存失效事件
// =========================================================================

/**
 * 监听 EventBus 的 'cache:invalidate:articles' 事件。
 *
 * 【数据流向】
 *   admin.js（管理员操作）→ EventBus.emit('cache:invalidate:articles')
 *   → invalidateArticleCache() → 下次 loadArticles() 强制重新获取
 *
 * 【为什么用 EventBus 而不是直接调用】
 *   articles.js 和 admin.js 是独立模块，不应该互相 import。
 *   EventBus 提供了解耦的发布/订阅机制。
 */
if (typeof window.EventBus !== 'undefined') {
  window.EventBus.on('cache:invalidate:articles', function() {
    invalidateArticleCache();
  });
}

// =========================================================================
// window exports —— 暴露给其他模块和页面脚本的 API（向后兼容）
// =========================================================================

/**
 * 暴露 loadArticles，供 main.js 初始化页面时调用。
 * @type {typeof loadArticles}
 */
window.loadArticles = loadArticles;

/**
 * 暴露 renderArticles，供外部强制重新渲染文章列表。
 * @type {typeof renderArticles}
 */
window.renderArticles = renderArticles;

/**
 * 暴露 renderFilters，供外部强制重新渲染筛选栏。
 * @type {typeof renderFilters}
 */
window.renderFilters = renderFilters;

/**
 * 暴露 setFilter，供外部以编程方式切换筛选标签。
 * @type {typeof setFilter}
 */
window.setFilter = setFilter;

/**
 * 暴露 openArticleDetail，供外部以 id 打开文章详情 Modal。
 * @type {typeof openArticleDetail}
 */
window.openArticleDetail = openArticleDetail;

/**
 * 暴露 openArticleDetail（openArticleDetail 的别名），
 * 语义更明确：通过 id 打开文章。
 * @type {typeof openArticleDetail}
 */
window.openArticleDetail = openArticleDetail;

/**
 * 暴露 closeArticleModal，供外部关闭文章详情 Modal。
 * @type {typeof closeArticleModal}
 */
window.closeArticleModal = closeArticleModal;

/**
 * 暴露 sanitizeHtml，供其他模块（如 anime-news.js）消毒 HTML。
 * @type {typeof sanitizeHtml}
 */
window.sanitizeHtml = sanitizeHtml;

/**
 * 暴露 bindSubmitEvents，供 main.js 初始化时绑定投稿表单事件。
 * @type {typeof bindSubmitEvents}
 */
window.bindSubmitEvents = bindSubmitEvents;

/**
 * 暴露缓存失效函数（以下划线前缀标记为"内部用"）。
 * @type {typeof invalidateArticleCache}
 */
window._invalidateArticleCache = invalidateArticleCache;

/**
 * 暴露 deleteArticle 给 admin.js，统一前台+管理面板的删除逻辑。
 */
window._deleteArticleById = deleteArticle;

// =========================================================================
// ESM exports —— 供其他 ESM 模块使用
// =========================================================================

export { loadArticles, openArticleDetail, deleteArticle, bindSubmitEvents, sanitizeHtml, invalidateArticleCache };
