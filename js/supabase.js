// ==================== Supabase Client ====================
const SUPABASE_URL = 'https://nskircwzcsmbkispshif.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5za2lyY3d6Y3NtYmtpc3BzaGlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMDY0MzYsImV4cCI6MjA5NDY4MjQzNn0.jZESXIc71IAVcCEY7nLGJvpPF2XIvm-hyb6-DOKfiE0';

var sb = null;
if (typeof supabase !== 'undefined') {
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
  console.warn('Supabase SDK 未加载，使用离线模式');
}

// ---- Helper: 唯一存储路径 (UUID 防冲突) ----
function sbStoragePath(userId, category, fileName) {
  var ext = fileName.split('.').pop();
  var uuid = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  return userId + '/' + category + '/' + uuid + '.' + ext;
}

// ---- Helper: 上传文件到 Storage ----
async function sbUpload(bucket, file, path) {
  if (!sb) throw new Error('Supabase unavailable');
  var result = await sb.storage.from(bucket).upload(path, file, { upsert: false });
  if (result.error) throw result.error;
  return result.data.path;
}

// ---- Helper: 公开 URL (public bucket) ----
function sbPublicUrl(bucket, path) {
  if (!sb) return null;
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

// ---- Helper: 签名 URL (private bucket, 60秒有效) ----
async function sbSignedUrl(bucket, path, expiresIn) {
  if (!sb) return null;
  expiresIn = expiresIn || 60;
  var result = await sb.storage.from(bucket).createSignedUrl(path, expiresIn);
  return result.data ? result.data.signedUrl : null;
}

// ---- Helper: 删除文件 ----
async function sbDelete(bucket, paths) {
  if (!sb) throw new Error('Supabase unavailable');
  if (!paths || paths.length === 0) return;
  var result = await sb.storage.from(bucket).remove([].concat(paths));
  if (result.error) throw result.error;
}

// ---- HTML 转义 (防 XSS) ----
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- 缓存用户信息，避免频繁调用 sb.auth.getUser() ----
var _cachedUser = null;
var _cachedUserTs = 0;
async function getCachedUser() {
  if (_cachedUser && Date.now() - _cachedUserTs < 120000) return _cachedUser;
  if (!sb) return null;
  try {
    var result = await sb.auth.getUser();
    _cachedUser = result.data.user;
    _cachedUserTs = Date.now();
    return _cachedUser;
  } catch (e) {
    return null;
  }
}

// ---- Auth 状态监听 ----
if (sb) {
  sb.auth.onAuthStateChange(function(event) {
    if (event === 'SIGNED_IN') {
      _cachedUser = null;
      _cachedUserTs = 0;
      var overlay = document.getElementById('lockOverlay');
      if (overlay) overlay.classList.add('hidden');
      if (typeof syncSettingsFromCloud === 'function') syncSettingsFromCloud();
      if (typeof onLoginSuccess === 'function') onLoginSuccess();
    }
    if (event === 'SIGNED_OUT') {
      _isLoggedIn = false;
      _cachedUser = null;
      _cachedUserTs = 0;
      _wallpaperCache = { ts: 0, items: null };
      _trackCache = { ts: 0, items: null };
      var lockBtn = document.getElementById('btnLock');
      if (lockBtn) { lockBtn.textContent = '🔒'; lockBtn.title = '登录'; }
    }
  });
}

// ---- Loading Toast ----
var _loadingToast = null;
function showLoading(msg) {
  if (!_loadingToast) {
    _loadingToast = document.createElement('div');
    _loadingToast.id = 'loadingToast';
    _loadingToast.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999;' +
      'background:rgba(20,18,30,0.92);border:1px solid rgba(180,140,220,0.5);border-radius:20px;' +
      'padding:10px 24px;color:#d4a0ff;font-size:13px;backdrop-filter:blur(12px);pointer-events:none;';
    document.body.appendChild(_loadingToast);
  }
  _loadingToast.textContent = msg;
  _loadingToast.style.display = '';
}
function hideLoading() {
  if (_loadingToast) _loadingToast.style.display = 'none';
}

// ---- Toast 通知 ----
var _toastTimer = null;
function showToast(msg, type) {
  var t = document.getElementById('toastMsg');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastMsg';
    t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:9999;'
      + 'padding:10px 24px;border-radius:20px;font-size:13px;pointer-events:none;'
      + 'transition:opacity 0.3s;opacity:0;';
    document.body.appendChild(t);
  }
  var bg = type === 'error' ? 'rgba(255,60,60,0.85)' : type === 'warn' ? 'rgba(255,180,60,0.85)' : 'rgba(100,200,120,0.85)';
  t.style.background = bg;
  t.style.color = '#fff';
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { t.style.opacity = '0'; }, 2500);
}
