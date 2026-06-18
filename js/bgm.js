// ==================== BGM Player ====================
(function() {
  /** @type {{ name: string, path: string }[]} */
  var DEFAULT_BGMS = [
    { name: 'Arte Refact - DESIR', path: 'bgm/desir.mp3' },
    { name: '雪 - May day+', path: 'bgm/snow.mp3' },
    { name: 'riya - one of a kind', path: 'bgm/riya_one.mp3' },
  ];

  var currentTrackIdx = -1;
  var bgmAudio = new Audio();
  bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
  bgmAudio.loop = false;
  bgmAudio.preload = 'none';
  var _bgmInited = false;

  // ---- Data-fetching layer (wrapped by createCache) ----

  /**
   * @typedef {object} TrackItem
   * @property {string|number} id
   * @property {string}        name
   * @property {string}        url     - Playable audio URL (or relative path for defaults)
   * @property {string}        [path]  - Relative path (defaults only)
   * @property {boolean}       [isDefault]
   */

  /**
   * Fetch all audio tracks from all sources.
   * Order: defaults → Supabase cloud → IndexedDB local
   * @returns {Promise<TrackItem[]>}
   */
  async function _fetchAllTracks() {
    var defaults = DEFAULT_BGMS.map(function(b, i) {
      return { id: 'default_bgm_' + i, name: b.name, path: b.path, url: b.path, isDefault: true };
    });

    var cloudTracks = [];
    var localTracks = [];

    // Supabase cloud (RLS auto-filters)
    if (window.sb) {
      try {
        var result = await window.sb
          .from('user_files')
          .select('*')
          .eq('category', 'bgm')
          .eq('published', true)
          .order('created_at');
        cloudTracks = (result.data || []).map(function(t) {
          return { id: t.id, name: t.name, url: sbPublicUrl('bgm', t.storage_path) };
        });
      } catch (e) { /* cloud unavailable — skip */ }
    }

    // IndexedDB local (unmigrated)
    try {
      localTracks = await _readLocalTracks();
    } catch (e) { /* local read failed — skip */ }

    return defaults.concat(cloudTracks).concat(localTracks);
  }

  /** 30-second cache for track list */
  var _trackCache = window.createCache
    ? window.createCache(_fetchAllTracks, 30000)
    : null;

  /**
   * Get all available tracks (cached).
   * @returns {Promise<TrackItem[]>}
   */
  async function getAllTracks() {
    if (_trackCache) return _trackCache.get();
    return _fetchAllTracks();
  }

  function invalidateTrackCache() {
    if (_trackCache) _trackCache.invalidate();
  }

  // ---- IndexedDB helpers ----

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

  async function _deleteLocalTrack(id) {
    var db = await new Promise(function(res, rej) {
      var req = indexedDB.open('PersonalSiteDB', 1);
      req.onsuccess = function(e) { res(e.target.result); };
      req.onerror = function() { rej(req.error); };
    });
    if (!db.objectStoreNames.contains('tracks')) { db.close(); return; }
    var tx = db.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').delete(id);
    await new Promise(function(res, rej) {
      tx.oncomplete = res; tx.onerror = function() { rej(tx.error); };
    });
    db.close();
  }

  // =========================================================================
  // First-interaction gate — defer audio loading until user gesture
  // =========================================================================

  var _interactDone = false;
  function _onUserInteract() {
    if (_interactDone) return;
    _interactDone = true;
    _bgmInited = true;
    if (!bgmAudio.src) {
      bgmAudio.src = DEFAULT_BGMS[0].path;
      bgmAudio.load();
      bgmAudio.play().then(function() {
        var btn = document.getElementById('bgmPlay');
        if (btn) { btn.textContent = '⏸'; btn.classList.add('playing'); }
      }).catch(function() {});
    }
  }
  document.addEventListener('click', _onUserInteract);
  document.addEventListener('touchend', _onUserInteract);

  // =========================================================================
  // Playback control
  // =========================================================================

  /**
   * Play the track at `currentTrackIdx`.
   * Skips re-loading if the same track is already playing.
   * @returns {Promise<void>}
   */
  async function playCurrentTrack() {
    var tracks = await getAllTracks();
    if (tracks.length === 0 || currentTrackIdx < 0) return;
    var track = tracks[currentTrackIdx];

    if (!_bgmInited) {
      document.getElementById('bgmTrackName').textContent = track.name;
      renderBGMPlaylist();
      return;
    }
    var src = track.url || track.path;

    // Same track already playing — don't interrupt
    var currentSrc = bgmAudio.src || '';
    // B-7: 文件名精确比较，避免 track1.mp3 子串误匹配 track10.mp3
    var sameTrack = currentSrc === src;
    if (!sameTrack && currentSrc && src) {
      var fnA = currentSrc.split('/').pop().split('?')[0];
      var fnB = src.split('/').pop().split('?')[0];
      sameTrack = fnA === fnB;
    }
    if (!bgmAudio.paused && sameTrack) {
      var playBtn0 = document.getElementById('bgmPlay');
      playBtn0.textContent = '⏸';
      playBtn0.classList.add('playing');
      document.getElementById('bgmTrackName').textContent = track.name;
      renderBGMPlaylist();
      return;
    }

    if (currentSrc && /^blob:/.test(currentSrc)) URL.revokeObjectURL(currentSrc);
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

  /**
   * Set the track index and start playback.
   * @param {number} i - Track index
   */
  function bgmPlayIdx(i) {
    currentTrackIdx = i;
    playCurrentTrack();
  }

  // =========================================================================
  // Upload / add tracks
  // =========================================================================

  /**
   * Handle one or more audio files from upload or drag-and-drop.
   * @param {FileList} fileList
   * @returns {Promise<void>}
   */
  async function handleBGMFiles(fileList) {
    var audioFiles = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (f.type.startsWith('audio/') || f.name.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i)) {
        audioFiles.push(f);
      }
    }
    if (audioFiles.length === 0) return;

    var user = null;
    if (window.sb && window._isLoggedIn) {
      user = await getCachedUser();
    }

    if (user) {
      showLoading('上传到云端...');
      try {
        for (var j = 0; j < audioFiles.length; j++) {
          var cf = audioFiles[j];
          var path = sbStoragePath(user.id, 'bgm', cf.name);
          await sbUpload('bgm', cf, path);
          await window.sb.from('user_files').insert({
            user_id: user.id, category: 'bgm', published: true,
            name: cf.name, size: cf.size, mime_type: cf.type, storage_path: path,
          });
        }
        showToast('已上传 ' + audioFiles.length + ' 首到云端', 'success');
      } catch (e) {
        showToast('云端上传失败: ' + (e.message || '请检查网络'), 'error');
        await _saveToLocalDB(audioFiles);
      } finally { hideLoading(); }
    } else if (window.sb) {
      showLoading('上传到云端...');
      try {
        for (var k = 0; k < audioFiles.length; k++) {
          var gf = audioFiles[k];
          var gpath = 'guest/' + Date.now().toString(36) + '_' + gf.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          await sbUpload('bgm', gf, gpath);
          await window.sb.from('user_files').insert({
            category: 'bgm', published: false,
            name: gf.name, size: gf.size, mime_type: gf.type, storage_path: gpath,
          });
        }
        showToast('已上传 ' + audioFiles.length + ' 首，等待管理员审核通过后可见', 'success');
      } catch (e) {
        await _saveToLocalDB(audioFiles);
        showToast('已保存本地（登录后可云端迁移上传）', 'success');
      } finally { hideLoading(); }
    } else {
      await _saveToLocalDB(audioFiles);
    }

    invalidateTrackCache();
    renderBGMPlaylist();
    var tracks = await getAllTracks();
    currentTrackIdx = tracks.length - 1;
    window.safeSetItem('bgmTrackIdx', currentTrackIdx);
    playCurrentTrack();
  }

  async function _saveToLocalDB(audioFiles) {
    showLoading('保存到本地...');
    try {
      var entries = [];
      for (var k = 0; k < audioFiles.length; k++) {
        var af = audioFiles[k];
        var buf = await af.arrayBuffer();
        entries.push({ name: af.name, data: buf, size: af.size, type: af.type, addedAt: Date.now() });
      }
      await saveToLocalDB('tracks', entries);
      showToast('已保存本地（登录后可云端迁移上传）', 'success');
    } catch (e) {
      showToast('保存失败: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  }

  // =========================================================================
  // Playlist & deletion
  // =========================================================================

  /**
   * Re-render the BGM playlist in the modal.
   * @returns {Promise<void>}
   */
  async function renderBGMPlaylist() {
    var tracks = await getAllTracks();
    var list = document.getElementById('bgmPlaylist');
    list.innerHTML = tracks.map(function(t, i) {
      var delBtn = !t.isDefault ? '<span class="track-del" data-delete-id="' + t.id + '">✕</span>' : '';
      return '<li class="' + (i === currentTrackIdx ? 'current' : '') + '" data-track-index="' + i + '">' +
        '<span class="track-index">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="track-name">' + escHtml(t.name) + '</span>' + delBtn + '</li>';
    }).join('');
  }

  /**
   * Delete a BGM track by id (cloud or local).
   * @param {string|number} id
   * @returns {Promise<void>}
   */
  async function deleteBGMById(id) {
    if (!window.sb) return;
    var tracks = await getAllTracks();
    var idx = tracks.findIndex(function(t) { return t.id === id; });
    if (idx < 0 || tracks[idx].isDefault) return;

    try {
      if (typeof id === 'number') {
        var result = await window.sb.from('user_files').select('storage_path').eq('id', id).single();
        if (result.data) {
          await sbDelete('bgm', result.data.storage_path);
          await window.sb.from('user_files').delete().eq('id', id);
        }
      } else {
        await _deleteLocalTrack(id);
      }
    } catch (e) { return; }

    invalidateTrackCache();

    if (tracks.length === 2) {
      currentTrackIdx = 0;
      playCurrentTrack();
    } else if (idx === currentTrackIdx) {
      currentTrackIdx = Math.max(0, idx - 1);
      playCurrentTrack();
    } else if (idx < currentTrackIdx) {
      currentTrackIdx--;
      window.safeSetItem('bgmTrackIdx', currentTrackIdx);
    }
    renderBGMPlaylist();
  }

  // =========================================================================
  // Event bindings
  // =========================================================================

  function bindBGMEvents() {
    document.getElementById('bgmVolume').value = bgmAudio.volume * 100;
    document.getElementById('bgmVolume').addEventListener('input', function() {
      bgmAudio.volume = this.value / 100;
      window.safeSetItem('bgmVolume', this.value / 100);
    });

    document.getElementById('bgmPlay').addEventListener('click', function() {
      var btn = this;
      if (bgmAudio.paused) {
        if (!bgmAudio.src) {
          bgmAudio.src = DEFAULT_BGMS[0].path;
          currentTrackIdx = 0;
          document.getElementById('bgmTrackName').textContent = DEFAULT_BGMS[0].name;
        }
        if (bgmAudio.readyState === 0) bgmAudio.load();
        bgmAudio.play().then(function() {
          btn.textContent = '⏸';
          btn.classList.add('playing');
        }).catch(function() {});
      } else {
        bgmAudio.pause();
        btn.textContent = '▶';
        btn.classList.remove('playing');
      }
    });

    document.getElementById('bgmNext').addEventListener('click', playNextTrack);
    document.getElementById('bgmPrev').addEventListener('click', playPrevTrack);

    bgmAudio.addEventListener('ended', playNextTrack);

    // Progress bar + time display
    bgmAudio.addEventListener('timeupdate', function() {
      var cur = document.getElementById('bgmCurrentTime');
      var bar = document.getElementById('bgmProgressBar');
      if (cur) cur.textContent = formatTime(bgmAudio.currentTime);
      // B-14: 直播流/特殊编码的 duration 可能为 Infinity，跳过进度条更新
      if (bar && isFinite(bgmAudio.duration) && bgmAudio.duration > 0) {
        bar.style.width = (bgmAudio.currentTime / bgmAudio.duration * 100) + '%';
      }
    });

    bgmAudio.addEventListener('loadedmetadata', function() {
      var dur = document.getElementById('bgmDuration');
      // B-14: 直播流 duration 为 Infinity，显示占位符
      if (dur) dur.textContent = isFinite(bgmAudio.duration) ? formatTime(bgmAudio.duration) : '--:--';
    });

    // Progress bar click/drag (with touch support)
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

    /**
     * Format seconds as m:ss.
     * @param {number} sec
     * @returns {string}
     */
    function formatTime(sec) {
      // B-15: null/undefined 也会被 isFinite(null)===true 绕过，加显式 null 检查
      if (sec == null || isNaN(sec) || !isFinite(sec)) return '0:00';
      var m = Math.floor(sec / 60);
      var s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    // Playlist event delegation
    document.getElementById('bgmPlaylist').addEventListener('click', function(e) {
      var delBtn = e.target.closest('.track-del[data-delete-id]');
      if (delBtn) {
        e.stopPropagation();
        var $did0 = delBtn.getAttribute('data-delete-id');
        deleteBGMById(/^\d+$/.test($did0) ? parseInt($did0) : $did0);
        return;
      }
      var item = e.target.closest('li[data-track-index]');
      if (item) {
        bgmPlayIdx(parseInt(item.getAttribute('data-track-index')));
      }
    });

    // Open BGM modal
    document.getElementById('bgmPlaylistBtn').addEventListener('click', function() {
      document.getElementById('bgmModal').classList.remove('hidden');
      renderBGMPlaylist();
    });
    document.getElementById('btnBgm').addEventListener('click', function() {
      document.getElementById('bgmModal').classList.remove('hidden');
      renderBGMPlaylist();
    });
    document.getElementById('bgmModal').addEventListener('click', function(e) {
      if (e.target === this) { e.stopPropagation(); this.classList.add('hidden'); }
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

    // Mobile BGM expand toggle
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

  // ---- Listen for cache invalidation from admin panel ----
  if (typeof window.EventBus !== 'undefined') {
    window.EventBus.on('cache:invalidate:tracks', function() {
      invalidateTrackCache();
    });
  }

  // =========================================================================
  // window exports
  // =========================================================================

  /** @type {typeof DEFAULT_BGMS} */
  window.DEFAULT_BGMS = DEFAULT_BGMS;

  /** @type {typeof getAllTracks} */
  window.getAllTracks = getAllTracks;

  /** @type {typeof playCurrentTrack} */
  window.playCurrentTrack = playCurrentTrack;

  /** @type {typeof renderBGMPlaylist} */
  window.renderBGMPlaylist = renderBGMPlaylist;

  /** @type {typeof bindBGMEvents} */
  window.bindBGMEvents = bindBGMEvents;

  /** @type {typeof deleteBGMById} */
  window.deleteBGMById = deleteBGMById;

  /** @type {typeof bgmPlayIdx} */
  window.bgmPlayIdx = bgmPlayIdx;

  /** @type {typeof invalidateTrackCache} */
  window._invalidateTrackCache = invalidateTrackCache;

  // Mutable state via getter/setter
  Object.defineProperty(window, 'currentTrackIdx', {
    get: function() { return currentTrackIdx; },
    set: function(v) { currentTrackIdx = v; }
  });
  Object.defineProperty(window, 'bgmAudio', {
    get: function() { return bgmAudio; }
  });
})();
