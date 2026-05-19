// ==================== Wallpaper System ====================
var DEFAULT_WALLPAPERS = [
  { name: '壁纸 1', path: 'wallpapers/1.jpg' },
  { name: '壁纸 2', path: 'wallpapers/2.jpg' },
  { name: '壁纸 3', path: 'wallpapers/3.jpg' },
];
var currentWallpaper = parseInt(localStorage.getItem('wallpaperIdx') || '0');
var _wallpaperCache = { ts: 0, items: null };
var _wallpaperGen = 0;  // 防止快速切换时旧回调覆盖新壁纸

async function getAllWallpapers() {
  var defaults = DEFAULT_WALLPAPERS.map(function(d, i) {
    return { id: 'default_' + i, name: d.name, value: 'url(' + d.path + ')', isDefault: true };
  });

  if (!sb || !_isLoggedIn) return defaults;

  // 10 分钟缓存（壁纸列表很少变）—— 先查缓存再鉴权
  if (_wallpaperCache.items && Date.now() - _wallpaperCache.ts < 600000) {
    return _wallpaperCache.items;
  }

  try {
    var user = await getCachedUser();
    if (!user) return defaults;

    var result = await sb
      .from('user_files')
      .select('*')
      .eq('user_id', user.id)
      .eq('category', 'wallpaper')
      .order('created_at');

    var customs = result.data || [];
    var customItems = customs.map(function(c) {
      return {
        id: c.id,
        name: c.name,
        value: 'url(' + sbPublicUrl('wallpapers', c.storage_path) + ')',
      };
    });

    _wallpaperCache.items = defaults.concat(customItems);
    _wallpaperCache.ts = Date.now();
    return _wallpaperCache.items;
  } catch (e) {
    return defaults;
  }
}

async function applyWallpaper(idx, cachedItems, instant) {
  currentWallpaper = idx;
  var gen = ++_wallpaperGen;  // 本次切换的 generation
  var items = cachedItems || await getAllWallpapers();
  // 等待期间可能有更新的切换已启动，检查 generation
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

  if (instant || !url) {
    if (gen !== _wallpaperGen) return;
    document.body.style.backgroundImage = wp.value;
    if (bgLayer) bgLayer.style.opacity = '0';
  } else if (url) {
    var img = new Image();
    img.onload = function() {
      if (gen !== _wallpaperGen) return;  // 已有更新的切换，放弃本次
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
    var delBtn = !wp.isDefault ? '<span class="delete-custom" onclick="event.stopPropagation();removeCustomWallpaper(' + wp.id + ')">✕</span>' : '';
    return '<div class="wp-dot' + (i === currentWallpaper ? ' active' : '') + (!wp.isDefault ? ' custom' : '') + '"' +
      ' style="background:' + wp.value + ';background-size:cover;background-position:center;"' +
      ' title="' + escHtml(wp.name) + '" onclick="applyWallpaper(' + i + ')">' + delBtn + '</div>';
  }).join('');

  picker.innerHTML = dots + '<div class="wp-upload-btn" onclick="triggerWallpaperUpload()" title="上传自定义壁纸">+</div>';

  // 预取相邻壁纸
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
  if (!sb) return;
  var user = await getCachedUser();
  if (!user) return;

  var items = await getAllWallpapers();
  var uploaded = 0;

  showLoading('上传壁纸中...');
  try {
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      if (!file.type.startsWith('image/')) continue;
      var path = sbStoragePath(user.id, 'wallpaper', file.name);
      await sbUpload('wallpapers', file, path);
      await sb.from('user_files').insert({
        user_id: user.id,
        category: 'wallpaper',
        name: file.name,
        size: file.size,
        mime_type: file.type,
        storage_path: path,
      });
      uploaded++;
    }
  } catch (e) {
    showToast('上传失败: ' + e.message, 'error');
  } finally {
    hideLoading();
  }

  if (uploaded > 0) {
    _wallpaperCache.items = null;
    currentWallpaper = items.length + uploaded - 1;
    localStorage.setItem('wallpaperIdx', currentWallpaper);
    applyWallpaper(currentWallpaper);
  }
}

async function removeCustomWallpaper(id) {
  if (!sb) return;
  try {
    var result = await sb.from('user_files').select('storage_path').eq('id', id).single();
    if (result.data) {
      await sbDelete('wallpapers', result.data.storage_path);
      await sb.from('user_files').delete().eq('id', id);
    }
  } catch (e) { return; }

  _wallpaperCache.items = null;
  var items = await getAllWallpapers();
  // 删除后只需确保索引不越界
  if (currentWallpaper >= items.length) currentWallpaper = Math.max(0, items.length - 1);
  localStorage.setItem('wallpaperIdx', currentWallpaper);
  applyWallpaper(currentWallpaper);
}

// ---- Avatar ----
async function applyAvatar() {
  var avatarEl = document.getElementById('avatarDisplay');
  var defaultUrl = 'images/default-avatar.png';

  if (!sb) {
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

    var result = await sb.from('avatars').select('storage_path').eq('user_id', user.id).single();
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
  if (!sb) return;
  try {
    var user = await getCachedUser();
    if (!user) return;
    showLoading('上传头像中...');
    try {
      var path = sbStoragePath(user.id, 'avatar', file.name);
      await sbUpload('avatars', file, path);
      await sb.from('avatars').upsert({
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

// ---- Event bindings ----
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
