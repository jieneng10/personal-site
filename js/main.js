// ==================== Main Entry ====================
var _inited = false;

function bindGlobalEvents() {
  document.getElementById('btnFullscreen').addEventListener('click', function() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function() {});
    } else {
      document.exitFullscreen();
    }
  });

  document.getElementById('btnLock').addEventListener('click', handleLockBtnClick);
}

async function init() {
  if (_inited) return;
  _inited = true;

  bindWallpaperEvents();
  bindBGMEvents();
  bindCloudEvents();
  bindSettingsEvents();
  bindNavEvents();
  bindGlobalEvents();

  // 检查登录状态（游客也可浏览，不强制弹窗）
  if (sb) {
    try {
      var sessionResult = await sb.auth.getSession();
      if (sessionResult.data.session) {
        document.getElementById('lockOverlay').classList.add('hidden');
        var lockBtn = document.getElementById('btnLock');
        if (lockBtn) { lockBtn.textContent = '👤'; lockBtn.title = '登出'; }
        await syncSettingsFromCloud();
      }
    } catch (e) { /* 静默，游客模式 */ }
  }

  await applyAvatar();
  renderFileList();
  renderBGMPlaylist();
  initSakura();
  applyAllSettings();
  renderWallpaperDots();
  loadArticles();

  // Restore wallpaper
  var items = await getAllWallpapers();
  if (items.length === 0) {
    document.body.style.backgroundImage = 'none';
  } else {
    if (currentWallpaper >= items.length) currentWallpaper = 0;
    applyWallpaper(currentWallpaper);
  }

  // Restore BGM
  var tracks = await getAllTracks();
  var savedIdx = parseInt(localStorage.getItem('bgmTrackIdx') || '0');
  currentTrackIdx = Math.min(savedIdx, tracks.length - 1);
  bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
  playCurrentTrack();
}

// Save BGM state on unload
window.addEventListener('beforeunload', function() {
  if (currentTrackIdx >= 0) localStorage.setItem('bgmTrackIdx', currentTrackIdx);
  localStorage.setItem('bgmVolume', bgmAudio.volume);
});

// Boot
init();
