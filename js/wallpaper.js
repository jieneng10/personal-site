// ==================== Wallpaper System ====================
(function() {
  /** @type {{ name: string, path: string }[]} */
  var DEFAULT_WALLPAPERS = [
    { name: '壁纸 1', path: 'wallpapers/1.webp' },
    { name: '壁纸 2', path: 'wallpapers/2.webp' },
    { name: '壁纸 3', path: 'wallpapers/3.webp' },
    { name: '壁纸 4', path: 'wallpapers/4.webp' },
    { name: '壁纸 5', path: 'wallpapers/5.webp' },
    { name: '壁纸 6', path: 'wallpapers/6.webp' },
  ];

  var currentWallpaper = parseInt(localStorage.getItem('wallpaperIdx') || '2');
  var _wallpaperGen = 0; // race-condition guard (applyWallpaper)
  var _wallpaperDotsGen = 0; // race-condition guard (renderWallpaperDots)
  var _wpLastTouchTime = 0; // B-12: 防止 touchend → click 双重触发

  // ---- Data-fetching layer (wrapped by createCache) ----

  /**
   * @typedef {object} WallpaperItem
   * @property {string|number} id
   * @property {string}        name
   * @property {string}        value  - CSS `url(...)` value
   * @property {boolean}       [isDefault]
   */

  /**
   * Fetch all wallpaper items from all sources.
   * Order: defaults → Supabase cloud → IndexedDB local
   * @returns {Promise<WallpaperItem[]>}
   */
  async function _fetchAllWallpapers() {
    var defaults = DEFAULT_WALLPAPERS.map(function(d, i) {
      return { id: 'default_' + i, name: d.name, value: 'url(' + d.path + ')', isDefault: true };
    });

    var cloudItems = [];
    var localItems = [];

    // Supabase cloud (RLS auto-filters by user)
    if (window.sb) {
      try {
        var result = await window.sb
          .from('user_files')
          .select('*')
          .eq('category', 'wallpaper')
          .eq('published', true)
          .order('created_at');
        cloudItems = (result.data || []).map(function(c) {
          return {
            id: c.id,
            name: c.name,
            value: 'url(' + sbPublicUrl('wallpapers', c.storage_path) + ')',
          };
        });
      } catch (e) { /* cloud unavailable — skip */ }
    }

    // IndexedDB local (unmigrated data)
    try {
      localItems = await _readLocalWallpapers();
    } catch (e) { /* local read failed — skip */ }

    return defaults.concat(cloudItems).concat(localItems);
  }

  /** 10-minute cache for wallpaper list */
  var _wallpaperCache = window.createCache
    ? window.createCache(_fetchAllWallpapers, 600000)
    : null;

  /**
   * Get all available wallpaper items (cached).
   * @returns {Promise<WallpaperItem[]>}
   */
  async function getAllWallpapers() {
    if (_wallpaperCache) return _wallpaperCache.get();
    return _fetchAllWallpapers();
  }

  function invalidateWallpaperCache() {
    if (_wallpaperCache) _wallpaperCache.invalidate();
  }

  // ---- IndexedDB helpers (local-only wallpapers) ----

  async function _readLocalWallpapers() {
    var db = await new Promise(function(res, rej) {
      var req = indexedDB.open(window.DB_NAME || 'PersonalSiteDB', window.DB_VERSION || 1);
      req.onsuccess = function(e) { res(e.target.result); };
      req.onerror = function() { rej(req.error); };
    });
    if (!db.objectStoreNames.contains('wallpapers')) { db.close(); return []; }
    var rows = await new Promise(function(res, rej) {
      try {
        var tx = db.transaction('wallpapers', 'readonly');
        var req = tx.objectStore('wallpapers').getAll();
        req.onsuccess = function() { res(req.result || []); };
        req.onerror = function() { rej(req.error); };
      } catch (e) { res([]); }
    });
    db.close();
    return rows.map(function(r) {
      var url = r.dataUrl || (r.data ? URL.createObjectURL(new Blob([r.data], { type: r.type || 'image/png' })) : '');
      return { id: 'local_wp_' + (r.id || r.addedAt), name: r.name, value: 'url(' + url + ')', isDefault: false };
    });
  }

  async function _deleteLocalWallpaper(id) {
    var db = await new Promise(function(res, rej) {
      var req = indexedDB.open(window.DB_NAME || 'PersonalSiteDB', window.DB_VERSION || 1);
      req.onsuccess = function(e) { res(e.target.result); };
      req.onerror = function() { rej(req.error); };
    });
    if (!db.objectStoreNames.contains('wallpapers')) { db.close(); return; }
    var tx = db.transaction('wallpapers', 'readwrite');
    tx.objectStore('wallpapers').delete(id);
    await new Promise(function(res, rej) {
      tx.oncomplete = res; tx.onerror = function() { rej(tx.error); };
    });
    db.close();
  }

  // =========================================================================
  // Apply wallpaper to body background
  // =========================================================================

  /**
   * Transition the body background to the wallpaper at `idx`.
   * Desktop: dual-layer crossfade (bgLayer → body) with 850ms delay.
   * Mobile / instant: immediate swap.
   *
   * @param {number}  idx     - Index into the wallpaper list
   * @param {boolean} [instant] - Skip the crossfade animation
   * @returns {Promise<void>}
   */
  async function applyWallpaper(idx, instant) {
    currentWallpaper = idx;
    var gen = ++_wallpaperGen;
    var items = await getAllWallpapers();
    if (gen !== _wallpaperGen) return;
    if (!items || items.length === 0) {
      document.body.style.backgroundImage = 'none';
      var bgLayer0 = document.getElementById('bgLayer');
      if (bgLayer0) bgLayer0.style.opacity = '0';
      return;
    }
    if (idx >= items.length) currentWallpaper = 0;
    var wp = items[currentWallpaper];
    var url = wp.value.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    var bgLayer = document.getElementById('bgLayer');
    var isMobile = window.innerWidth < 540;

    if (isMobile || instant || !url) {
      if (gen !== _wallpaperGen) return;
      if (url && !instant) {
        var preload = new Image();
        preload.onload = function() {
          if (gen !== _wallpaperGen) return;
          document.body.style.backgroundImage = wp.value;
        };
        preload.src = url;
      } else {
        document.body.style.backgroundImage = wp.value;
      }
      if (bgLayer) bgLayer.style.opacity = '0';
    } else if (url) {
      var img = new Image();
      img.onload = function() {
        if (gen !== _wallpaperGen) return;
        if (bgLayer) {
          bgLayer.style.backgroundImage = wp.value;
          bgLayer.style.opacity = '1';
        }
        setTimeout(function() {
          if (gen !== _wallpaperGen) return;
          document.body.style.backgroundImage = wp.value;
          requestAnimationFrame(function() {
            requestAnimationFrame(function() {
              if (gen !== _wallpaperGen) return;
              if (bgLayer) bgLayer.style.opacity = '0';
            });
          });
        }, 850);
      };
      img.src = url;
      setTimeout(function() {
        if (!img.complete) {
          if (gen !== _wallpaperGen) return;
          document.body.style.backgroundImage = wp.value;
          if (bgLayer) bgLayer.style.opacity = '0';
        }
      }, 1500);
    }

    window.safeSetItem('wallpaperIdx', currentWallpaper);
    if (gen === _wallpaperGen) renderWallpaperDots();
  }

  /**
   * Render the wallpaper picker dots at the bottom-left.
   * Reads from cache internally — no need to pass items.
   */
  async function renderWallpaperDots() {
    var gen = ++_wallpaperDotsGen;
    var picker = document.getElementById('wallpaperPicker');
    var items = await getAllWallpapers();
    if (gen !== _wallpaperDotsGen) return; // B-5: 竞态守卫，快速连切时放弃过期渲染

    var dots = items.map(function(wp, i) {
      var delBtn = !wp.isDefault ? '<span class="delete-custom" data-remove-wp-id="' + wp.id + '">✕</span>' : '';
      return '<div class="wp-dot' + (i === currentWallpaper ? ' active' : '') + (!wp.isDefault ? ' custom' : '') + '"' +
        ' style="background:' + wp.value + ';background-size:cover;background-position:center;"' +
        ' title="' + escHtml(wp.name) + '" data-wp-idx="' + i + '">' + delBtn + '</div>';
    }).join('');

    picker.innerHTML = dots + '<div class="wp-upload-btn" id="wpUploadBtn" title="上传自定义壁纸">+</div>';

    // Preload adjacent wallpapers
    var next = currentWallpaper + 1 < items.length ? currentWallpaper + 1 : 0;
    var prev = currentWallpaper - 1 >= 0 ? currentWallpaper - 1 : items.length - 1;
    [next, prev].forEach(function(i) {
      var u = items[i].value.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
      if (u) { var pre = new Image(); pre.src = u; }
    });
  }

  function triggerWallpaperUpload() {
    document.getElementById('wallpaperInput').click();
  }

  // =========================================================================
  // Upload custom wallpapers
  // =========================================================================

  /**
   * Add one or more custom wallpaper image files.
   * Logged-in users → Supabase (published); guests → Supabase (pending review)
   * or IndexedDB as fallback.
   *
   * @param {FileList} fileList
   * @returns {Promise<void>}
   */
  async function addCustomWallpapers(fileList) {
    var imgFiles = [];
    for (var i = 0; i < fileList.length; i++) {
      if (fileList[i].type.startsWith('image/')) imgFiles.push(fileList[i]);
    }
    if (imgFiles.length === 0) return;

    var user = null;
    if (window.sb && window._isLoggedIn) {
      user = await getCachedUser();
    }

    var items = await getAllWallpapers();
    var uploaded = 0;

    if (user) {
      showLoading('上传壁纸中...');
      try {
        for (var j = 0; j < imgFiles.length; j++) {
          var file = imgFiles[j];
          var path = sbStoragePath(user.id, 'wallpaper', file.name);
          await sbUpload('wallpapers', file, path);
          await window.sb.from('user_files').insert({
            user_id: user.id, category: 'wallpaper', published: true,
            name: file.name, size: file.size, mime_type: file.type, storage_path: path,
          });
          uploaded++;
        }
        showToast('已上传 ' + uploaded + ' 张到云端', 'success');
      } catch (e) {
        showToast('云端上传失败: ' + (e.message || '请检查网络'), 'error');
        await _saveWallpapersToLocalDB(imgFiles);
        uploaded = imgFiles.length;
      } finally { hideLoading(); }
    } else if (window.sb) {
      showLoading('上传壁纸中...');
      try {
        for (var k = 0; k < imgFiles.length; k++) {
          var gf = imgFiles[k];
          var gpath = 'guest/' + Date.now().toString(36) + '_' + gf.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          await sbUpload('wallpapers', gf, gpath);
          await window.sb.from('user_files').insert({
            category: 'wallpaper', published: false,
            name: gf.name, size: gf.size, mime_type: gf.type, storage_path: gpath,
          });
          uploaded++;
        }
        showToast('已上传 ' + uploaded + ' 张，等待管理员审核通过后可见', 'success');
      } catch (e) {
        await _saveWallpapersToLocalDB(imgFiles);
        uploaded = imgFiles.length;
        showToast('壁纸已保存到本地。登录后可云端同步，跨设备访问。', 'success');
      } finally { hideLoading(); }
    } else {
      await _saveWallpapersToLocalDB(imgFiles);
      uploaded = imgFiles.length;
      showToast('壁纸已保存到本地。登录后可云端同步，跨设备访问。', 'success');
    }

    if (uploaded > 0) {
      invalidateWallpaperCache();
      // B-6: 缓存失效后重新拉取，用最新数据算索引，避免旧 items.length
      var freshItems = await getAllWallpapers();
      currentWallpaper = freshItems.length - 1;
      window.safeSetItem('wallpaperIdx', currentWallpaper);
      applyWallpaper(currentWallpaper);
    }
  }

  async function _saveWallpapersToLocalDB(imgFiles) {
    showLoading('保存到本地...');
    try {
      var entries = [];
      for (var k = 0; k < imgFiles.length; k++) {
        var f = imgFiles[k];
        var buf = await f.arrayBuffer();
        entries.push({ name: f.name, data: buf, size: f.size, type: f.type, addedAt: Date.now() });
      }
      await saveToLocalDB('wallpapers', entries);
      showToast('已保存本地（登录后可云端迁移上传）', 'success');
    } catch (e) {
      showToast('保存失败: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  }

  // =========================================================================
  // Remove wallpaper
  // =========================================================================

  /**
   * Remove a custom wallpaper by id.
   * Handles both cloud (Supabase) and local (IndexedDB) deletion.
   * @param {string|number} id
   * @returns {Promise<void>}
   */
  async function removeCustomWallpaper(id) {
    if (typeof id === 'string') {
      await _deleteLocalWallpaper(id);
    } else if (window.sb) {
      try {
        var result = await window.sb.from('user_files').select('storage_path').eq('id', id).single();
        if (result.data) {
          await sbDelete('wallpapers', result.data.storage_path);
          await window.sb.from('user_files').delete().eq('id', id);
        }
      } catch (e) { return; }
    } else { return; }

    invalidateWallpaperCache();
    var items = await getAllWallpapers();
    if (currentWallpaper >= items.length) currentWallpaper = Math.max(0, items.length - 1);
    window.safeSetItem('wallpaperIdx', currentWallpaper);
    applyWallpaper(currentWallpaper);
  }

  // =========================================================================
  // Avatar
  // =========================================================================

  /**
   * Load the user's avatar from Supabase and apply it to the profile ring.
   * Falls back to the default avatar if not logged in or no avatar set.
   * @returns {Promise<void>}
   */
  async function applyAvatar() {
    var avatarEl = document.getElementById('avatarDisplay');
    var defaultUrl = 'images/default-avatar.png';

    if (!window.sb) {
      avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
      avatarEl.textContent = '';
      return;
    }

    try {
      var user = await getCachedUser();
      if (!user) {
        avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
        avatarEl.textContent = '';
        return;
      }

      var result = await window.sb.from('avatars').select('storage_path').eq('user_id', user.id);
      if (result.data && result.data.length > 0) {
        avatarEl.style.backgroundImage = 'url(' + sbPublicUrl('avatars', result.data[0].storage_path) + ')';
      } else {
        avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
      }
    } catch (e) {
      avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
    }
    avatarEl.textContent = '';
  }

  /**
   * Upload a new avatar image and persist to Supabase.
   * @param {File} file
   * @returns {Promise<void>}
   */
  async function saveAvatar(file) {
    if (!window.sb) return;
    try {
      var user = await getCachedUser();
      if (!user) return;
      showLoading('上传头像中...');
      try {
        var path = sbStoragePath(user.id, 'avatar', file.name);
        await sbUpload('avatars', file, path);
        await window.sb.from('avatars').upsert({
          user_id: user.id,
          storage_path: path,
          updated_at: new Date(),
        });
      } finally {
        hideLoading();
      }
      applyAvatar();
    } catch (e) {
      showToast('上传失败: ' + e.message, 'error');
    }
  }

  // =========================================================================
  // Event bindings
  // =========================================================================

  function bindWallpaperEvents() {
    document.getElementById('wallpaperInput').addEventListener('change', async function() {
      if (this.files.length > 0) {
        await addCustomWallpapers(this.files);
        this.value = '';
      }
    });

    var picker = document.getElementById('wallpaperPicker');
    var wpDragCounter = 0;

    picker.addEventListener('click', function(e) {
      // B-12: 若刚刚通过触摸手势处理过（300ms 内），忽略后续 click
      if (Date.now() - _wpLastTouchTime < 300) return;

      var delBtn = e.target.closest('.delete-custom[data-remove-wp-id]');
      if (delBtn) {
        e.stopPropagation();
        var $wpDelId = delBtn.getAttribute('data-remove-wp-id');
        removeCustomWallpaper(/^\d+$/.test($wpDelId) ? parseInt($wpDelId) : $wpDelId);
        return;
      }
      if (e.target.closest('#wpUploadBtn')) {
        triggerWallpaperUpload();
        return;
      }
      var dot = e.target.closest('.wp-dot[data-wp-idx]');
      if (dot) {
        applyWallpaper(parseInt(dot.getAttribute('data-wp-idx')));
      }
    });

    picker.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); });
    picker.addEventListener('dragenter', function(e) {
      e.preventDefault(); e.stopPropagation();
      wpDragCounter++;
      picker.classList.add('drag-over');
    });
    picker.addEventListener('dragleave', function(e) {
      e.preventDefault(); e.stopPropagation();
      wpDragCounter--;
      if (wpDragCounter === 0) picker.classList.remove('drag-over');
    });
    picker.addEventListener('drop', async function(e) {
      e.preventDefault(); e.stopPropagation();
      wpDragCounter = 0;
      picker.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        await addCustomWallpapers(e.dataTransfer.files);
      }
    });

    // Avatar
    document.getElementById('avatarRing').addEventListener('click', function() {
      document.getElementById('avatarInput').click();
    });
    document.getElementById('avatarInput').addEventListener('change', async function() {
      var file = this.files[0];
      if (!file) return;
      await saveAvatar(file);
      this.value = '';
    });
  }

  // ---- Listen for cache invalidation from admin panel ----
  if (typeof window.EventBus !== 'undefined') {
    window.EventBus.on('cache:invalidate:wallpaper', function() {
      invalidateWallpaperCache();
    });
  }

  // =========================================================================
  // window exports
  // =========================================================================

  /** @type {typeof DEFAULT_WALLPAPERS} */
  window.DEFAULT_WALLPAPERS = DEFAULT_WALLPAPERS;

  /** @type {typeof getAllWallpapers} */
  window.getAllWallpapers = getAllWallpapers;

  /** @type {typeof applyWallpaper} */
  window.applyWallpaper = applyWallpaper;

  /** @type {typeof renderWallpaperDots} */
  window.renderWallpaperDots = renderWallpaperDots;

  /** @type {typeof triggerWallpaperUpload} */
  window.triggerWallpaperUpload = triggerWallpaperUpload;

  /** @type {typeof addCustomWallpapers} */
  window.addCustomWallpapers = addCustomWallpapers;

  /** @type {typeof removeCustomWallpaper} */
  window.removeCustomWallpaper = removeCustomWallpaper;

  /** @type {typeof applyAvatar} */
  window.applyAvatar = applyAvatar;

  /** @type {typeof saveAvatar} */
  window.saveAvatar = saveAvatar;

  /** @type {typeof bindWallpaperEvents} */
  window.bindWallpaperEvents = bindWallpaperEvents;

  /** @type {typeof invalidateWallpaperCache} */
  window._invalidateWallpaperCache = invalidateWallpaperCache;

  // Mutable state via getter/setter
  Object.defineProperty(window, 'currentWallpaper', {
    get: function() { return currentWallpaper; },
    set: function(v) { currentWallpaper = v; }
  });

  // =========================================================================
  // Mobile swipe-to-switch wallpaper (touch gesture)
  // =========================================================================

  (function() {
    var _touchStartX = 0;
    var _touchStartY = 0;
    var _touchActive = false;
    var _touchSwiping = false;
    var SWIPE_THRESHOLD = 50;

    function isMobile() { return window.innerWidth <= 540; }

    function isInteractingWithUI(target) {
      return target.closest('.sidebar, .content-panel, .modal-overlay:not(.hidden), .wallpaper-picker, .bgm-player, #sakuraCanvas, button, input, textarea, select, a');
    }

    function preloadAdjacent() {
      getAllWallpapers().then(function(items) {
        if (!items || items.length < 2) return;
        var next = currentWallpaper + 1 < items.length ? currentWallpaper + 1 : 0;
        var prev = currentWallpaper - 1 >= 0 ? currentWallpaper - 1 : items.length - 1;
        [next, prev].forEach(function(i) {
          var u = items[i].value.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
          if (u) { var img = new Image(); img.src = u; }
        });
      });
    }

    function swipeTransition(targetIdx, items) {
      var wp = items[targetIdx];
      var url = wp.value.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
      var bgLayer = document.getElementById('bgLayer');

      var prev = currentWallpaper;
      currentWallpaper = targetIdx;
      window.safeSetItem('wallpaperIdx', currentWallpaper);
      renderWallpaperDots();

      if (!url || !bgLayer) {
        document.body.style.backgroundImage = wp.value || '';
        preloadAdjacent();
        return;
      }

      var gen = ++_wallpaperGen;
      var img = new Image();
      img.onload = function() {
        if (gen !== _wallpaperGen) return;
        bgLayer.style.backgroundImage = wp.value;
        bgLayer.style.transition = 'opacity 0.45s ease';
        bgLayer.style.opacity = '1';

        setTimeout(function() {
          if (gen !== _wallpaperGen) return;
          document.body.style.backgroundImage = wp.value;
          bgLayer.style.transition = 'opacity 0.8s ease-in-out';
          bgLayer.style.opacity = '0';
        }, 500);
      };
      img.src = url;
      setTimeout(function() {
        if (!img.complete && gen === _wallpaperGen) {
          document.body.style.backgroundImage = wp.value;
          bgLayer.style.opacity = '0';
        }
      }, 2000);

      preloadAdjacent();
    }

    document.addEventListener('touchstart', function(e) {
      if (!isMobile() || e.touches.length !== 1) return;
      if (isInteractingWithUI(e.target)) return;
      _touchStartX = e.touches[0].clientX;
      _touchStartY = e.touches[0].clientY;
      _touchActive = true;
      _touchSwiping = false;
      preloadAdjacent();
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      if (!_touchActive) return;
      var dx = e.touches[0].clientX - _touchStartX;
      var dy = e.touches[0].clientY - _touchStartY;

      if (!_touchSwiping) {
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          _touchSwiping = true;
        } else if (Math.abs(dy) > 12) {
          _touchActive = false;
          return;
        } else {
          return;
        }
      }

      e.preventDefault();
      var shift = (dx / window.innerWidth) * 60;
      document.body.style.backgroundPositionX = 'calc(50% - ' + shift + '%)';
    }, { passive: false });

    document.addEventListener('touchend', function(e) {
      if (!_touchActive) return;
      var endX = (e.changedTouches[0] || { clientX: _touchStartX }).clientX;
      var dx = endX - _touchStartX;

      // B-12: 标记触摸处理时间，防止后续 click 事件重复触发
      _wpLastTouchTime = Date.now();

      document.body.style.backgroundPositionX = '';
      var wasSwiping = _touchSwiping;
      _touchActive = false;
      _touchSwiping = false;

      if (!wasSwiping || Math.abs(dx) < SWIPE_THRESHOLD) return;

      getAllWallpapers().then(function(items) {
        if (!items || items.length < 2) return;
        var target;
        if (dx > 0) {
          target = currentWallpaper - 1 >= 0 ? currentWallpaper - 1 : items.length - 1;
        } else {
          target = currentWallpaper + 1 < items.length ? currentWallpaper + 1 : 0;
        }
        swipeTransition(target, items);
      });
    }, { passive: true });

    document.addEventListener('touchcancel', function() {
      document.body.style.backgroundPositionX = '';
      _touchActive = false;
      _touchSwiping = false;
    }, { passive: true });
  })();
})();
