// ==================== Wallpaper System ====================
(function() {
  var DEFAULT_WALLPAPERS = [
    { name: '壁纸 1', path: 'wallpapers/1.jpg' },
    { name: '壁纸 2', path: 'wallpapers/2.jpg' },
    { name: '壁纸 3', path: 'wallpapers/3.jpg' },
    { name: '壁纸 4', path: 'wallpapers/4.jpg' },
    { name: '壁纸 5', path: 'wallpapers/5.jpg' },
    { name: '壁纸 6', path: 'wallpapers/6.jpg' },
  ];
  var currentWallpaper = parseInt(localStorage.getItem('wallpaperIdx') || '0');
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
      var req = indexedDB.open('PersonalSiteDB', 1);
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
      var delBtn = !wp.isDefault ? '<span class="delete-custom" onclick="event.stopPropagation();window.removeCustomWallpaper(' + wp.id + ')">✕</span>' : '';
      return '<div class="wp-dot' + (i === currentWallpaper ? ' active' : '') + (!wp.isDefault ? ' custom' : '') + '"' +
        ' style="background:' + wp.value + ';background-size:cover;background-position:center;"' +
        ' title="' + escHtml(wp.name) + '" onclick="window.applyWallpaper(' + i + ')">' + delBtn + '</div>';
    }).join('');

    picker.innerHTML = dots + '<div class="wp-upload-btn" onclick="window.triggerWallpaperUpload()" title="上传自定义壁纸">+</div>';

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
      // 已登录 → 上传到 Supabase
      showLoading('上传壁纸中...');
      try {
        for (var j = 0; j < imgFiles.length; j++) {
          var file = imgFiles[j];
          var path = sbStoragePath(user.id, 'wallpaper', file.name);
          await sbUpload('wallpapers', file, path);
          await window.sb.from('user_files').insert({
            user_id: user.id, category: 'wallpaper',
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
    } else {
      // 未登录 → 暂存 IndexedDB
      await _saveWallpapersToLocalDB(imgFiles);
      uploaded = imgFiles.length;
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
    var db = null;
    try {
      db = await new Promise(function(res, rej) {
        var req = indexedDB.open('PersonalSiteDB', 1);
        req.onupgradeneeded = function(e) {
          if (!e.target.result.objectStoreNames.contains('wallpapers')) {
            e.target.result.createObjectStore('wallpapers', { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = function(e) { res(e.target.result); };
        req.onerror = function() { rej(req.error); };
      });
      if (!db.objectStoreNames.contains('wallpapers')) {
        db.close();
        db = await new Promise(function(res, rej) {
          var req = indexedDB.open('PersonalSiteDB', 2);
          req.onupgradeneeded = function(e) {
            if (!e.target.result.objectStoreNames.contains('wallpapers')) {
              e.target.result.createObjectStore('wallpapers', { keyPath: 'id', autoIncrement: true });
            }
          };
          req.onsuccess = function(e) { res(e.target.result); };
          req.onerror = function() { rej(req.error); };
        });
      }
      var tx = db.transaction('wallpapers', 'readwrite');
      var store = tx.objectStore('wallpapers');
      for (var k = 0; k < imgFiles.length; k++) {
        var f = imgFiles[k];
        var buf = await f.arrayBuffer();
        store.add({ name: f.name, data: buf, size: f.size, type: f.type, addedAt: Date.now() });
      }
      await new Promise(function(res, rej) {
        tx.oncomplete = res;
        tx.onerror = function() { rej(tx.error); };
      });
      showToast('已保存本地（登录后可云端迁移上传）', 'success');
    } catch (e) {
      showToast('保存失败: ' + e.message, 'error');
    } finally {
      hideLoading();
      if (db) db.close();
    }
  }

  async function removeCustomWallpaper(id) {
    if (!window.sb) return;
    try {
      var result = await window.sb.from('user_files').select('storage_path').eq('id', id).single();
      if (result.data) {
        await sbDelete('wallpapers', result.data.storage_path);
        await window.sb.from('user_files').delete().eq('id', id);
      }
    } catch (e) { return; }

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

  Object.defineProperty(window, 'currentWallpaper', {
    get: function() { return currentWallpaper; },
    set: function(v) { currentWallpaper = v; }
  });
})();
