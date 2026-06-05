// ==================== Navigation ====================
(function() {
  var currentSection = 'home';
  var panelOpen = true;

  var sectionTitles = {
    home: '🏠 首页',
    articles: '📝 文章',
    cloud: '📁 文件',
    submit: '✉️ 投稿',
    settings: '⚙ 设置',
    admin: '⚙ 管理',
    auth: '🔒 登录',
  };

  // 有效的 section hash 值集合
  var VALID_SECTIONS = ['home', 'articles', 'cloud', 'submit', 'settings', 'admin', 'auth'];

  function switchSection(name, silent) {
    if (!sectionTitles[name]) return;
    currentSection = name;
    document.querySelectorAll('.panel-section').forEach(function(s) { s.classList.remove('active'); });
    var secEl = document.getElementById('sec-' + name);
    if (secEl) secEl.classList.add('active');

    document.querySelectorAll('.side-nav-item').forEach(function(n) {
      var isActive = n.dataset.section === name;
      n.classList.toggle('active', isActive);
      n.setAttribute('aria-selected', String(isActive));
    });

    document.getElementById('panelTitle').textContent = sectionTitles[name] || name;
    openPanel();
    document.getElementById('panelBody').scrollTop = 0;

    // 同步到 URL hash（silent 模式用于初始恢复，不写入历史）
    var hash = '#' + name;
    if (window.location.hash !== hash && !silent) {
      try {
        history.replaceState(null, '', hash);
      } catch (e) { /* ignore */ }
    }
  }

  function openPanel() {
    panelOpen = true;
    document.getElementById('contentPanel').classList.add('open');
  }

  function closePanel() {
    panelOpen = false;
    document.getElementById('contentPanel').classList.remove('open');
    document.querySelectorAll('.side-nav-item').forEach(function(n) {
      n.classList.remove('active');
      n.setAttribute('aria-selected', 'false');
    });
    // 清除 hash
    if (window.location.hash) {
      try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }
    }
  }

  // 根据 hash 恢复状态
  function restoreFromHash() {
    var hash = window.location.hash;
    if (!hash) return;

    // 文章锚点: #article/<id>
    var articleMatch = hash.match(/^#article\/(\d+)$/);
    if (articleMatch) {
      var articleId = parseInt(articleMatch[1], 10);
      switchSection('articles', true);
      // 延迟打开文章 modal，等 articles 渲染完毕
      setTimeout(function() {
        if (typeof window.openArticleById === 'function') {
          window.openArticleById(articleId);
        }
      }, 300);
      return;
    }

    // 普通 section: #home, #articles, #cloud 等
    var section = hash.slice(1);
    if (VALID_SECTIONS.indexOf(section) !== -1) {
      switchSection(section, true);
    }
  }

  function bindNavEvents() {
    // Escape 键关闭面板
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && panelOpen) {
        closePanel();
      }
    });

    document.getElementById('sidebarNav').addEventListener('click', function(e) {
      var nav = e.target.closest('.side-nav-item');
      if (!nav) return;
      var section = nav.dataset.section;
      if (section === currentSection && panelOpen) {
        closePanel();
        return;
      }
      switchSection(section);
    });

    document.getElementById('panelClose').addEventListener('click', closePanel);

    document.addEventListener('click', function(e) {
      if (!panelOpen) return;
      if (window.innerWidth <= 540) return;
      if (e.target.closest('.sidebar') || e.target.closest('.content-panel')) return;
      if (e.target.closest('.wallpaper-picker') || e.target.closest('.bgm-player')) return;
      if (e.target.closest('.modal-overlay:not(.hidden)')) return;
      closePanel();
    });

    // 监听浏览器前进/后退
    window.addEventListener('hashchange', function() {
      if (!window.location.hash) return;
      // 直接调用 restoreFromHash，用 silent 模式避免重复写 hash
      restoreFromHash();
    });
  }

  window.bindNavEvents = bindNavEvents;
  window.restoreFromHash = restoreFromHash;
  window.switchSection = switchSection;
})();
