// ==================== Main Entry — Boot sequence & global wiring ====================
(function() {
  // Capture stable cross-module references (set up by earlier <script> tags)
  var sb = window.sb;
  var getCachedUser = window.getCachedUser;
  var showLoading = window.showLoading;
  var hideLoading = window.hideLoading;
  var showToast = window.showToast;
  var escHtml = window.escHtml;

  var _inited = false;

  function bindGlobalEvents() {
    document.getElementById('btnLock').addEventListener('click', window.handleLockBtnClick);

    // Social editor toggle
    var socialEditBtn = document.getElementById('btnSocialEdit');
    var socialEditor = document.getElementById('socialEditor');
    if (socialEditBtn && socialEditor) {
      socialEditBtn.addEventListener('click', function() {
        var visible = socialEditor.classList.toggle('visible');
        socialEditBtn.classList.toggle('active', visible);
      });
    }
  }

  /**
   * Called when the user logs in — updates UI chrome, refreshes data.
   * Registered via EventBus in init() below.
   */
  function onLoginSuccess() {
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
    window.applyAvatar();
    window.renderFileList();
    window.renderBGMPlaylist();
    window.renderWallpaperDots();
    window.loadArticles();
    if (typeof window._refreshNewsPanel === 'function') window._refreshNewsPanel();
    if (typeof window._reloadAdminData === 'function') window._reloadAdminData();
    window.applyWallpaper(window.currentWallpaper);
    window.getAllTracks().then(function(t) {
      if (window.currentTrackIdx < 0 || window.currentTrackIdx >= t.length) window.currentTrackIdx = 0;
      window.playCurrentTrack();
    });
  }

  /**
   * Main boot sequence — runs once on page load.
   * @returns {Promise<void>}
   */
  async function init() {
    if (_inited) return;
    _inited = true;

    // Wire EventBus listeners BEFORE other modules fire
    if (typeof window.EventBus !== 'undefined') {
      window.EventBus.on('auth:login', onLoginSuccess);
    }

    // Bind all module events
    window.bindWallpaperEvents();
    window.bindBGMEvents();
    window.bindCloudEvents();
    window.bindSettingsEvents();
    window.bindNavEvents();
    bindGlobalEvents();
    window.bindSubmitEvents();
    if (typeof window.bindAdminEvents === 'function') window.bindAdminEvents();

    // Check existing session
    if (sb) {
      try {
        var sessionResult = await sb.auth.getSession();
        if (sessionResult.data.session) {
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
          await window.syncSettingsFromCloud();
        }
      } catch (e) { /* guest mode */ }
    }

    // B-9: 每个初始化步骤独立 try/catch，单点失败不阻断其余
    var _safeAwait = async function(fn, label) {
      try {
        var r = fn();
        if (r && typeof r.then === 'function') await r;
      } catch (e) {
        console.warn('[init] ' + label + ' 失败:', e);
      }
    };

    await _safeAwait(function() { return window.applyAvatar(); }, 'applyAvatar');
    await _safeAwait(function() { return window.renderFileList(); }, 'renderFileList');
    await _safeAwait(function() { return window.renderBGMPlaylist(); }, 'renderBGMPlaylist');
    await _safeAwait(function() { window.initSakura(); }, 'initSakura');
    await _safeAwait(function() { window.applyAllSettings(); }, 'applyAllSettings');
    await _safeAwait(function() { return window.renderWallpaperDots(); }, 'renderWallpaperDots');
    await _safeAwait(function() { return window.loadArticles(); }, 'loadArticles');

    if (window._isLoggedIn) {
      if (typeof window._refreshNewsPanel === 'function') {
        await _safeAwait(function() { return window._refreshNewsPanel(); }, 'refreshNewsPanel');
      }
      if (typeof window._reloadAdminData === 'function') {
        await _safeAwait(function() { return window._reloadAdminData(); }, 'reloadAdminData');
      }
    }

    // Restore wallpaper
    var items = await window.getAllWallpapers();
    if (items.length > 0) {
      if (window.currentWallpaper >= items.length) window.currentWallpaper = 0;
      window.applyWallpaper(window.currentWallpaper, true);
    }

    // Restore BGM
    var tracks = await window.getAllTracks();
    var savedIdx = parseInt(localStorage.getItem('bgmTrackIdx') || '0');
    window.currentTrackIdx = Math.min(savedIdx, tracks.length - 1);
    window.bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
    window.playCurrentTrack();

    // Restore URL hash
    if (typeof window.restoreFromHash === 'function') {
      window.restoreFromHash();
    }
  }

  // Persist BGM state on unload
  window.addEventListener('beforeunload', function() {
    if (window.currentTrackIdx >= 0) window.safeSetItem('bgmTrackIdx', window.currentTrackIdx);
    window.safeSetItem('bgmVolume', window.bgmAudio.volume);
  });

  // Register Service Worker for offline caching
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/personal-site/sw.js').catch(function() {});
  }

  window._isLoggedIn = false;

  // Boot
  init();

  // ==== AI disclaimer popup: first visit auto-show, auto-dismiss after 1s ====
  setTimeout(function() {
    var overlay = document.getElementById('announcementOverlay');
    if (!overlay || sessionStorage.getItem('aiAnnounceSeen')) return;
    overlay.style.display = '';
    var autoTimer = setTimeout(dismissAnnouncement, 1000);

    function dismissAnnouncement() {
      clearTimeout(autoTimer);
      overlay.classList.add('dismissing');
      overlay.addEventListener('animationend', function() {
        overlay.style.display = 'none';
      }, { once: true });
      sessionStorage.setItem('aiAnnounceSeen', '1');
    }

    var closeBtn = document.getElementById('btnAnnouncementClose');
    if (closeBtn) { closeBtn.addEventListener('click', dismissAnnouncement); }
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) dismissAnnouncement();
    });
  }, 1200);
})();
