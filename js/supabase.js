// ==================== Supabase Client & Shared Utilities ====================
(function() {
  /** @type {import('@supabase/supabase-js').SupabaseClient|null} */
  var sb = null;

  if (typeof supabase !== 'undefined' && window.SUPABASE_URL && window.SUPABASE_KEY) {
    sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
  } else if (typeof supabase === 'undefined') {
    console.warn('Supabase SDK 未加载，使用离线模式');
  }

  // =========================================================================
  // Storage helpers
  // =========================================================================

  /**
   * Generate a unique storage path to avoid naming collisions.
   * Format: `<userId>/<category>/<uuid>.<ext>`
   *
   * @param   {string} userId   - Supabase auth user ID
   * @param   {string} category - Bucket sub-folder (wallpaper|bgm|cloud|avatar)
   * @param   {string} fileName - Original file name (extension preserved)
   * @returns {string} Unique storage key
   */
  function sbStoragePath(userId, category, fileName) {
    var ext = fileName.split('.').pop();
    var uuid = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    return userId + '/' + category + '/' + uuid + '.' + ext;
  }

  /**
   * Upload a file to Supabase Storage.
   *
   * @param   {string} bucket - Storage bucket name
   * @param   {File}   file   - File to upload
   * @param   {string} path   - Destination path (use sbStoragePath to generate)
   * @returns {Promise<string>} The stored path
   * @throws  {Error} If Supabase is unavailable or upload fails
   */
  async function sbUpload(bucket, file, path) {
    if (!sb) throw new Error('Supabase unavailable');
    var result = await sb.storage.from(bucket).upload(path, file, { upsert: false });
    if (result.error) throw result.error;
    return result.data.path;
  }

  /**
   * Get a permanent public URL for a file in a public bucket.
   *
   * @param   {string}  bucket - Storage bucket name
   * @param   {string}  path   - File path within the bucket
   * @returns {string|null} Public URL, or null if Supabase is unavailable
   */
  function sbPublicUrl(bucket, path) {
    if (!sb) return null;
    return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  /**
   * Create a short-lived signed URL for a private bucket file.
   *
   * @param   {string}  bucket     - Storage bucket name (e.g. 'files')
   * @param   {string}  path       - File path within the bucket
   * @param   {number}  [expiresIn=60] - Seconds until the URL expires
   * @returns {Promise<string|null>} Signed URL, or null on failure
   */
  async function sbSignedUrl(bucket, path, expiresIn) {
    if (!sb) return null;
    expiresIn = expiresIn || 60;
    var result = await sb.storage.from(bucket).createSignedUrl(path, expiresIn);
    return result.data ? result.data.signedUrl : null;
  }

  /**
   * Delete one or more files from a Storage bucket.
   *
   * @param   {string}          bucket - Storage bucket name
   * @param   {string|string[]} paths  - Single path or array of paths
   * @returns {Promise<void>}
   * @throws  {Error} If Supabase is unavailable or deletion fails
   */
  async function sbDelete(bucket, paths) {
    if (!sb) throw new Error('Supabase unavailable');
    if (!paths || paths.length === 0) return;
    var result = await sb.storage.from(bucket).remove([].concat(paths));
    if (result.error) throw result.error;
  }

  // =========================================================================
  // HTML sanitisation
  // =========================================================================

  /**
   * Escape HTML entities to prevent XSS.
   * Escapes: & < > " '
   *
   * @param   {*} str - Value to escape (coerced to string)
   * @returns {string} HTML-safe string
   */
  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // =========================================================================
  // User cache (separate from createCache — needs auth-aware invalidation)
  // =========================================================================

  /** @type {object|null} */
  var _cachedUser = null;

  /** @type {number} */
  var _cachedUserTs = 0;

  /**
   * Get the currently authenticated Supabase user, cached for 2 minutes.
   *
   * @returns {Promise<object|null>} Supabase User object, or null if unauthenticated
   */
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

  // =========================================================================
  // Auth state listener — emits events instead of calling window callbacks
  // =========================================================================

  if (sb) {
    sb.auth.onAuthStateChange(function(event) {
      if (event === 'SIGNED_IN') {
        _cachedUser = null;
        _cachedUserTs = 0;
        if (typeof window.EventBus !== 'undefined') {
          window.EventBus.emit('auth:login');
        }
      }
      if (event === 'SIGNED_OUT') {
        window._isLoggedIn = false;
        _cachedUser = null;
        _cachedUserTs = 0;

        // Reset lock-button icon
        var lockBtn = document.getElementById('btnLock');
        if (lockBtn) {
          lockBtn.innerHTML = '<svg viewBox="0 0 24 24" class="nav-icon nav-icon-sys"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
          lockBtn.title = '登录';
        }

        // Hide admin-only elements
        var adminBadge = document.getElementById('adminBadge');
        if (adminBadge) adminBadge.style.display = 'none';

        var adminOnly = document.querySelectorAll('.admin-only');
        for (var i = 0; i < adminOnly.length; i++) {
          adminOnly[i].style.display = 'none';
        }

        if (typeof window.EventBus !== 'undefined') {
          window.EventBus.emit('auth:logout');
        }
      }
    });
  }

  // =========================================================================
  // Loading indicator
  // =========================================================================

  var _loadingToast = null;

  /**
   * Show a top-of-screen loading indicator.
   * @param {string} msg - Message text
   */
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

  /** Hide the loading indicator. */
  function hideLoading() {
    if (_loadingToast) _loadingToast.style.display = 'none';
  }

  // =========================================================================
  // Toast notification
  // =========================================================================

  var _toastTimer = null;

  /**
   * Display a transient toast notification.
   *
   * @param {string} msg  - Message text
   * @param {'success'|'error'|'warn'} [type='success'] - Controls background color
   */
  function showToast(msg, type) {
    var t = document.getElementById('toastMsg');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toastMsg';
      t.style.cssText =
        'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:9999;' +
        'padding:10px 24px;border-radius:20px;font-size:13px;pointer-events:none;' +
        'transition:opacity 0.3s;opacity:0;';
      document.body.appendChild(t);
    }

    var bg = type === 'error'
      ? 'rgba(255,60,60,0.85)'
      : type === 'warn'
        ? 'rgba(255,180,60,0.85)'
        : 'rgba(100,200,120,0.85)';

    t.style.background = bg;
    t.style.color = '#fff';
    t.textContent = msg;
    t.style.opacity = '1';

    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function() { t.style.opacity = '0'; }, 2500);
  }

  // =========================================================================
  // IndexedDB bulk-write helper
  // =========================================================================

  /**
   * Persist an array of entries into a named IndexedDB object store.
   * Creates the store if it doesn't exist.
   *
   * @param {string}   storeName - Object store name
   * @param {object[]} entries   - Records to insert (each must have an `id` or
   *                               auto-increment key)
   * @returns {Promise<void>}
   */
  async function saveToLocalDB(storeName, entries) {
    var db = null;
    try {
      db = await new Promise(function(res, rej) {
        var req = indexedDB.open(window.DB_NAME || 'PersonalSiteDB', window.DB_VERSION || 1);
        req.onupgradeneeded = function(e) {
          if (!e.target.result.objectStoreNames.contains(storeName)) {
            e.target.result.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = function(e) { res(e.target.result); };
        req.onerror = function() { rej(req.error); };
      });

      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        db = await new Promise(function(res, rej) {
          var req = indexedDB.open(window.DB_NAME || 'PersonalSiteDB', (window.DB_VERSION || 1) + 1);
          req.onupgradeneeded = function(e) {
            if (!e.target.result.objectStoreNames.contains(storeName)) {
              e.target.result.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
            }
          };
          req.onsuccess = function(e) { res(e.target.result); };
          req.onerror = function() { rej(req.error); };
        });
      }

      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      for (var i = 0; i < entries.length; i++) {
        store.add(entries[i]);
      }
      await new Promise(function(res, rej) {
        tx.oncomplete = res;
        tx.onerror = function() { rej(tx.error); };
      });
    } finally {
      if (db) db.close();
    }
  }

  // =========================================================================
  // window exports
  // =========================================================================

  /** @type {import('@supabase/supabase-js').SupabaseClient|null} */
  window.sb = sb;

  /** @type {typeof sbStoragePath} */
  window.sbStoragePath = sbStoragePath;

  /** @type {typeof sbUpload} */
  window.sbUpload = sbUpload;

  /** @type {typeof sbPublicUrl} */
  window.sbPublicUrl = sbPublicUrl;

  /** @type {typeof sbSignedUrl} */
  window.sbSignedUrl = sbSignedUrl;

  /** @type {typeof sbDelete} */
  window.sbDelete = sbDelete;

  /** @type {typeof escHtml} */
  window.escHtml = escHtml;

  /** @type {typeof getCachedUser} */
  window.getCachedUser = getCachedUser;

  /** @type {typeof showLoading} */
  window.showLoading = showLoading;

  /** @type {typeof hideLoading} */
  window.hideLoading = hideLoading;

  /** @type {typeof showToast} */
  window.showToast = showToast;

  /** @type {typeof saveToLocalDB} */
  window.saveToLocalDB = saveToLocalDB;
})();
