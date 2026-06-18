/**
 * nav.js — 页面导航与面板管理模块
 *
 * 【这是什么】
 *   个人站点核心导航模块，负责：section 之间的切换管理（switchSection）、
 *   内容面板（contentPanel）和新闻侧栏（newsSidebar）的打开/关闭/状态维护、
 *   URL hash 同步（支持浏览器前进后退和直接链接分享）、滑动手势关闭面板（移动端）、
 *   更多菜单（BGM/全屏/登录）交互、以及面板滚动位置保持。
 *
 * 【数据流向概览】
 *   用户点击侧边栏/底部栏 .side-nav-item
 *     → switchSection(name) 判断是否为 news（特殊处理）
 *       → 普通 section：更新 currentSection → 切换 .panel-section.active → 更新面板标题 → openPanel
 *       → news：先 closePanel（普通面板）→ 再 openNewsPanel（资讯面板）
 *     → 同步 URL hash（history.replaceState）
 *   浏览器前进/后退 → hashchange 事件 → restoreFromHash() → switchSection(name, silent=true)
 *
 *   面板滚动位置 → _panelScrollPositions[section] → 切换时保存/恢复
 *
 * 【与 window 全局变量的关系】
 *   - 读取：window.openNewsPanel、window.closeNewsPanel、window.openArticleById、
 *          window.renderBGMPlaylist、window.handleLockBtnClick、window.EventBus、
 *          window.innerWidth（桌面/移动端判断）
 *   - 写入：window.bindNavEvents、window.restoreFromHash、window.switchSection、
 *          window.onNewsPanelOpened、window.onNewsPanelClosed、
 *          window._panelScrollPositions
 *
 * 【调用链】
 *   入口：app.js 在 DOMContentLoaded 时调用 bindNavEvents() 绑定所有导航事件。
 *   运行时：
 *   - 用户点击 nav item → switchSection → 操控 DOM + URL hash
 *   - Escape 键 / 点击关闭按钮 / 点击面板外空白 → closePanel
 *   - 浏览器后退 → hashchange → restoreFromHash → switchSection
 *   - anime-news.js 通过 EventBus 通知面板状态 → onNewsPanelOpened / onNewsPanelClosed
 *
 * 【关键设计决策】
 *   - news 面板与 contentPanel 互斥：同一时间最多一个面板打开
 *   - 滚动位置按 section 独立保存：切换时保存当前、恢复目标，避免每次打开都从顶部开始
 *   - silent 参数：恢复 URL hash 时传入 true，避免 replaceState 产生额外的历史条目
 *   - 移动端面板始终显示（类 bottom sheet），桌面端点击空白区关闭
 */
// ============================================================================
// 模块级状态变量
// ============================================================================

/** 当前激活的 section 名称（'home' / 'articles' / 'cloud' / 'settings' / ...） */
var currentSection = 'home';

/** 内容面板（contentPanel）是否处于打开状态 */
var panelOpen = true;

/** 新闻侧栏面板是否处于打开状态 */
var newsPanelOpen = false;

// ============================================================================
// section → 面板标题映射表
// ============================================================================
var sectionTitles = {
  home: '🏠 首页',
  articles: '📝 文章',
  news: '📡 资讯',
  cloud: '📁 文件',
  submit: '✉️ 投稿',
  comments: '💬 留言',
  settings: '⚙ 设置',
  admin: '⚙ 管理',
  auth: '🔒 登录',
};

// ============================================================================
// 有效的 section hash 值白名单
// ============================================================================

/**
 * VALID_SECTIONS — 合法的 URL hash section 值集合
 *
 * 【为什么需要白名单】
 *   restoreFromHash 从 URL 读取 hash 并调用 switchSection。
 *   如果用户手动修改 URL 为任意值（如 #malware），switchSection 会忽略它
 *   （因为 sectionTitles 中不存在），但恢复逻辑需要一个显式白名单来快速过滤。
 *   这是防御性编程——防止 URL 中的意外值触发不必要的 DOM 查询。
 */
var VALID_SECTIONS = ['home', 'articles', 'news', 'cloud', 'submit', 'comments', 'settings', 'admin', 'auth'];

// ============================================================================
// 面板滚动位置保持 — 切换 section 时记住各面板的滚动位置
// ============================================================================

/**
 * _panelScrollPositions — 各 section 面板的滚动位置缓存
 *
 * 【数据结构】
 *   { 'home': 0, 'articles': 420, 'cloud': 0, ... }
 *   键为 section 名称，值为 panelBody 的 scrollTop 数值。
 *
 * 【为什么需要这个】
 *   用户可能会在文章列表滚动到一半时切换到首页，再切回来。
 *   如果不保存滚动位置，每次切换都会回到顶部，体验很差。
 *   closePanel / switchSection 会在离开当前 section 时保存 scrollTop，
 *   openPanel 会在进入目标 section 时恢复。
 *
 * 【暴露给 window】
 *   通过 window._panelScrollPositions 暴露，以便其他模块（如 articles.js）
 *   在特定操作后重置某个面板的滚动位置。
 */
var _panelScrollPositions = {};

// ============================================================================
// switchSection — 核心导航切换函数
// ============================================================================

/**
 * switchSection — 切换到指定的 section 并打开对应的面板
 *
 * 【它做什么】
 *   这是整个导航系统的最核心函数。根据目标 section 类型分两路处理：
 *
 *   A) news（新闻面板）——特殊路径：
 *      保存当前面板滚动位置 → 关闭 contentPanel → 调用 window.openNewsPanel()
 *      → 高亮 news nav item → 更新 URL hash
 *
 *   B) 其他普通 section：
 *      保存当前面板滚动位置（如果 contentPanel 开着且当前不是 news）
 *      → 如果 newsPanel 开着先关闭它
 *      → 切换 .panel-section 的 active 状态
 *      → 高亮对应 nav item
 *      → 更新面板标题 → openPanel → 恢复该 section 的滚动位置
 *      → 更新 URL hash
 *
 * 【为什么 news 是特殊路径】
 *   news 不使用 contentPanel，而是使用独立的 newsSidebar。
 *   两者互斥——打开 news 时必须关闭 contentPanel，反之亦然。
 *   这避免了两个面板同时铺在屏幕上造成 UI 混乱。
 *
 * 【输入】
 *   name  — String，目标 section 名称（'home' / 'articles' / 'news' / 'cloud' / 'settings' / ...）
 *   silent — Boolean（可选），true 时静默切换：不通过 replaceState 写入 URL hash。
 *           用于从 hash 恢复状态时避免重复写入历史记录。
 *
 * 【输出】无
 *
 * 【副作用】
 *   - 修改 currentSection 全局状态
 *   - 切换 .panel-section 的 CSS class
 *   - 切换 .side-nav-item 的 active 状态和 aria-selected 属性
 *   - 修改 #panelTitle 文本
 *   - 调用 openPanel / closePanel / openNewsPanel / closeNewsPanel
 *   - 写入/读取 _panelScrollPositions
 *   - 修改 URL hash（通过 history.replaceState）
 *
 * 【调用者】
 *   - bindNavEvents 中侧边栏点击事件
 *   - restoreFromHash（从 hash 恢复状态）
 *   - settings.js 中 sbLogin 成功后跳转到 'home'
 *   - 其他模块通过 window.switchSection 调用
 */
function switchSection(name, silent) {
  // 如果 name 不在 sectionTitles 中，直接忽略（防御未知 section）
  if (!sectionTitles[name]) return;

  // ---- 新闻面板特殊处理 ----
  if (name === 'news') {
    // 如果内容面板打开，先保存当前面板的滚动位置
    if (panelOpen) {
      _panelScrollPositions[currentSection] = document.getElementById('panelBody').scrollTop || 0;
    }
    // 关闭普通内容面板（news 使用独立的新闻侧栏）
    if (panelOpen) closePanel();
    // 打开新闻面板（由 anime-news.js 实现）
    if (typeof window.openNewsPanel === 'function') {
      window.openNewsPanel();
    }
    // 高亮侧边栏中的「资讯」tab
    document.querySelectorAll('.side-nav-item').forEach(function(n) {
      var isActive = n.dataset.section === 'news';
      n.classList.toggle('active', isActive);
      n.setAttribute('aria-selected', String(isActive));
    });
    currentSection = 'news';
    // 同步 URL hash（silent 模式下跳过，避免在恢复时产生多余的浏览器历史）
    var hash = '#news';
    if (window.location.hash !== hash && !silent) {
      try { history.replaceState(null, '', hash); } catch (e) {}
    }
    return;
  }

  // ---- 普通 section 切换 ----
  // 保存当前面板的滚动位置（如果面板开着且当前不是 news）
  if (panelOpen && currentSection && currentSection !== 'news') {
    _panelScrollPositions[currentSection] = document.getElementById('panelBody').scrollTop || 0;
  }

  // 如果新闻面板打开，先关闭（contentPanel 和 newsSidebar 互斥）
  if (newsPanelOpen && typeof window.closeNewsPanel === 'function') {
    window.closeNewsPanel();
  }

  // 更新当前 section 状态
  currentSection = name;

  // 切换面板内容区域：隐藏所有 .panel-section，激活目标 section
  document.querySelectorAll('.panel-section').forEach(function(s) { s.classList.remove('active'); });
  var secEl = document.getElementById('sec-' + name);
  if (secEl) secEl.classList.add('active');

  // 高亮侧边栏中对应的导航项 + 设置 aria-selected 无障碍属性
  document.querySelectorAll('.side-nav-item').forEach(function(n) {
    var isActive = n.dataset.section === name;
    n.classList.toggle('active', isActive);
    n.setAttribute('aria-selected', String(isActive));
  });

  // 更新面板标题
  document.getElementById('panelTitle').textContent = sectionTitles[name] || name;

  // 打开面板
  openPanel();

  // 恢复该 section 之前保存的滚动位置
  var savedScroll = _panelScrollPositions[name];
  var panelBody = document.getElementById('panelBody');
  panelBody.scrollTop = savedScroll || 0;

  // 同步 URL hash（silent 模式下跳过）
  var hash = '#' + name;
  if (window.location.hash !== hash && !silent) {
    try {
      history.replaceState(null, '', hash);
    } catch (e) { /* ignore */ }
  }
}

// ============================================================================
// 面板打开/关闭
// ============================================================================

/**
 * openPanel — 打开内容面板
 *
 * 【它做什么】
 *   给 #contentPanel 添加 .open class，触发 CSS transition 动画展开面板。
 *   设置 panelOpen = true。
 *
 * 【为什么用 CSS class 而不是直接操作 style】
 *   CSS class 切换配合 CSS transition 可以产生平滑的展开/收起动画，
 *   直接操作 style 难以实现同样的效果且更难维护。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】修改 panelOpen 标志、修改 DOM class
 * 【调用者】switchSection
 */
function openPanel() {
  panelOpen = true;
  document.getElementById('contentPanel').classList.add('open');
}

/**
 * closePanel — 关闭内容面板
 *
 * 【它做什么】
 *   保存当前面板的滚动位置，移除 #contentPanel 的 .open class，
 *   清除所有 nav item 的高亮状态，并清除 URL hash。
 *
 * 【输入】无
 * 【输出】无
 *
 * 【副作用】
 *   - 修改 panelOpen 标志
 *   - 保存 _panelScrollPositions
 *   - 修改 #contentPanel class
 *   - 清除所有 .side-nav-item 的高亮
 *   - 清除 URL hash
 *
 * 【调用者】
 *   - switchSection（切换 section 时隐式关闭）
 *   - Escape 键处理
 *   - 侧边栏点击（当前 section 重复点击时 toggle 关闭）
 *   - 桌面端点击面板外空白区域
 *   - #panelClose 关闭按钮
 *   - onNewsPanelOpened（打开新闻面板时关闭内容面板）
 *   - 滑动手势回调
 */
function closePanel() {
  panelOpen = false;
  // 保存当前面板滚动位置
  if (currentSection && currentSection !== 'news') {
    _panelScrollPositions[currentSection] = document.getElementById('panelBody').scrollTop || 0;
  }
  document.getElementById('contentPanel').classList.remove('open');

  // 清除所有导航项的高亮
  document.querySelectorAll('.side-nav-item').forEach(function(n) {
    n.classList.remove('active');
    n.setAttribute('aria-selected', 'false');
  });

  // 清除 URL hash（面板关闭后 URL 应回归干净状态）
  if (window.location.hash) {
    try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }
  }
}

// ============================================================================
// URL Hash 恢复 — 支持浏览器前进/后退和直接链接
// ============================================================================

/**
 * restoreFromHash — 根据当前 URL hash 恢复页面状态
 *
 * 【它做什么】
 *   解析 window.location.hash，根据 hash 类型分流处理：
 *   1. #article/<id>   → 切换到 articles 面板并打开指定文章
 *   2. #news           → 打开新闻面板
 *   3. #<section>      → 切换到对应 section（需在白名单 VALID_SECTIONS 中）
 *
 * 【为什么需要 300ms 延迟打开文章】
 *   switchSection 触发的面板展开动画需要时间完成。
 *   如果在面板还没完全打开时就调用 openArticleById，
 *   文章内容可能会在尺寸不正确的面板中渲染，导致布局错乱。
 *   300ms 是一个经验值，足够 CSS transition 完成。
 *
 * 【输入】无（从 window.location.hash 读取）
 * 【输出】无
 *
 * 【副作用】
 *   调用 switchSection / openNewsPanel / openArticleById，
 *   间接修改 DOM、URL、全局状态
 *
 * 【调用者】
 *   - window 'hashchange' 事件监听器（浏览器前进/后退 + 手动修改 hash）
 *   - app.js 初始化时调用（恢复上次关闭页面时的状态）
 */
function restoreFromHash() {
  var hash = window.location.hash;
  if (!hash) return;

  // 文章锚点: #article/<id>  →  切换到文章面板并打开指定文章
  var articleMatch = hash.match(/^#article\/(\d+)$/);
  if (articleMatch) {
    var articleId = parseInt(articleMatch[1], 10);
    switchSection('articles', true);  // silent=true，不产生额外历史
    // 延迟 300ms 等面板展开动画完成后再打开文章
    setTimeout(function() {
      if (typeof window.openArticleById === 'function') {
        window.openArticleById(articleId);
      }
    }, 300);
    return;
  }

  // 资讯面板
  if (hash === '#news') {
    if (typeof window.openNewsPanel === 'function') {
      window.openNewsPanel();
    }
    document.querySelectorAll('.side-nav-item').forEach(function(n) {
      var isActive = n.dataset.section === 'news';
      n.classList.toggle('active', isActive);
      n.setAttribute('aria-selected', String(isActive));
    });
    currentSection = 'news';
    return;
  }

  // 普通 section: #home, #articles, #cloud 等
  var section = hash.slice(1);  // 去掉开头的 #
  if (VALID_SECTIONS.indexOf(section) !== -1) {
    switchSection(section, true);  // silent=true，恢复时不写入额外历史
  }
}

// ============================================================================
// 「更多」菜单 — BGM 播放器 / 全屏 / 登录入口
// ============================================================================

/** 「更多」菜单是否打开 */
var moreMenuOpen = false;

/**
 * toggleMoreMenu — 切换更多菜单的打开/关闭状态
 *
 * 【它做什么】
 *   翻转 moreMenuOpen 标志，切换 #moreMenu 的 .open class
 *   和 #btnMore 按钮的 .active class。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】修改 moreMenuOpen 标志、修改 #moreMenu 和 #btnMore 的 class
 * 【调用者】
 *   - #btnMore 按钮点击事件
 *   - 其他模块通过 window.toggleMoreMenu（如果暴露）
 */
function toggleMoreMenu() {
  var menu = document.getElementById('moreMenu');
  if (!menu) return;
  moreMenuOpen = !moreMenuOpen;
  menu.classList.toggle('open', moreMenuOpen);
  var btn = document.getElementById('btnMore');
  if (btn) btn.classList.toggle('active', moreMenuOpen);
}

/**
 * closeMoreMenu — 关闭更多菜单
 *
 * 【它做什么】
 *   设置 moreMenuOpen = false，移除 #moreMenu 的 .open class
 *   和 #btnMore 的 .active class。
 *
 * 【为什么需要独立的关闭函数】
 *   toggleMoreMenu 会翻转状态，但在点击菜单外部空白区域关闭时，
 *   我们不希望翻转——我们明确知道要关闭。所以需要一个方向确定的关闭函数。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】修改 moreMenuOpen 标志、修改 DOM class
 * 【调用者】
 *   - 全局 click 事件（点击菜单外部空白时）
 *   - 菜单项点击后（closeMoreMenu 再执行菜单 action）
 */
function closeMoreMenu() {
  moreMenuOpen = false;
  var menu = document.getElementById('moreMenu');
  if (menu) menu.classList.remove('open');
  var btn = document.getElementById('btnMore');
  if (btn) btn.classList.remove('active');
}

// ============================================================================
// 滑动手势 — 移动端下滑关闭面板
// ============================================================================

/**
 * bindPanelSwipe — 给面板元素绑定下滑关闭手势
 *
 * 【它做什么】
 *   监听元素的 touchstart / touchmove / touchend 事件，
 *   实现类似 iOS 的「下滑关闭」手势：
 *   - 只能在面板 handle 区域（.panel-header / .news-header）或内容区滚动到顶部时触发
 *   - 只响应下滑（dy > 0），上滑不干预
 *   - 下滑超过 CLOSE_THRESHOLD (80px) 或速度超过 VELOCITY_THRESHOLD (0.5 px/ms) 时关闭面板
 *   - 否则弹回原位
 *
 * 【为什么限制触发条件】
 *   - 只在 handle 或滚动到顶部时触发：防止用户在内容区正常滚动时误触关闭手势
 *   - 只响应下滑：上滑留给内容区正常滚动
 *
 * 【手势判断逻辑】
 *   用了两个条件（OR 关系）：位移 > 80px 或者 速度 > 0.5 px/ms
 *   这意味着用户既可以慢速拖到底关闭，也可以快速轻扫关闭，
 *   覆盖了不同用户的操作习惯。
 *
 * 【输入】
 *   el      — HTMLElement，要绑定手势的面板元素
 *   onClose — Function，面板应关闭时执行的回调
 *
 * 【输出】无
 *
 * 【副作用】在 el 上添加 touchstart / touchmove / touchend 事件监听器
 *
 * 【调用者】
 *   bindNavEvents —— 给 contentPanel 和 newsSidebar 各绑定一次
 *
 * 【为什么使用 passive: true / false 混用】
 *   touchstart：passive: true（不阻止默认行为，滚动正常处理）
 *   touchmove：passive: false（需要在 dy > 10 时 e.preventDefault() 阻止页面滚动，
 *              避免面板手势和页面滚动冲突）
 *   touchend：passive: true（不需要阻止默认行为）
 */
function bindPanelSwipe(el, onClose) {
  var _touchStartY = 0;       // 触摸起始 Y 坐标
  var _touchStartTime = 0;    // 触摸起始时间戳（ms），用于计算滑动速度
  var _touchActive = false;   // 当前手势是否激活
  var _translateY = 0;        // 当前累计位移
  var CLOSE_THRESHOLD = 80;   // 位移阈值（px）：超过此值触发关闭
  var VELOCITY_THRESHOLD = 0.5; // 速度阈值（px/ms）：超过此值触发关闭

  /**
   * isAtTop — 检查面板内容区是否滚动到顶部
   *
   * 【为什么需要这个检查】
   *   如果内容区还有滚动空间（用户没有滚到顶），下滑手势应该留给内容区滚动，
   *   而不是触发面板关闭。只有在内容区已经到顶时，下滑才应该关闭面板。
   */
  function isAtTop() {
    var body = el.querySelector('.panel-body, .news-body');
    if (!body) return true;
    return body.scrollTop <= 0;
  }

  el.addEventListener('touchstart', function(e) {
    // 仅允许在面板 handle 区域或内容区滚动到顶部时激活手势
    var isHandle = !!e.target.closest('.panel-header, .news-header');
    if (!isHandle && !isAtTop()) {
      _touchActive = false;
      return;
    }
    _touchStartY = e.touches[0].clientY;
    _touchStartTime = Date.now();
    _touchActive = true;
    _translateY = 0;
    el.style.transition = 'none';  // 手势跟踪期间禁用 CSS transition，实现跟手效果
  }, { passive: true });

  el.addEventListener('touchmove', function(e) {
    if (!_touchActive) return;
    var dy = e.touches[0].clientY - _touchStartY;
    // 只响应下滑（dy > 0），上滑不干预
    if (dy <= 0) {
      _translateY = 0;
      el.style.transform = '';
      return;
    }
    // 如果内容区还有滚动空间且当前触摸点不在 handle 上，取消手势
    if (!isAtTop() && !e.target.closest('.panel-header, .news-header')) {
      _touchActive = false;
      _translateY = 0;
      el.style.transform = '';
      return;
    }
    _translateY = dy;
    el.style.transform = 'translateY(' + dy + 'px)';
    // 下滑超过 10px 时阻止页面默认滚动行为（面板手势优先）
    if (dy > 10) e.preventDefault();
  }, { passive: false });  // passive: false 是 e.preventDefault() 的必要条件

  el.addEventListener('touchend', function() {
    if (!_touchActive) return;
    _touchActive = false;
    // 恢复 CSS transition，产生平滑的弹回或消失动画
    el.style.transition = 'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)';
    var velocity = _translateY / Math.max(1, Date.now() - _touchStartTime);
    if (_translateY > CLOSE_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
      // 触发关闭：面板向下滑出屏幕
      el.style.transform = 'translateY(105%)';
      setTimeout(function() {
        // 动画完成后清理 inline style，避免影响下一次打开
        el.style.transition = '';
        el.style.transform = '';
        if (typeof onClose === 'function') onClose();
      }, 260);  // 260ms 略长于 CSS transition 的 250ms，确保动画完成
    } else {
      // 弹回原位
      el.style.transform = 'translateY(0)';
      setTimeout(function() {
        el.style.transition = '';
        el.style.transform = '';
      }, 260);
    }
    _translateY = 0;
  }, { passive: true });
}

// ============================================================================
// bindNavEvents — 注册所有导航相关的 DOM 事件监听器
// ============================================================================

/**
 * bindNavEvents — 绑定所有导航交互事件
 *
 * 【它做什么】
 *   集中注册全局和局部事件监听器：
 *   1. Escape 键 → 关闭当前打开的面板（news 优先）
 *   2. 侧边栏/底部栏点击 → switchSection 或 toggle 面板
 *   3. 面板关闭按钮 → closePanel
 *   4. 更多菜单按钮 → toggleMoreMenu
 *   5. 更多菜单项点击 → 分发 action（bgm / fullscreen / login）
 *   6. 全局点击 → 关闭更多菜单（外部点击） / 桌面端关闭面板（点击空白）
 *   7. hashchange → restoreFromHash（浏览器前进/后退）
 *   8. 滑动手势 → contentPanel 和 newsSidebar 的下滑关闭
 *
 * 【为什么使用全局 click 事件处理面板关闭】
 *   不需要在每个可能的空白区域单独绑定事件。
 *   通过在 document 层级监听 click，检查 e.target 是否在面板/侧边栏/弹窗内部，
 *   如果不是则关闭面板。这是典型的「点击外部关闭」模式。
 *
 * 【为什么桌面端才有点击空白关闭，移动端没有】
 *   移动端（window.innerWidth <= 540）面板是全宽的 bottom sheet 模式，
 *   没有「空白区域」可点击，关闭通过滑动手势和关闭按钮实现。
 *
 * 【B-10 修复说明（已内联到代码中）】
 *   使用 document.contains(e.target) 检查目标节点是否仍在 DOM 树中。
 *   当面板内容通过 innerHTML 重建时，旧的 DOM 节点被移除，
 *   e.target.closest() 对离树节点返回 null，导致本应阻止关闭的点击
 *   也被当作「外部点击」而关闭面板。document.contains 能正确识别离树节点，
 *   避免此 Bug。
 *
 * 【输入】无
 * 【输出】无
 *
 * 【副作用】
 *   在 document、#sidebarNav、#panelClose、#btnMore、#moreMenu
 *   和 window 上添加事件监听器。在 contentPanel 和 newsSidebar 上
 *   绑定 touch 手势。
 *
 * 【调用者】
 *   app.js 在 DOMContentLoaded 时调用一次
 */
function bindNavEvents() {
  // ---- Escape 键关闭面板 ----
  // 优先级：如果 news 面板开着先关 news，否则关 contentPanel
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (newsPanelOpen) {
        if (typeof window.closeNewsPanel === 'function') window.closeNewsPanel();
      } else if (panelOpen) {
        closePanel();
      }
    }
  });

  // ---- 侧边栏/底部栏导航项点击 ----
  // 使用事件委托：绑定在 #sidebarNav 父容器上，通过 closest 找到 .side-nav-item
  document.getElementById('sidebarNav').addEventListener('click', function(e) {
    var nav = e.target.closest('.side-nav-item');
    if (!nav) return;
    var section = nav.dataset.section;

    // 资讯 tab 特殊处理：与 newsSidebar 交互而非 contentPanel
    if (section === 'news') {
      if (newsPanelOpen) {
        // 已打开 → 关闭资讯面板，清除高亮和 hash，回到首页
        if (typeof window.closeNewsPanel === 'function') window.closeNewsPanel();
        document.querySelectorAll('.side-nav-item').forEach(function(n) {
          n.classList.remove('active');
          n.setAttribute('aria-selected', 'false');
        });
        currentSection = 'home';
        if (window.location.hash) {
          try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
        }
      } else {
        switchSection('news');
      }
      return;
    }

    // 普通 section：如果点击的是当前已激活的 section 且面板开着 → toggle 关闭
    if (section === currentSection && panelOpen) {
      closePanel();
      return;
    }
    switchSection(section);
  });

  // ---- 面板关闭按钮 ----
  document.getElementById('panelClose').addEventListener('click', closePanel);

  // ---- 更多菜单 ----
  var btnMore = document.getElementById('btnMore');
  if (btnMore) {
    btnMore.addEventListener('click', function(e) {
      e.stopPropagation();  // 阻止冒泡到 document，避免被全局 click 事件立即关闭
      toggleMoreMenu();
    });
  }

  // ---- 更多菜单项点击 ----
  var moreMenu = document.getElementById('moreMenu');
  if (moreMenu) {
    moreMenu.addEventListener('click', function(e) {
      var item = e.target.closest('.more-menu-item');
      if (!item) return;
      var action = item.dataset.action;
      closeMoreMenu();  // 点击菜单项后先关闭菜单，再执行 action
      switch (action) {
        case 'bgm':
          // 打开 BGM 播放器弹窗
          document.getElementById('bgmModal').classList.remove('hidden');
          if (typeof window.renderBGMPlaylist === 'function') window.renderBGMPlaylist();
          break;
        case 'fullscreen':
          // 全屏切换：兼容标准 Fullscreen API
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(function() {});
          } else {
            document.exitFullscreen();
          }
          break;
        case 'login':
          // 登录/登出：委托给 settings.js
          if (typeof window.handleLockBtnClick === 'function') window.handleLockBtnClick();
          break;
      }
    });
  }

  // ---- 全局 click 事件：处理「点击外部关闭」 ----
  document.addEventListener('click', function(e) {
    // 更多菜单：点击外部关闭（全设备通用）
    if (moreMenuOpen && !e.target.closest('#btnMore') && !e.target.closest('.more-menu')) {
      closeMoreMenu();
    }

    // 桌面端面板关闭：点击面板外部空白区域
    if (!panelOpen) return;
    if (window.innerWidth <= 540) return;  // 移动端不处理（无空白区域）

    // B-10 修复：目标节点可能已被 innerHTML 重建而脱离文档树，
    // closest 对离树节点返回 null。用 document.contains 统一防御。
    if (!document.contains(e.target)) return;

    // 白名单：点击这些区域内部时不关闭面板
    if (e.target.closest('.sidebar') || e.target.closest('.content-panel')) return;
    if (e.target.closest('.wallpaper-picker') || e.target.closest('.bgm-player')) return;
    if (e.target.closest('.modal-overlay:not(.hidden)')) return;
    if (e.target.closest('.more-menu')) return;

    closePanel();
  });

  // ---- 浏览器前进/后退 ----
  window.addEventListener('hashchange', function() {
    if (!window.location.hash) return;
    restoreFromHash();
  });

  // ---- 绑定面板滑动手势（移动端 only） ----
  // contentPanel 下滑 → 关闭面板
  var contentPanel = document.getElementById('contentPanel');
  bindPanelSwipe(contentPanel, function() {
    closePanel();
  });

  // newsSidebar 下滑 → 关闭资讯面板
  var newsPanel = document.getElementById('newsSidebar');
  bindPanelSwipe(newsPanel, function() {
    if (typeof window.closeNewsPanel === 'function') window.closeNewsPanel();
  });
}

// ============================================================================
// 新闻面板状态同步 — 通过 EventBus 或直接回调
// ============================================================================

/**
 * onNewsPanelOpened — 资讯面板打开时的回调
 *
 * 【它做什么】
 *   设置 newsPanelOpen = true，如果内容面板开着则关闭它（互斥），
 *   重新高亮 news nav tab（因为 closePanel 会清除所有高亮）。
 *
 * 【为什么 closePanel 后会失去高亮】
 *   closePanel 的设计原则是关闭面板后清除所有 nav 高亮（回到无选中状态）。
 *   但打开 news 面板时需要 news tab 保持高亮，所以必须重新设置。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】修改 newsPanelOpen、可能调用 closePanel、修改 DOM 高亮
 *
 * 【调用者】
 *   EventBus 'news:panelOpened' 事件（由 anime-news.js 触发）
 *   或通过 window.onNewsPanelOpened 直接调用
 */
function onNewsPanelOpened() {
  newsPanelOpen = true;
  // 如果内容面板打开，关闭（互斥）
  if (panelOpen) {
    closePanel();
  }
  // closePanel 会清除所有高亮，需要重新高亮 news tab
  document.querySelectorAll('.side-nav-item').forEach(function(n) {
    var isActive = n.dataset.section === 'news';
    n.classList.toggle('active', isActive);
    n.setAttribute('aria-selected', String(isActive));
  });
  currentSection = 'news';
}

/**
 * onNewsPanelClosed — 资讯面板关闭时的回调
 *
 * 【它做什么】
 *   设置 newsPanelOpen = false，清除 news tab 高亮，currentSection 回归 'home'。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】修改 newsPanelOpen、清除 DOM 高亮、更新 currentSection
 *
 * 【调用者】
 *   EventBus 'news:panelClosed' 事件（由 anime-news.js 触发）
 *   或通过 window.onNewsPanelClosed 直接调用
 */
function onNewsPanelClosed() {
  newsPanelOpen = false;
  // 清除 news tab 高亮
  document.querySelectorAll('.side-nav-item').forEach(function(n) {
    if (n.dataset.section === 'news') {
      n.classList.remove('active');
      n.setAttribute('aria-selected', 'false');
    }
  });
  currentSection = 'home';
}

// ---- 监听 anime-news 模块的面板状态变更事件 ----
// EventBus 由 app.js 初始化，anime-news.js 在打开/关闭面板时触发对应事件
if (typeof window.EventBus !== 'undefined') {
  window.EventBus.on('news:panelOpened', onNewsPanelOpened);
  window.EventBus.on('news:panelClosed', onNewsPanelClosed);
}

// ============================================================================
// 导出到 window 全局 — 供其他模块调用
// ============================================================================

window.bindNavEvents = bindNavEvents;
window.restoreFromHash = restoreFromHash;
window.switchSection = switchSection;
// 向后兼容：保留 window 引用，供外部调用者（如 hash 恢复逻辑）使用
window.onNewsPanelOpened = onNewsPanelOpened;
window.onNewsPanelClosed = onNewsPanelClosed;
window._panelScrollPositions = _panelScrollPositions;
export { switchSection, restoreFromHash, bindNavEvents, closePanel, openPanel };
