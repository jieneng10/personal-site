// ==================== Main Entry ====================
(function() {
  // Capture stable cross-module references
  var sb = window.sb;
  var getCachedUser = window.getCachedUser;
  var showLoading = window.showLoading;
  var hideLoading = window.hideLoading;
  var showToast = window.showToast;
  var escHtml = window.escHtml;

  var _inited = false;

  function bindGlobalEvents() {
    document.getElementById('btnFullscreen').addEventListener('click', function() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(function() {});
      } else {
        document.exitFullscreen();
      }
    });

    document.getElementById('btnLock').addEventListener('click', window.handleLockBtnClick);
  }

  function onLoginSuccess() {
    window._isLoggedIn = true;
    window._invalidateArticleCache();
    var lockBtn = document.getElementById('btnLock');
    if (lockBtn) { lockBtn.innerHTML = '<svg viewBox="0 0 24 24" class="nav-icon nav-icon-sys"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'; lockBtn.title = '登出'; }
    window.applyAvatar();
    window.renderFileList();
    window.renderBGMPlaylist();
    window.renderWallpaperDots();
    window.loadArticles();
    window.applyWallpaper(window.currentWallpaper);
    window.getAllTracks().then(function(t) {
      if (window.currentTrackIdx < 0 || window.currentTrackIdx >= t.length) window.currentTrackIdx = 0;
      window.playCurrentTrack();
    });
  }

  async function init() {
    if (_inited) return;
    _inited = true;

    window.bindWallpaperEvents();
    window.bindBGMEvents();
    window.bindCloudEvents();
    window.bindSettingsEvents();
    window.bindNavEvents();
    bindGlobalEvents();
    window.bindSubmitEvents();

    if (sb) {
      try {
        var sessionResult = await sb.auth.getSession();
        if (sessionResult.data.session) {
          window._isLoggedIn = true;
          document.getElementById('lockOverlay').classList.add('hidden');
          var lockBtn = document.getElementById('btnLock');
          if (lockBtn) { lockBtn.innerHTML = '<svg viewBox="0 0 24 24" class="nav-icon nav-icon-sys"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'; lockBtn.title = '登出'; }
          await window.syncSettingsFromCloud();
        }
      } catch (e) { /* 游客模式 */ }
    }

    await window.applyAvatar();
    window.renderFileList();
    window.renderBGMPlaylist();
    window.initSakura();
    window.applyAllSettings();
    window.renderWallpaperDots();
    window.loadArticles();

    var items = await window.getAllWallpapers();
    if (items.length > 0) {
      if (window.currentWallpaper >= items.length) window.currentWallpaper = 2;
      window.applyWallpaper(window.currentWallpaper, items, true);
    }

    var tracks = await window.getAllTracks();
    var savedIdx = parseInt(localStorage.getItem('bgmTrackIdx') || '0');
    window.currentTrackIdx = Math.min(savedIdx, tracks.length - 1);
    window.bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
    window.playCurrentTrack();

    // 恢复 URL hash 状态（如 #articles, #article/3 等）
    if (typeof window.restoreFromHash === 'function') {
      window.restoreFromHash();
    }
  }

  // Save BGM state on unload
  window.addEventListener('beforeunload', function() {
    if (window.currentTrackIdx >= 0) localStorage.setItem('bgmTrackIdx', window.currentTrackIdx);
    localStorage.setItem('bgmVolume', window.bgmAudio.volume);
  });

  // PWA: Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/personal-site/sw.js').catch(function() {});
  }

  window._isLoggedIn = false;
  window.onLoginSuccess = onLoginSuccess;

  // Boot
  init();
})();
