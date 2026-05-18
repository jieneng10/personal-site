// ==================== Wallpaper System ====================
var DEFAULT_WALLPAPERS = [
  { name: '壁纸 1', path: 'wallpapers/1.jpg' },
  { name: '壁纸 2', path: 'wallpapers/2.jpg' },
  { name: '壁纸 3', path: 'wallpapers/3.jpg' },
];
var currentWallpaper = parseInt(localStorage.getItem('wallpaperIdx') || '0');
var _wallpaperCache = { ts: 0, items: null };

async function getAllWallpapers() {
  var defaults = DEFAULT_WALLPAPERS.map(function(d, i) {
    return { id: 'default_' + i, name: d.name, value: 'url(' + d.path + ')', isDefault: true };
  });

  if (!sb) return defaults;
  try {
    var userResult = await sb.auth.getUser();
    var user = userResult.data.user;
    if (!user) return defaults;
  } catch (e) { return defaults; }

  // 30 秒缓存
  if (_wallpaperCache.items && Date.now() - _wallpaperCache.ts < 30000) {
    return _wallpaperCache.items;
  }

  try {
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

async function applyWallpaper(idx) {
  currentWallpaper = idx;
  var items = await getAllWallpapers();
  if (items.length === 0) {
    document.body.style.backgroundImage = 'none';
    return;
  }
  if (idx >= items.length) currentWallpaper = 0;
  var wp = items[currentWallpaper];
  document.body.style.backgroundImage = wp.value;
  localStorage.setItem('wallpaperIdx', currentWallpaper);
  renderWallpaperDots();
}

async function renderWallpaperDots() {
  var picker = document.getElementById('wallpaperPicker');
  var items = await getAllWallpapers();

  var dots = items.map(function(wp, i) {
    var delBtn = !wp.isDefault ? '<span class="delete-custom" onclick="event.stopPropagation();removeCustomWallpaper(' + wp.id + ')">✕</span>' : '';
    return '<div class="wp-dot' + (i === currentWallpaper ? ' active' : '') + (!wp.isDefault ? ' custom' : '') + '"' +
      ' style="background:' + wp.value + ';background-size:cover;background-position:center;"' +
      ' title="' + wp.name + '" onclick="applyWallpaper(' + i + ')">' + delBtn + '</div>';
  }).join('');

  picker.innerHTML = dots + '<div class="wp-upload-btn" onclick="triggerWallpaperUpload()" title="上传自定义壁纸">+</div>';
}

function triggerWallpaperUpload() {
  document.getElementById('wallpaperInput').click();
}

async function addCustomWallpapers(fileList) {
  if (!sb) return;
  var userResult;
  try { userResult = await sb.auth.getUser(); } catch (e) { return; }
  var user = userResult.data.user;
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
    alert('上传失败: ' + e.message);
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
  var idx = items.findIndex(function(w) { return w.id === id; });
  if (idx === currentWallpaper) {
    currentWallpaper = Math.max(0, idx - 1);
  } else if (idx < currentWallpaper) {
    currentWallpaper--;
  }
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
    var userResult = await sb.auth.getUser();
    var user = userResult.data.user;
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
    var userResult = await sb.auth.getUser();
    var user = userResult.data.user;
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
    alert('上传失败: ' + e.message);
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
