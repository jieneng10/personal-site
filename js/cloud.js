// ==================== Cloud Drive ====================
(function() {
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function getFileIcon(name) {
    var ext = name.split('.').pop().toLowerCase();
    var map = {
      pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📑', pptx:'📑',
      jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', svg:'🖼', webp:'🖼',
      mp3:'🎵', wav:'🎵', ogg:'🎵', flac:'🎵',
      mp4:'🎬', avi:'🎬', mkv:'🎬',
      zip:'📦', rar:'📦', '7z':'📦', tar:'📦',
      txt:'📃', md:'📃', json:'📃', xml:'📃',
      py:'🐍', js:'📜', html:'🌐', css:'🎨', cpp:'⚙', c:'⚙', m:'🔢',
    };
    return map[ext] || '📁';
  }

  async function renderFileList() {
    var list = document.getElementById('fileList');

    if (!window.sb || !window._isLoggedIn) {
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>请登录后使用云端文件</div></div>';
      return;
    }

    try {
      var user = await getCachedUser();
      if (!user) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>请先登录</div></div>';
        return;
      }

      var result = await window.sb
        .from('user_files')
        .select('*')
        .eq('user_id', user.id)
        .eq('category', 'cloud')
        .order('created_at', { ascending: false });

      var files = result.data || [];
      if (files.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>还没有文件，上传一些吧~</div></div>';
      } else {
        list.innerHTML = files.map(function(f) {
          return '<div class="file-item">' +
            '<div class="file-info">' +
              '<span class="file-icon">' + getFileIcon(f.name) + '</span>' +
              '<span class="file-name" title="' + escHtml(f.name) + '">' + escHtml(f.name) + '</span>' +
            '</div>' +
            '<div class="file-meta">' + formatSize(f.size || 0) + ' · ' + (f.created_at || '').slice(0, 10) + '</div>' +
            '<div class="file-actions">' +
              '<button class="file-btn" data-file-download="' + f.id + '" title="下载">⬇</button>' +
              '<button class="file-btn danger" data-file-remove="' + f.id + '" title="删除">✕</button>' +
            '</div>' +
          '</div>';
        }).join('');
      }
      updateStorageInfo();
    } catch (e) {
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>加载失败，请检查网络</div></div>';
    }
  }

  async function updateStorageInfo() {
    if (!window.sb) return;
    try {
      var user = await getCachedUser();
      if (!user) return;

      var result = await window.sb
        .from('user_files')
        .select('size')
        .eq('user_id', user.id)
        .eq('category', 'cloud');

      var total = (result.data || []).reduce(function(s, f) { return s + (f.size || 0); }, 0);
      var maxSize = 100 * 1048576;
      var pct = Math.min(100, (total / maxSize) * 100);
      document.getElementById('storageText').textContent = '已使用 ' + formatSize(total);
      document.getElementById('storageBar').style.width = pct + '%';
    } catch (e) { /* ignore */ }
  }

  async function handleFiles(fileList) {
    if (!window.sb) return;
    var user = await getCachedUser();
    if (!user) return;

    // 客户端校验：文件大小和类型
    var MAX_FILE_SIZE = 50 * 1048576; // 50MB
    var ALLOWED_EXTS = ['pdf','doc','docx','xls','xlsx','ppt','pptx',
      'jpg','jpeg','png','gif','svg','webp','bmp',
      'mp3','wav','ogg','flac','aac',
      'mp4','avi','mkv','mov','webm',
      'zip','rar','7z','tar','gz',
      'txt','md','json','xml','csv','html','css','js','py','cpp','c','m',
      'ttf','otf','woff','woff2'];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (f.size > MAX_FILE_SIZE) {
        showToast('文件 ' + f.name + ' 超过 50MB 限制', 'warn');
        return;
      }
      var ext = f.name.split('.').pop().toLowerCase();
      if (ALLOWED_EXTS.indexOf(ext) === -1) {
        showToast('不支持的文件类型: .' + ext, 'warn');
        return;
      }
    }

    showLoading('上传文件中...');
    try {
      for (var i = 0; i < fileList.length; i++) {
        var file = fileList[i];
        var path = sbStoragePath(user.id, 'cloud', file.name);
        await sbUpload('files', file, path);
        await window.sb.from('user_files').insert({
          user_id: user.id,
          category: 'cloud',
          name: file.name,
          size: file.size,
          mime_type: file.type,
          storage_path: path,
        });
      }
    } catch (e) {
      showToast('上传失败: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
    renderFileList();
  }

  async function downloadFile(id) {
    if (!window.sb) return;
    try {
      var result = await window.sb.from('user_files').select('storage_path, name').eq('id', id).single();
      if (!result.data) return;
      showLoading('准备下载...');
      try {
        var signedUrl = await sbSignedUrl('files', result.data.storage_path, 60);
        if (!signedUrl) { showToast('下载链接生成失败', 'error'); return; }
        var a = document.createElement('a');
        a.href = signedUrl;
        a.download = result.data.name;
        a.click();
      } finally {
        hideLoading();
      }
    } catch (e) {
      showToast('下载失败: ' + e.message, 'error');
    }
  }

  async function removeFile(id) {
    if (!window.sb) return;
    try {
      var result = await window.sb.from('user_files').select('storage_path').eq('id', id).single();
      if (result.data) {
        await sbDelete('files', result.data.storage_path);
        await window.sb.from('user_files').delete().eq('id', id);
      }
    } catch (e) { return; }
    renderFileList();
  }

  async function clearCloudData() {
    if (!window.sb) return;
    var user = await getCachedUser();
    if (!user) return;
    if (!confirm('确定要清空所有网盘文件吗？此操作不可撤销！')) return;

    showLoading('清除中...');
    try {
      var result = await window.sb
        .from('user_files')
        .select('storage_path')
        .eq('user_id', user.id)
        .eq('category', 'cloud');
      var files = result.data || [];
      if (files.length > 0) {
        await sbDelete('files', files.map(function(f) { return f.storage_path; }));
      }
      await window.sb.from('user_files').delete().eq('user_id', user.id).eq('category', 'cloud');
    } catch (e) {
      showToast('清除失败: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
    renderFileList();
  }

  // ---- IndexedDB → Supabase 迁移 ----
  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var mime = parts[0].match(/:(.*?);/)[1];
    var bytes = atob(parts[1]);
    var arr = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function dbGetAllFrom(db, storeName) {
    return new Promise(function(resolve, reject) {
      try {
        var tx = db.transaction(storeName, 'readonly');
        var req = tx.objectStore(storeName).getAll();
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
      } catch (e) { resolve([]); }
    });
  }

  async function migrateLocalToCloud() {
    if (!window.sb) { showToast('服务不可用', 'warn'); return; }
    var user = await getCachedUser();
    if (!user) { showToast('请先登录', 'warn'); return; }

    var oldDB;
    try {
      oldDB = await new Promise(function(resolve, reject) {
        var req = indexedDB.open('PersonalSiteDB', 1);
        req.onsuccess = function(e) { resolve(e.target.result); };
        req.onerror = function() { reject(req.error); };
      });
    } catch (e) {
      showToast('未找到本地数据 (IndexedDB 不存在或已迁移)', 'warn');
      return;
    }

    showLoading('检查本地数据...');
    var migrated = { wallpapers: 0, files: 0, tracks: 0, avatar: false };
    var errors = [];

    try {
      // --- 壁纸 ---
      if (oldDB.objectStoreNames.contains('wallpapers')) {
        showLoading('迁移壁纸中...');
        var wallpapers = await dbGetAllFrom(oldDB, 'wallpapers');
        for (var i = 0; i < wallpapers.length; i++) {
          try {
            var w = wallpapers[i];
            var wblob;
            if (w.dataUrl) {
              wblob = dataUrlToBlob(w.dataUrl);
            } else if (w.data) {
              wblob = new Blob([w.data], { type: w.type || 'image/png' });
            } else {
              continue;
            }
            var wfile = new File([wblob], w.name, { type: wblob.type || 'image/png' });
            var wpath = sbStoragePath(user.id, 'wallpaper', w.name);
            await sbUpload('wallpapers', wfile, wpath);
            await window.sb.from('user_files').insert({
              user_id: user.id, category: 'wallpaper',
              name: w.name, size: wblob.size, mime_type: wblob.type || 'image/png', storage_path: wpath,
            });
            migrated.wallpapers++;
          } catch (e) { errors.push('壁纸 ' + (w.name || '')); }
        }
      }

      // --- 文件 ---
      if (oldDB.objectStoreNames.contains('files')) {
        showLoading('迁移文件中...');
        var files = await dbGetAllFrom(oldDB, 'files');
        for (var j = 0; j < files.length; j++) {
          try {
            var f = files[j];
            if (!f.data) continue;
            var fblob = new Blob([f.data]);
            var ffile = new File([fblob], f.name, { type: 'application/octet-stream' });
            var fpath = sbStoragePath(user.id, 'cloud', f.name);
            await sbUpload('files', ffile, fpath);
            await window.sb.from('user_files').insert({
              user_id: user.id, category: 'cloud',
              name: f.name, size: f.size || fblob.size, storage_path: fpath,
            });
            migrated.files++;
          } catch (e) { errors.push('文件 ' + (f.name || '')); }
        }
      }

      // --- BGM ---
      if (oldDB.objectStoreNames.contains('tracks')) {
        showLoading('迁移 BGM 中...');
        var tracks = await dbGetAllFrom(oldDB, 'tracks');
        for (var k = 0; k < tracks.length; k++) {
          try {
            var t = tracks[k];
            if (!t.data) continue;
            var tblob = new Blob([t.data]);
            var tfile = new File([tblob], t.name, { type: t.type || 'audio/mpeg' });
            var tpath = sbStoragePath(user.id, 'bgm', t.name);
            await sbUpload('bgm', tfile, tpath);
            await window.sb.from('user_files').insert({
              user_id: user.id, category: 'bgm',
              name: t.name, size: tblob.size, storage_path: tpath,
            });
            migrated.tracks++;
          } catch (e) { errors.push('BGM ' + (t.name || '')); }
        }
      }

      // --- 头像 ---
      if (oldDB.objectStoreNames.contains('avatar')) {
        showLoading('迁移头像中...');
        var avatars = await dbGetAllFrom(oldDB, 'avatar');
        if (avatars.length > 0) {
          try {
            var a = avatars[0];
            var ablob;
            if (a.dataUrl) {
              ablob = dataUrlToBlob(a.dataUrl);
            } else if (a.data) {
              ablob = new Blob([a.data], { type: a.type || 'image/png' });
            }
            if (ablob) {
              var afile = new File([ablob], 'avatar.png', { type: 'image/png' });
              var apath = sbStoragePath(user.id, 'avatar', 'avatar.png');
              await sbUpload('avatars', afile, apath);
              await window.sb.from('avatars').upsert({ user_id: user.id, storage_path: apath, updated_at: new Date() });
              migrated.avatar = true;
            }
          } catch (e) { errors.push('头像'); }
        }
      }

      var msg = '迁移完成！壁纸 ' + migrated.wallpapers + ' 张, 文件 ' + migrated.files + ' 个, BGM ' + migrated.tracks + ' 首' + (migrated.avatar ? ', 头像 1 个' : '');
      if (errors.length > 0) msg += '（' + errors.length + ' 项失败）';
      showToast(msg, errors.length > 0 ? 'warn' : 'success');
    } catch (e) {
      showToast('迁移失败: ' + (e.message || '未知错误'), 'error');
    } finally {
      hideLoading();
      if (oldDB) oldDB.close();
    }
  }

  function bindCloudEvents() {
    // File list event delegation
    document.getElementById('fileList').addEventListener('click', function(e) {
      var dl = e.target.closest('[data-file-download]');
      if (dl) { downloadFile(parseInt(dl.getAttribute('data-file-download'))); return; }
      var rm = e.target.closest('[data-file-remove]');
      if (rm) { removeFile(parseInt(rm.getAttribute('data-file-remove'))); return; }
    });

    document.getElementById('dropZone').addEventListener('click', function() { document.getElementById('fileInput').click(); });
    document.getElementById('fileInput').addEventListener('change', function(e) { handleFiles(e.target.files); e.target.value = ''; });
    document.getElementById('dropZone').addEventListener('dragover', function(e) { e.preventDefault(); e.target.closest('.drop-zone').classList.add('drag-over'); });
    document.getElementById('dropZone').addEventListener('dragleave', function(e) { e.target.closest('.drop-zone').classList.remove('drag-over'); });
    document.getElementById('dropZone').addEventListener('drop', function(e) {
      e.preventDefault();
      e.target.closest('.drop-zone').classList.remove('drag-over');
      handleFiles(e.dataTransfer.files);
    });
  }

  window.renderFileList = renderFileList;
  window.downloadFile = downloadFile;
  window.removeFile = removeFile;
  window.clearCloudData = clearCloudData;
  window.migrateLocalToCloud = migrateLocalToCloud;
  window.bindCloudEvents = bindCloudEvents;
})();
