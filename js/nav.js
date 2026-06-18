// ==================== Navigation ====================
(function() {
  var currentSection = 'home';
  var panelOpen = true;
  var newsPanelOpen = false;

  var sectionTitles = {
    home: '🏠 首页',
    articles: '📝 文章',
    news: '📡 资讯',
    cloud: '📁 文件',
    submit: '✉️ 投稿',
    settings: '⚙ 设置',
    admin: '⚙ 管理',
    auth: '🔒 登录',
  };

  // 有效的 section hash 值集合
  var VALID_SECTIONS = ['home', 'articles', 'news', 'cloud', 'submit', 'settings', 'admin', 'auth'];

  // ---- 面板滚动位置保持 ----
  var _panelScrollPositions = {};

  function switchSection(name, silent) {
    if (!sectionTitles[name]) return;

    // 新闻面板特殊处理
    if (name === 'news') {
      // 如果内容面板打开，先保存滚动位置
      if (panelOpen) {
        _panelScrollPositions[currentSection] = document.getElementById('panelBody').scrollTop || 0;
      }
      // 关闭内容面板
      if (panelOpen) closePanel();
      // 切换新闻面板
      if (typeof window.openNewsPanel === 'function') {
        window.openNewsPanel();
      }
      // 高亮资讯 tab
      document.querySelectorAll('.side-nav-item').forEach(function(n) {
        var isActive = n.dataset.section === 'news';
        n.classList.toggle('active', isActive);
        n.setAttribute('aria-selected', String(isActive));
      });
      currentSection = 'news';
      var hash = '#news';
      if (window.location.hash !== hash && !silent) {
        try { history.replaceState(null, '', hash); } catch (e) {}
      }
      return;
    }

    // 普通 section
    // 保存当前面板的滚动位置
    if (panelOpen && currentSection && currentSection !== 'news') {
      _panelScrollPositions[currentSection] = document.getElementById('panelBody').scrollTop || 0;
    }

    // 如果新闻面板打开，先关闭
    if (newsPanelOpen && typeof window.closeNewsPanel === 'function') {
      window.closeNewsPanel();
    }

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

    // 恢复该面板滚动位置
    var savedScroll = _panelScrollPositions[name];
    var panelBody = document.getElementById('panelBody');
    panelBody.scrollTop = savedScroll || 0;

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
    // 保存当前面板滚动位置
    if (currentSection && currentSection !== 'news') {
      _panelScrollPositions[currentSection] = document.getElementById('panelBody').scrollTop || 0;
    }
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
    var section = hash.slice(1);
    if (VALID_SECTIONS.indexOf(section) !== -1) {
      switchSection(section, true);
    }
  }

  // ==================== 更多菜单 ====================
  var moreMenuOpen = false;
  function toggleMoreMenu() {
    var menu = document.getElementById('moreMenu');
    if (!menu) return;
    moreMenuOpen = !moreMenuOpen;
    menu.classList.toggle('open', moreMenuOpen);
    var btn = document.getElementById('btnMore');
    if (btn) btn.classList.toggle('active', moreMenuOpen);
  }

  function closeMoreMenu() {
    moreMenuOpen = false;
    var menu = document.getElementById('moreMenu');
    if (menu) menu.classList.remove('open');
    var btn = document.getElementById('btnMore');
    if (btn) btn.classList.remove('active');
  }

  // ==================== 滑动手势 ====================
  function bindPanelSwipe(el, onClose) {
    var _touchStartY = 0;
    var _touchStartTime = 0;
    var _touchActive = false;
    var _translateY = 0;
    var CLOSE_THRESHOLD = 80;
    var VELOCITY_THRESHOLD = 0.5; // px/ms

    function isAtTop() {
      // 检查面板内容区是否滚动到顶部
      var body = el.querySelector('.panel-body, .news-body');
      if (!body) return true;
      return body.scrollTop <= 0;
    }

    el.addEventListener('touchstart', function(e) {
      // 仅允许在面板 handle 区域或内容区滚动到顶部时触发
      var isHandle = !!e.target.closest('.panel-header, .news-header');
      if (!isHandle && !isAtTop()) {
        _touchActive = false;
        return;
      }
      _touchStartY = e.touches[0].clientY;
      _touchStartTime = Date.now();
      _touchActive = true;
      _translateY = 0;
      el.style.transition = 'none';
    }, { passive: true });

    el.addEventListener('touchmove', function(e) {
      if (!_touchActive) return;
      var dy = e.touches[0].clientY - _touchStartY;
      // 只响应下滑
      if (dy <= 0) {
        _translateY = 0;
        el.style.transform = '';
        return;
      }
      // 如果内容区还有滚动空间且不是从 handle 开始的，取消手势
      if (!isAtTop() && !e.target.closest('.panel-header, .news-header')) {
        _touchActive = false;
        _translateY = 0;
        el.style.transform = '';
        return;
      }
      _translateY = dy;
      el.style.transform = 'translateY(' + dy + 'px)';
      // 阻止默认滚动（面板关闭手势优先）
      if (dy > 10) e.preventDefault();
    }, { passive: false });

    el.addEventListener('touchend', function() {
      if (!_touchActive) return;
      _touchActive = false;
      el.style.transition = 'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)';
      var velocity = _translateY / Math.max(1, Date.now() - _touchStartTime);
      if (_translateY > CLOSE_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
        // 关闭面板
        el.style.transform = 'translateY(105%)';
        setTimeout(function() {
          el.style.transition = '';
          el.style.transform = '';
          if (typeof onClose === 'function') onClose();
        }, 260);
      } else {
        // 弹回
        el.style.transform = 'translateY(0)';
        setTimeout(function() {
          el.style.transition = '';
          el.style.transform = '';
        }, 260);
      }
      _translateY = 0;
    }, { passive: true });
  }

  function bindNavEvents() {
    // Escape 键关闭面板
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (newsPanelOpen) {
          if (typeof window.closeNewsPanel === 'function') window.closeNewsPanel();
        } else if (panelOpen) {
          closePanel();
        }
      }
    });

    // 侧边栏/底部栏点击处理器
    document.getElementById('sidebarNav').addEventListener('click', function(e) {
      var nav = e.target.closest('.side-nav-item');
      if (!nav) return;
      var section = nav.dataset.section;

      // 资讯 tab 特殊处理
      if (section === 'news') {
        if (newsPanelOpen) {
          // 已打开 → 关闭
          if (typeof window.closeNewsPanel === 'function') window.closeNewsPanel();
          // 清除 news 高亮 + hash
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

      if (section === currentSection && panelOpen) {
        closePanel();
        return;
      }
      switchSection(section);
    });

    document.getElementById('panelClose').addEventListener('click', closePanel);

    // 更多菜单
    var btnMore = document.getElementById('btnMore');
    if (btnMore) {
      btnMore.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleMoreMenu();
      });
    }

    // 更多菜单项点击
    var moreMenu = document.getElementById('moreMenu');
    if (moreMenu) {
      moreMenu.addEventListener('click', function(e) {
        var item = e.target.closest('.more-menu-item');
        if (!item) return;
        var action = item.dataset.action;
        closeMoreMenu();
        switch (action) {
          case 'bgm':
            document.getElementById('bgmModal').classList.remove('hidden');
            if (typeof window.renderBGMPlaylist === 'function') window.renderBGMPlaylist();
            break;
          case 'fullscreen':
            if (!document.fullscreenElement) {
              document.documentElement.requestFullscreen().catch(function() {});
            } else {
              document.exitFullscreen();
            }
            break;
          case 'login':
            if (typeof window.handleLockBtnClick === 'function') window.handleLockBtnClick();
            break;
        }
      });
    }

    // 点击空白关闭面板（桌面）/ 更多菜单（全设备）
    document.addEventListener('click', function(e) {
      // 更多菜单：点击外部关闭（全设备通用）
      if (moreMenuOpen && !e.target.closest('#btnMore') && !e.target.closest('.more-menu')) {
        closeMoreMenu();
      }
      // 桌面端面板关闭
      if (!panelOpen) return;
      if (window.innerWidth <= 540) return;
      // B-10: 目标节点可能已被 innerHTML 重建而脱离文档树，closest 对离树节点返回 null
      // 用 document.contains 统一防御，不再需要逐个列举 filter-tag/filter-bar
      if (!document.contains(e.target)) return;
      if (e.target.closest('.sidebar') || e.target.closest('.content-panel')) return;
      if (e.target.closest('.wallpaper-picker') || e.target.closest('.bgm-player')) return;
      if (e.target.closest('.modal-overlay:not(.hidden)')) return;
      if (e.target.closest('.more-menu')) return;
      closePanel();
    });

    // 监听浏览器前进/后退
    window.addEventListener('hashchange', function() {
      if (!window.location.hash) return;
      restoreFromHash();
    });

    // ---- 绑定面板滑动手势（移动端 only） ----
    var contentPanel = document.getElementById('contentPanel');
    bindPanelSwipe(contentPanel, function() {
      closePanel();
    });

    var newsPanel = document.getElementById('newsSidebar');
    bindPanelSwipe(newsPanel, function() {
      if (typeof window.closeNewsPanel === 'function') window.closeNewsPanel();
    });
  }

  // ---- 同步资讯面板状态 ----
  function onNewsPanelOpened() {
    newsPanelOpen = true;
    // 如果内容面板打开，关闭
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

  // Listen for news panel state changes from anime-news module
  if (typeof window.EventBus !== 'undefined') {
    window.EventBus.on('news:panelOpened', onNewsPanelOpened);
    window.EventBus.on('news:panelClosed', onNewsPanelClosed);
  }

  window.bindNavEvents = bindNavEvents;
  window.restoreFromHash = restoreFromHash;
  window.switchSection = switchSection;
  // Backward-compat: keep window refs for any external caller (e.g. hash restore)
  window.onNewsPanelOpened = onNewsPanelOpened;
  window.onNewsPanelClosed = onNewsPanelClosed;
  window._panelScrollPositions = _panelScrollPositions;
})();
