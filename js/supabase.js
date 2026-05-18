// ==================== Supabase Client ====================
// 替换下面的 URL 和 Key 为你的 Supabase 项目信息
const SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOi...';

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

// ---- Auth 状态监听 ----
if (sb) {
  sb.auth.onAuthStateChange(function(event) {
    if (event === 'SIGNED_IN') {
      var overlay = document.getElementById('lockOverlay');
      if (overlay) overlay.classList.add('hidden');
      if (typeof syncSettingsFromCloud === 'function') syncSettingsFromCloud();
    }
    if (event === 'SIGNED_OUT') {
      var overlay = document.getElementById('lockOverlay');
      if (overlay) overlay.classList.remove('hidden');
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
