// ==================== BGM Player ====================
(function() {
  var DEFAULT_BGM = { name: 'Arte Refact - DESIR', path: 'bgm/desir.mp3' };
  var currentTrackIdx = -1;
  var bgmAudio = new Audio();
  bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
  bgmAudio.loop = false;
  var _bgmInited = false;
  var _bgmUserWantsPlay = false;
  var _trackCache = { ts: 0, items: null };

  // 首次用户交互后自动开始播放
  function _onUserInteract() {
    if (!_bgmInited) {
      _bgmInited = true;
      _bgmUserWantsPlay = true;
      var src = bgmAudio.src || DEFAULT_BGM.path;
      if (!bgmAudio.src) bgmAudio.src = src;
      if (bgmAudio.readyState === 0) bgmAudio.load();
      bgmAudio.play().then(function() {
        var btn = document.getElementById('bgmPlay');
        if (btn) { btn.textContent = '⏸'; btn.classList.add('playing'); }
      }).catch(function() {});
    }
  }
  document.addEventListener('click', _onUserInteract);
  document.addEventListener('touchend', _onUserInteract);

  async function getAllTracks() {
    var defaults = [{
      id: 'default_bgm',
      name: DEFAULT_BGM.name,
      path: DEFAULT_BGM.path,
      url: DEFAULT_BGM.path,
      isDefault: true,
    }];

    // 曲目来源：云端(Supabase) + 本地(IndexedDB未迁移的)
    var cloudTracks = [];
    var localTracks = [];

    // 从 Supabase 拉取云端曲目
    if (window.sb) {
      if (_trackCache.items && Date.now() - _trackCache.ts < 30000) {
        return _trackCache.items;
      }
      try {
        var user = await getCachedUser();
        if (user) {
          var result = await window.sb
            .from('user_files')
            .select('*')
            .eq('user_id', user.id)
            .eq('category', 'bgm')
            .order('created_at');
          cloudTracks = (result.data || []).map(function(t) {
            return { id: t.id, name: t.name, url: sbPublicUrl('bgm', t.storage_path) };
          });
          _trackCache.items = defaults.concat(cloudTracks);
          _trackCache.ts = Date.now();
        }
      } catch (e) { /* 云端失败不阻塞 */ }
    }

    // 从 IndexedDB 读取暂存的本地曲目（未迁移部分）
    try {
      localTracks = await _readLocalTracks();
    } catch (e) { /* 本地读取失败 */ }

    // 合并：云端 + 本地（本地不会和云端重复因为迁移后需手动清理）
    var all = defaults.concat(cloudTracks).concat(localTracks);
    return all;
  }

  // 从 IndexedDB 读取本地暂存的 BGM 并生成 blob URL
  async function _readLocalTracks() {
    var db = await new Promise(function(res, rej) {
      var req = indexedDB.open('PersonalSiteDB', 1);
      req.onsuccess = function(e) { res(e.target.result); };
      req.onerror = function() { rej(req.error); };
    });
    if (!db.objectStoreNames.contains('tracks')) { db.close(); return []; }
    var rows = await new Promise(function(res, rej) {
      try {
        var tx = db.transaction('tracks', 'readonly');
        var req = tx.objectStore('tracks').getAll();
        req.onsuccess = function() { res(req.result || []); };
        req.onerror = function() { rej(req.error); };
      } catch (e) { res([]); }
    });
    db.close();
    return rows.map(function(r) {
      var blob = new Blob([r.data], { type: r.type || 'audio/mpeg' });
      var url = URL.createObjectURL(blob);
      return { id: 'local_' + (r.id || r.addedAt), name: r.name, url: url, isDefault: false };
    });
  }

  async function playCurrentTrack() {
    var tracks = await getAllTracks();
    if (tracks.length === 0 || currentTrackIdx < 0) return;
    _bgmUserWantsPlay = true;
    var track = tracks[currentTrackIdx];
    var src = track.url || track.path;
    if (bgmAudio.src && /^blob:/.test(bgmAudio.src)) URL.revokeObjectURL(bgmAudio.src);
    bgmAudio.src = src;
    var playBtn = document.getElementById('bgmPlay');
    bgmAudio.play().then(function() {
      playBtn.textContent = '⏸';
      playBtn.classList.add('playing');
    }).catch(function() {
      playBtn.textContent = '▶';
      playBtn.classList.remove('playing');
    });
    document.getElementById('bgmTrackName').textContent = track.name;
    renderBGMPlaylist();
  }

  function playNextTrack() {
    getAllTracks().then(function(tracks) {
      if (tracks.length === 0) return;
      currentTrackIdx = (currentTrackIdx + 1) % tracks.length;
      playCurrentTrack();
    });
  }

  function playPrevTrack() {
    getAllTracks().then(function(tracks) {
      if (tracks.length === 0) return;
      currentTrackIdx = (currentTrackIdx - 1 + tracks.length) % tracks.length;
      playCurrentTrack();
    });
  }

  async function handleBGMFiles(fileList) {
    // 收集有效音频文件
    var audioFiles = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (f.type.startsWith('audio/') || f.name.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i)) {
        audioFiles.push(f);
      }
    }
    if (audioFiles.length === 0) return;

    // 尝试获取登录用户
    var user = null;
    if (window.sb && window._isLoggedIn) {
      user = await getCachedUser();
    }

    if (user) {
      // 已登录 → 直接上传到 Supabase
      showLoading('上传到云端...');
      try {
        for (var j = 0; j < audioFiles.length; j++) {
          var cf = audioFiles[j];
          var path = sbStoragePath(user.id, 'bgm', cf.name);
          await sbUpload('bgm', cf, path);
          await window.sb.from('user_files').insert({
            user_id: user.id, category: 'bgm',
            name: cf.name, size: cf.size, mime_type: cf.type, storage_path: path,
          });
        }
        showToast('已上传 ' + audioFiles.length + ' 首到云端', 'success');
      } catch (e) {
        showToast('云端上传失败: ' + (e.message || '请检查网络'), 'error');
        // 失败时也存本地防止丢失
        await _saveToLocalDB(audioFiles);
      } finally { hideLoading(); }
    } else {
      await _saveToLocalDB(audioFiles);
    }

    _trackCache.items = null;
    renderBGMPlaylist();
    var tracks = await getAllTracks();
    currentTrackIdx = tracks.length - 1;
    localStorage.setItem('bgmTrackIdx', currentTrackIdx);
    playCurrentTrack();
  }

  async function _saveToLocalDB(audioFiles) {
    showLoading('保存到本地...');
    var db = null;
    try {
      db = await new Promise(function(res, rej) {
        var req = indexedDB.open('PersonalSiteDB', 1);
        req.onupgradeneeded = function(e) {
          if (!e.target.result.objectStoreNames.contains('tracks')) {
            e.target.result.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = function(e) { res(e.target.result); };
        req.onerror = function() { rej(req.error); };
      });
      if (!db.objectStoreNames.contains('tracks')) {
        db.close();
        db = await new Promise(function(res, rej) {
          var req = indexedDB.open('PersonalSiteDB', 2);
          req.onupgradeneeded = function(e) {
            if (!e.target.result.objectStoreNames.contains('tracks')) {
              e.target.result.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
            }
          };
          req.onsuccess = function(e) { res(e.target.result); };
          req.onerror = function() { rej(req.error); };
        });
      }
      var tx = db.transaction('tracks', 'readwrite');
      var store = tx.objectStore('tracks');
      for (var k = 0; k < audioFiles.length; k++) {
        var af = audioFiles[k];
        var buf = await af.arrayBuffer();
        store.add({ name: af.name, data: buf, size: af.size, type: af.type, addedAt: Date.now() });
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

  async function renderBGMPlaylist() {
    var tracks = await getAllTracks();
    var list = document.getElementById('bgmPlaylist');
    list.innerHTML = tracks.map(function(t, i) {
      var delBtn = !t.isDefault ? '<span class="track-del" onclick="event.stopPropagation();window.deleteBGMById(' + t.id + ')">✕</span>' : '';
      return '<li class="' + (i === currentTrackIdx ? 'current' : '') + '" onclick="window.bgmPlayIdx(' + i + ')">' +
        '<span class="track-index">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="track-name">' + escHtml(t.name) + '</span>' + delBtn + '</li>';
    }).join('');
  }

  function bgmPlayIdx(i) {
    currentTrackIdx = i;
    playCurrentTrack();
  }

  async function deleteBGMById(id) {
    if (!window.sb) return;
    var tracks = await getAllTracks();
    var idx = tracks.findIndex(function(t) { return t.id === id; });
    if (idx < 0 || tracks[idx].isDefault) return;

    try {
      var result = await window.sb.from('user_files').select('storage_path').eq('id', id).single();
      if (result.data) {
        await sbDelete('bgm', result.data.storage_path);
        await window.sb.from('user_files').delete().eq('id', id);
      }
    } catch (e) { return; }

    _trackCache.items = null;

    if (tracks.length === 2) {
      currentTrackIdx = 0;
      playCurrentTrack();
    } else if (idx === currentTrackIdx) {
      currentTrackIdx = Math.max(0, idx - 1);
      playCurrentTrack();
    } else if (idx < currentTrackIdx) {
      currentTrackIdx--;
      localStorage.setItem('bgmTrackIdx', currentTrackIdx);
    }
    renderBGMPlaylist();
  }

  function bindBGMEvents() {
    document.getElementById('bgmVolume').value = bgmAudio.volume * 100;
    document.getElementById('bgmVolume').addEventListener('input', function() {
      bgmAudio.volume = this.value / 100;
      localStorage.setItem('bgmVolume', this.value / 100);
    });

    document.getElementById('bgmPlay').addEventListener('click', function() {
      var btn = this;
      if (bgmAudio.paused) {
        if (!bgmAudio.src) {
          bgmAudio.src = DEFAULT_BGM.path;
          currentTrackIdx = 0;
          document.getElementById('bgmTrackName').textContent = DEFAULT_BGM.name;
        }
        if (bgmAudio.readyState === 0) bgmAudio.load();
        _bgmUserWantsPlay = true;
        bgmAudio.play().then(function() {
          btn.textContent = '⏸';
          btn.classList.add('playing');
        }).catch(function() {});
      } else {
        _bgmUserWantsPlay = false;
        bgmAudio.pause();
        btn.textContent = '▶';
        btn.classList.remove('playing');
      }
    });

    document.getElementById('bgmNext').addEventListener('click', playNextTrack);
    document.getElementById('bgmPrev').addEventListener('click', playPrevTrack);

    bgmAudio.addEventListener('ended', playNextTrack);

    // 进度条 + 时间显示
    bgmAudio.addEventListener('timeupdate', function() {
      var cur = document.getElementById('bgmCurrentTime');
      var bar = document.getElementById('bgmProgressBar');
      if (cur) cur.textContent = formatTime(bgmAudio.currentTime);
      if (bar && bgmAudio.duration) bar.style.width = (bgmAudio.currentTime / bgmAudio.duration * 100) + '%';
    });

    bgmAudio.addEventListener('loadedmetadata', function() {
      var dur = document.getElementById('bgmDuration');
      if (dur) dur.textContent = formatTime(bgmAudio.duration);
    });

    // 进度条点击/拖动跳转 (支持触屏)
    var progressWrap = document.getElementById('bgmProgressWrap');
    if (progressWrap) {
      function seekFromEvent(e) {
        if (!bgmAudio.duration) return;
        var rect = progressWrap.getBoundingClientRect();
        var clientX = e.touches ? e.touches[0].clientX : e.clientX;
        var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        bgmAudio.currentTime = pct * bgmAudio.duration;
      }
      progressWrap.addEventListener('click', seekFromEvent);
      var _touchMove, _touchEnd;
      progressWrap.addEventListener('touchstart', function(e) {
        seekFromEvent(e);
        if (_touchMove) document.removeEventListener('touchmove', _touchMove);
        if (_touchEnd) document.removeEventListener('touchend', _touchEnd);
        _touchMove = function(ev) { seekFromEvent(ev); ev.preventDefault(); };
        _touchEnd = function() {
          document.removeEventListener('touchmove', _touchMove);
          document.removeEventListener('touchend', _touchEnd);
          _touchMove = null; _touchEnd = null;
        };
        document.addEventListener('touchmove', _touchMove, { passive: false });
        document.addEventListener('touchend', _touchEnd);
      });
    }

    function formatTime(sec) {
      if (isNaN(sec) || !isFinite(sec)) return '0:00';
      var m = Math.floor(sec / 60);
      var s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    // BGM modal
    document.getElementById('bgmPlaylistBtn').addEventListener('click', function() {
      document.getElementById('bgmModal').classList.remove('hidden');
      renderBGMPlaylist();
    });
    document.getElementById('btnBgm').addEventListener('click', function() {
      document.getElementById('bgmModal').classList.remove('hidden');
      renderBGMPlaylist();
    });
    document.getElementById('bgmModal').addEventListener('click', function(e) {
      if (e.target === this) this.classList.add('hidden');
    });

    // BGM drop zone
    document.getElementById('bgmDropZone').addEventListener('click', function() {
      var input = document.createElement('input');
      input.type = 'file'; input.multiple = true;
      input.accept = 'audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac';
      input.onchange = function(e) { handleBGMFiles(e.target.files); };
      input.click();
    });
    document.getElementById('bgmDropZone').addEventListener('dragover', function(e) { e.preventDefault(); e.target.closest('.drop-zone').classList.add('drag-over'); });
    document.getElementById('bgmDropZone').addEventListener('dragleave', function(e) { e.target.closest('.drop-zone').classList.remove('drag-over'); });
    document.getElementById('bgmDropZone').addEventListener('drop', function(e) {
      e.preventDefault();
      e.target.closest('.drop-zone').classList.remove('drag-over');
      handleBGMFiles(e.dataTransfer.files);
    });

    // 移动端 BGM 展开面板
    var expandBtn = document.createElement('button');
    expandBtn.className = 'bgm-expand-btn';
    expandBtn.id = 'bgmExpandBtn';
    expandBtn.title = '展开';
    expandBtn.textContent = '…';
    expandBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      document.getElementById('bgmPlayer').classList.toggle('expanded');
    });
    document.getElementById('bgmPlayer').appendChild(expandBtn);

  }

  window.DEFAULT_BGM = DEFAULT_BGM;
  window.getAllTracks = getAllTracks;
  window.playCurrentTrack = playCurrentTrack;
  window.renderBGMPlaylist = renderBGMPlaylist;
  window.bindBGMEvents = bindBGMEvents;
  window.deleteBGMById = deleteBGMById;
  window.bgmPlayIdx = bgmPlayIdx;

  // Mutable state — getter/setter so external reads see latest value
  Object.defineProperty(window, 'currentTrackIdx', {
    get: function() { return currentTrackIdx; },
    set: function(v) { currentTrackIdx = v; }
  });
  Object.defineProperty(window, 'bgmAudio', {
    get: function() { return bgmAudio; }
  });
})();
