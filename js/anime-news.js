// ==================== Anime News — Right Sidebar ====================
(function() {
  var CACHE_KEY = 'animeNewsCache';
  var panelOpen = false;
  var _newsRefreshTimer = null;

  // ---- 计算当天日期 key（6:00 前算前一天）----
  function getTodayKey() {
    var now = new Date();
    if (now.getHours() < 6) now.setDate(now.getDate() - 1);
    return now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
  }

  // ---- 读 localStorage 缓存 ----
  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data.date === getTodayKey()) return data.news;
    } catch (e) { /* ignore */ }
    return null;
  }

  // ---- 写 localStorage 缓存 ----
  function writeCache(news) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ date: getTodayKey(), news: news }));
    } catch (e) { /* quota exceeded */ }
  }

  // ---- 从 Supabase 拉取 ----
  async function fetchSupabaseNews() {
    if (!window.sb) return null;
    try {
      var result = await window.sb.from('anime_news')
        .select('*')
        .order('news_date', { ascending: false })
        .order('id', { ascending: false });
      if (!result.error && result.data && result.data.length > 0) return result.data;
    } catch (e) { /* Supabase 不可用 */ }
    return null;
  }

  // ---- 从本地 JSON 兜底 ----
  async function fetchLocalNews() {
    try {
      var res = await fetch('data/anime-news.json');
      return await res.json();
    } catch (e) { return []; }
  }

  // ---- 获取新闻（缓存 → Supabase → 本地 JSON）----
  async function getNews() {
    var cached = readCache();
    if (cached) return cached;

    var supabaseNews = await fetchSupabaseNews();
    if (supabaseNews) {
      var items = supabaseNews.map(function(n) {
        return { id: n.id, title: n.title, summary: n.summary, content: n.content, source: n.source, url: n.url, date: n.news_date, pinned: n.pinned, heat: n.heat };
      });
      writeCache(items);
      return items;
    }

    var localNews = await fetchLocalNews();
    writeCache(localNews);
    return localNews;
  }

  // ---- 刷新（清除缓存后重新拉取）----
  async function refreshNews() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    var items = await getNews();
    renderNewsPanel(items);
  }

  // ---- 缓存完整资讯数据（用于弹窗）----
  var _newsData = [];

  // ---- 渲染资讯面板 ----
  function renderNewsPanel(items) {
    _newsData = items || [];
    var list = document.getElementById('newsList');
    if (!list) return;
    if (!items || !items.length) {
      list.innerHTML = '<div class="news-empty">暂无今日资讯 ✦</div>';
      return;
    }
    list.innerHTML = items.map(function(item, idx) {
      var srcTag = item.source ? '<span class="news-source-tag">' + escHtml(item.source) + '</span>' : '';
      var pinnedBadge = item.pinned ? ' <span class="news-pin-badge">📌置顶</span>' : '';
      var heatBadge = (item.heat && item.heat >= 50) ? ' <span class="news-heat-badge">🔥热门</span>' : '';
      return '<div class="news-card" data-news-idx="' + idx + '">' +
        '<div class="news-card-title">' + escHtml(item.title) + srcTag + pinnedBadge + heatBadge + '</div>' +
        '<div class="news-card-summary">' + escHtml(item.summary) + '</div>' +
        (item.url ? '<a class="news-card-link" href="' + escHtml(item.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation();">查看来源 →</a>' : '') +
      '</div>';
    }).join('');
  }

  function escHtml(str) {
    return window.escHtml ? window.escHtml(str) : String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ---- 打开资讯详情（复用文章 Modal）----
  function openNewsDetail(idx) {
    var item = _newsData[idx];
    if (!item) return;

    // 填内容到已有 article modal
    document.getElementById('articleModalTitle').textContent = item.title;
    document.getElementById('articleModalMeta').textContent = '📡 ' + (item.source || '二次元资讯') + ' · ' + (item.date || '').slice(0, 10);
    document.getElementById('articleModalTags').innerHTML = item.source ? '<span class="tag blue">' + escHtml(item.source) + '</span>' : '';

    // 隐藏文章专属元素
    var coverEl = document.getElementById('articleModalCover');
    if (coverEl) coverEl.style.display = 'none';
    var spoilerWarn = document.getElementById('articleModalSpoilerWarn');
    if (spoilerWarn) spoilerWarn.style.display = 'none';
    var linkWrap = document.getElementById('articleModalLinkWrap');
    if (linkWrap) linkWrap.style.display = item.url ? '' : 'none';
    if (linkWrap && item.url) {
      linkWrap.innerHTML = '<a href="' + escHtml(item.url) + '" target="_blank" rel="noopener" class="modal-link-btn">🔗 查看原文</a>';
    }

    // 正文：有 content 用 content，否则展示完整 summary + source
    var body = item.content || item.summary || '';
    if (!item.content && item.url) {
      body += '\n\n> 原文链接：' + item.url;
    }
    if (typeof marked !== 'undefined') {
      document.getElementById('articleModalContent').innerHTML = typeof window.sanitizeHtml === 'function'
        ? window.sanitizeHtml(marked.parse(body))
        : marked.parse(body);
    } else {
      document.getElementById('articleModalContent').textContent = body;
    }

    document.getElementById('articleModal').classList.remove('hidden');
  }

  // ---- Toggle 侧栏 ----
  function openNewsPanel() {
    panelOpen = true;
    var panel = document.getElementById('newsSidebar');
    if (panel) panel.classList.add('open');
    var trigger = document.getElementById('btnNewsToggle');
    if (trigger) trigger.classList.add('active');
    // 同步 nav 状态
    if (typeof window.onNewsPanelOpened === 'function') window.onNewsPanelOpened();
  }

  function closeNewsPanel() {
    panelOpen = false;
    var panel = document.getElementById('newsSidebar');
    if (panel) panel.classList.remove('open');
    var trigger = document.getElementById('btnNewsToggle');
    if (trigger) trigger.classList.remove('active');
    // 清除 news hash
    if (window.location.hash === '#news') {
      try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
    }
    // 同步 nav 状态
    if (typeof window.onNewsPanelClosed === 'function') window.onNewsPanelClosed();
  }

  function toggleNewsPanel() {
    if (panelOpen) { closeNewsPanel(); } else { openNewsPanel(); }
  }

  // ---- 定时刷新到次日 6:00 ----
  function scheduleNextRefresh() {
    if (_newsRefreshTimer) clearTimeout(_newsRefreshTimer);
    var now = new Date();
    var next6am = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0);
    if (now >= next6am) next6am.setDate(next6am.getDate() + 1);
    var delay = next6am - now + 5000; // 加 5 秒 buffer
    _newsRefreshTimer = setTimeout(function() { refreshNews(); scheduleNextRefresh(); }, delay);
  }

  // ---- 事件绑定 ----
  function bindAnimeNewsEvents() {
    var trigger = document.getElementById('btnNewsToggle');
    if (trigger) trigger.addEventListener('click', toggleNewsPanel);

    var panel = document.getElementById('newsSidebar');
    if (panel) {
      // 刷新按钮
      var refreshBtn = document.getElementById('btnNewsRefresh');
      if (refreshBtn) refreshBtn.addEventListener('click', refreshNews);
      // 点遮罩关闭
      panel.addEventListener('click', function(e) {
        if (e.target === panel) closeNewsPanel();
      });
      // 资讯卡片点击 → 打开详情弹窗
      var newsList = document.getElementById('newsList');
      if (newsList) {
        newsList.addEventListener('click', function(e) {
          if (e.target.closest('.news-card-link')) return; // 外链不拦截
          var card = e.target.closest('.news-card[data-news-idx]');
          if (card) {
            openNewsDetail(parseInt(card.getAttribute('data-news-idx')));
          }
        });
      }
    }

    // 移动端：side-nav-item 也不触发关闭
    document.addEventListener('click', function(e) {
      if (!panelOpen) return;
      if (e.target.closest('#newsSidebar') || e.target.closest('#btnNewsToggle')) return;
      closeNewsPanel();
    });
  }

  // ---- 初始化 ----
  (async function init() {
    bindAnimeNewsEvents();
    var today = getTodayKey();
    var headerEl = document.getElementById('newsHeaderDate');
    if (headerEl) { headerEl.textContent = '📡 ' + today.slice(5); }
    var items = await getNews();
    renderNewsPanel(items);
    scheduleNextRefresh();
    // expose for admin
    window._refreshNewsPanel = refreshNews;
    window._getNewsData = getNews;
  })();
})();
