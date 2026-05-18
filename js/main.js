// ==================== Main Entry ====================
var _inited = false;
// ★ 全局登录标志，避免每次查询都调 sb.auth.getUser()
var _isLoggedIn = false;

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

// ★ 标记为已登录，刷新各模块缓存
function onLoginSuccess() {
  _isLoggedIn = true;
  _wallpaperCache = { ts: 0, items: null };
  _trackCache = { ts: 0, items: null };
  var lockBtn = document.getElementById('btnLock');
  if (lockBtn) { lockBtn.textContent = '👤'; lockBtn.title = '登出'; }
  // 登录后刷新云端数据
  applyAvatar();
  renderFileList();
  renderBGMPlaylist();
  renderWallpaperDots();
  loadArticles();
  // 重新加载壁纸（含云端壁纸）
  applyWallpaper(currentWallpaper);
  var tracks = getAllTracks().then(function(t) {
    if (currentTrackIdx < 0 || currentTrackIdx >= t.length) currentTrackIdx = 0;
    playCurrentTrack();
  });
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

  // ★ 一次认证检查，决定后续是否调 Supabase
  if (sb) {
    try {
      var sessionResult = await sb.auth.getSession();
      if (sessionResult.data.session) {
        _isLoggedIn = true;
        document.getElementById('lockOverlay').classList.add('hidden');
        var lockBtn = document.getElementById('btnLock');
        if (lockBtn) { lockBtn.textContent = '👤'; lockBtn.title = '登出'; }
        await syncSettingsFromCloud();
      }
    } catch (e) { /* 游客模式 */ }
  }

  // 游客模式：所有调用走本地缓存/defaults，不发网络请求
  // 已登录：正常查询 Supabase
  await applyAvatar();
  renderFileList();
  renderBGMPlaylist();
  initSakura();
  applyAllSettings();
  renderWallpaperDots();
  loadArticles();

  // 设置初始壁纸（跳过预加载，直接应用）
  var items = await getAllWallpapers();
  if (items.length > 0) {
    if (currentWallpaper >= items.length) currentWallpaper = 0;
    var wp = items[currentWallpaper];
    document.body.style.backgroundImage = wp.value;
    localStorage.setItem('wallpaperIdx', currentWallpaper);
  }

  // 恢复 BGM
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

// PWA: Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/personal-site/sw.js').catch(function() {});
}

// Boot
init();
