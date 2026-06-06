// ==================== Wallpaper System ====================
(function() {
  var DEFAULT_WALLPAPERS = [
    { name: '壁纸 1', path: 'wallpapers/1.webp' },
    { name: '壁纸 2', path: 'wallpapers/2.webp' },
    { name: '壁纸 3', path: 'wallpapers/3.webp' },
    { name: '壁纸 4', path: 'wallpapers/4.webp' },
    { name: '壁纸 5', path: 'wallpapers/5.webp' },
    { name: '壁纸 6', path: 'wallpapers/6.webp' },
  ];
  var currentWallpaper = parseInt(localStorage.getItem('wallpaperIdx') || '2');
  var _wallpaperCache = { ts: 0, items: null };
  var _wallpaperGen = 0;

  async function getAllWallpapers() {
    var defaults = DEFAULT_WALLPAPERS.map(function(d, i) {
      return { id: 'default_' + i, name: d.name, value: 'url(' + d.path + ')', isDefault: true };
    });

    var cloudItems = [];
    var localItems = [];

    // 从 Supabase 拉取云端壁纸（RLS 自动区分游客/登录者可见范围）
    if (window.sb) {
      if (_wallpaperCache.items && Date.now() - _wallpaperCache.ts < 600000) {
        return _wallpaperCache.items;
      }
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
      } catch (e) { /* 云端失败不阻塞 */ }
    }

    // 从 IndexedDB 读取暂存的本地壁纸
    try {
      localItems = await _readLocalWallpapers();
    } catch (e) { /* 本地读取失败 */ }

    var all = defaults.concat(cloudItems).concat(localItems);
    _wallpaperCache.items = all;
    _wallpaperCache.ts = Date.now();
    return all;
  }

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

  async function applyWallpaper(idx, cachedItems, instant) {
    currentWallpaper = idx;
    var gen = ++_wallpaperGen;
    var items = cachedItems || await getAllWallpapers();
    if (gen !== _wallpaperGen) return;
    if (!items || items.length === 0) {
      document.body.style.backgroundImage = 'none';
      document.getElementById('bgLayer').style.opacity = '0';
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

    localStorage.setItem('wallpaperIdx', currentWallpaper);
    if (gen === _wallpaperGen) renderWallpaperDots(items);
  }

  function renderWallpaperDots(cachedItems) {
    var picker = document.getElementById('wallpaperPicker');
    if (!cachedItems) {
      getAllWallpapers().then(function(items) { renderWallpaperDots(items); });
      return;
    }

    var dots = cachedItems.map(function(wp, i) {
      var delBtn = !wp.isDefault ? '<span class="delete-custom" data-remove-wp-id="' + wp.id + '">✕</span>' : '';
      return '<div class="wp-dot' + (i === currentWallpaper ? ' active' : '') + (!wp.isDefault ? ' custom' : '') + '"' +
        ' style="background:' + wp.value + ';background-size:cover;background-position:center;"' +
        ' title="' + escHtml(wp.name) + '" data-wp-idx="' + i + '">' + delBtn + '</div>';
    }).join('');

    picker.innerHTML = dots + '<div class="wp-upload-btn" id="wpUploadBtn" title="上传自定义壁纸">+</div>';

    var next = currentWallpaper + 1 < cachedItems.length ? currentWallpaper + 1 : 0;
    var prev = currentWallpaper - 1 >= 0 ? currentWallpaper - 1 : cachedItems.length - 1;
    [next, prev].forEach(function(i) {
      var u = cachedItems[i].value.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
      if (u) { var pre = new Image(); pre.src = u; }
    });
  }

  function triggerWallpaperUpload() {
    document.getElementById('wallpaperInput').click();
  }

  async function addCustomWallpapers(fileList) {
    // 收集有效图片文件
    var imgFiles = [];
    for (var i = 0; i < fileList.length; i++) {
      if (fileList[i].type.startsWith('image/')) imgFiles.push(fileList[i]);
    }
    if (imgFiles.length === 0) return;

    // 尝试获取登录用户
    var user = null;
    if (window.sb && window._isLoggedIn) {
      user = await getCachedUser();
    }

    var items = await getAllWallpapers();
    var uploaded = 0;

    if (user) {
      // 已登录 → 上传到 Supabase（直接发布）
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
        // 失败时存本地防丢失
        await _saveWallpapersToLocalDB(imgFiles);
        uploaded = imgFiles.length;
      } finally { hideLoading(); }
    } else if (window.sb) {
      // 游客 → 上传到 Supabase（待审核）
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
        // 游客云端上传失败 → 暂存 IndexedDB 防丢失
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
      _wallpaperCache.items = null;
      currentWallpaper = items.length + uploaded - 1;
      localStorage.setItem('wallpaperIdx', currentWallpaper);
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

  async function removeCustomWallpaper(id) {
    if (typeof id === 'string') {
      // Local IndexedDB wallpaper
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

    _wallpaperCache.items = null;
    var items = await getAllWallpapers();
    if (currentWallpaper >= items.length) currentWallpaper = Math.max(0, items.length - 1);
    localStorage.setItem('wallpaperIdx', currentWallpaper);
    applyWallpaper(currentWallpaper);
  }

  // ---- Avatar ----
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

      var result = await window.sb.from('avatars').select('storage_path').eq('user_id', user.id).single();
      if (result.data) {
        avatarEl.style.backgroundImage = 'url(' + sbPublicUrl('avatars', result.data.storage_path) + ')';
      } else {
        avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
      }
    } catch (e) {
      avatarEl.style.backgroundImage = 'url(' + defaultUrl + ')';
    }
    avatarEl.textContent = '';
  }

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

  function bindWallpaperEvents() {
    document.getElementById('wallpaperInput').addEventListener('change', async function() {
      if (this.files.length > 0) {
        await addCustomWallpapers(this.files);
        this.value = '';
      }
    });

    var picker = document.getElementById('wallpaperPicker');
    var wpDragCounter = 0;

    // Wallpaper picker event delegation (clicks on dots and delete buttons)
    picker.addEventListener('click', function(e) {
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

    // Avatar upload
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

  window.DEFAULT_WALLPAPERS = DEFAULT_WALLPAPERS;
  window.getAllWallpapers = getAllWallpapers;
  window.applyWallpaper = applyWallpaper;
  window.renderWallpaperDots = renderWallpaperDots;
  window.triggerWallpaperUpload = triggerWallpaperUpload;
  window.addCustomWallpapers = addCustomWallpapers;
  window.removeCustomWallpaper = removeCustomWallpaper;
  window.applyAvatar = applyAvatar;
  window.saveAvatar = saveAvatar;
  window.bindWallpaperEvents = bindWallpaperEvents;
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

  window._invalidateWallpaperCache = function() { _wallpaperCache = { ts: 0, items: null }; };

  Object.defineProperty(window, 'currentWallpaper', {
    get: function() { return currentWallpaper; },
    set: function(v) { currentWallpaper = v; }
  });

  // ======== Mobile Swipe-to-Switch Wallpaper ========
  (function() {
    var _touchStartX = 0;
    var _touchStartY = 0;
    var _touchActive = false;
    var _touchSwiping = false;
    var SWIPE_THRESHOLD = 50;

    function isMobile() {
      return window.innerWidth <= 540;
    }

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

      // Update state immediately (dots reflect change)
      var prev = currentWallpaper;
      currentWallpaper = targetIdx;
      localStorage.setItem('wallpaperIdx', currentWallpaper);
      renderWallpaperDots(items);

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
      // Fallback: if image hangs, swap directly
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
        // Require clear horizontal intent before taking over
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
      // Visual: shift background with finger
      var shift = (dx / window.innerWidth) * 60;
      document.body.style.backgroundPositionX = 'calc(50% - ' + shift + '%)';
    }, { passive: false });

    document.addEventListener('touchend', function(e) {
      if (!_touchActive) return;
      var endX = (e.changedTouches[0] || { clientX: _touchStartX }).clientX;
      var dx = endX - _touchStartX;

      document.body.style.backgroundPositionX = '';
      var wasSwiping = _touchSwiping;
      _touchActive = false;
      _touchSwiping = false;

      if (!wasSwiping || Math.abs(dx) < SWIPE_THRESHOLD) return;

      getAllWallpapers().then(function(items) {
        if (!items || items.length < 2) return;
        var target;
        if (dx > 0) {
          // Swipe right → previous
          target = currentWallpaper - 1 >= 0 ? currentWallpaper - 1 : items.length - 1;
        } else {
          // Swipe left → next
          target = currentWallpaper + 1 < items.length ? currentWallpaper + 1 : 0;
        }
        swipeTransition(target, items);
      });
    }, { passive: true });

    // Reset touch state if cancelled (e.g. browser gesture)
    document.addEventListener('touchcancel', function() {
      document.body.style.backgroundPositionX = '';
      _touchActive = false;
      _touchSwiping = false;
    }, { passive: true });
  })();
})();
