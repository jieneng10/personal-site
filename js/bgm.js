// ==================== BGM Player ====================
(function() {
  var DEFAULT_BGM = { name: 'Arte Refact - DESIR', path: 'bgm/desir.mp3' };
  var currentTrackIdx = -1;
  var bgmAudio = new Audio();
  bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
  bgmAudio.loop = false;
  var _bgmInited = false;
  var _bgmUserWantsPlay = false;
  var _bgmNeedsResume = false;
  var _trackCache = { ts: 0, items: null };

  // 用户交互统一入口：首次初始化 OR 切回续播
  function _onUserInteract() {
    if (!_bgmInited) {
      // 首次：初始化并播放
      _bgmInited = true;
      _bgmUserWantsPlay = true;
      var src = bgmAudio.src || DEFAULT_BGM.path;
      if (!bgmAudio.src) bgmAudio.src = src;
      if (bgmAudio.readyState === 0) bgmAudio.load();
      bgmAudio.play().then(function() {
        var btn = document.getElementById('bgmPlay');
        if (btn) { btn.textContent = '⏸'; btn.classList.add('playing'); }
      }).catch(function() {});
    } else if (_bgmNeedsResume && _bgmUserWantsPlay && bgmAudio.paused && !bgmAudio.ended) {
      // 切回续播：visibility 回调中 play() 会因非用户手势被拒，在此恢复
      _bgmNeedsResume = false;
      bgmAudio.play().catch(function() {});
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

    if (!sb || !window._isLoggedIn) return defaults;

    if (_trackCache.items && Date.now() - _trackCache.ts < 30000) {
      return _trackCache.items;
    }

    try {
      var user = await getCachedUser();
      if (!user) return defaults;

      var result = await sb
        .from('user_files')
        .select('*')
        .eq('user_id', user.id)
        .eq('category', 'bgm')
        .order('created_at');

      var data = result.data || [];
      _trackCache.items = defaults.concat(data.map(function(t) {
        return { id: t.id, name: t.name, url: sbPublicUrl('bgm', t.storage_path) };
      }));
      _trackCache.ts = Date.now();
      return _trackCache.items;
    } catch (e) {
      return defaults;
    }
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
    if (!sb) return;
    var user = await getCachedUser();
    if (!user) return;

    showLoading('上传音乐中...');
    try {
      for (var i = 0; i < fileList.length; i++) {
        var file = fileList[i];
        if (!file.type.startsWith('audio/') && !file.name.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i)) continue;
        var path = sbStoragePath(user.id, 'bgm', file.name);
        await sbUpload('bgm', file, path);
        await sb.from('user_files').insert({
          user_id: user.id,
          category: 'bgm',
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

    _trackCache.items = null;
    renderBGMPlaylist();
    var tracks = await getAllTracks();
    currentTrackIdx = tracks.length - 1;
    localStorage.setItem('bgmTrackIdx', currentTrackIdx);
    playCurrentTrack();
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
    if (!sb) return;
    var tracks = await getAllTracks();
    var idx = tracks.findIndex(function(t) { return t.id === id; });
    if (idx < 0 || tracks[idx].isDefault) return;

    try {
      var result = await sb.from('user_files').select('storage_path').eq('id', id).single();
      if (result.data) {
        await sbDelete('bgm', result.data.storage_path);
        await sb.from('user_files').delete().eq('id', id);
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

    // 切出暂停；切回仅设标志——移动端 play() 必须在用户手势内调用
    document.addEventListener('visibilitychange', function() {
      if (document.hidden) {
        if (!bgmAudio.paused) {
          bgmAudio.pause();
          _bgmNeedsResume = _bgmUserWantsPlay;
        }
      } else {
        // 桌面端 visibility 是有效手势，直接续播；移动端会失败，靠下次交互续播
        if (_bgmNeedsResume && _bgmUserWantsPlay && bgmAudio.paused && !bgmAudio.ended) {
          bgmAudio.play().then(function() {
            _bgmNeedsResume = false;
          }).catch(function() {
            // 移动端被拒，_bgmNeedsResume 保持 true，等下次 click/touchend
          });
        }
      }
    });
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
