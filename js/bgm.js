// ==================== BGM Player ====================
var DEFAULT_BGM = { name: 'Arte Refact - DESIR', path: 'bgm/desir.mp3' };
var currentTrackIdx = -1;
var bgmAudio = new Audio();
bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
bgmAudio.loop = false;
var _trackCache = { ts: 0, items: null };

async function getAllTracks() {
  var defaults = [{
    id: 'default_bgm',
    name: DEFAULT_BGM.name,
    path: DEFAULT_BGM.path,
    url: DEFAULT_BGM.path,
    isDefault: true,
  }];

  if (!sb || !_isLoggedIn) return defaults;
  try {
    var userResult = await sb.auth.getUser();
    var user = userResult.data.user;
    if (!user) return defaults;
  } catch (e) { return defaults; }

  if (_trackCache.items && Date.now() - _trackCache.ts < 30000) {
    return _trackCache.items;
  }

  try {
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
  var track = tracks[currentTrackIdx];
  if (bgmAudio.src) URL.revokeObjectURL(bgmAudio.src);
  bgmAudio.src = track.url || track.path;
  bgmAudio.play().catch(function() {});
  document.getElementById('bgmPlay').textContent = '⏸';
  document.getElementById('bgmPlay').classList.add('playing');
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
  var userResult;
  try { userResult = await sb.auth.getUser(); } catch (e) { return; }
  var user = userResult.data.user;
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
    alert('上传失败: ' + e.message);
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
    var delBtn = !t.isDefault ? '<span class="track-del" onclick="event.stopPropagation();deleteBGMById(' + t.id + ')">✕</span>' : '';
    return '<li class="' + (i === currentTrackIdx ? 'current' : '') + '" onclick="bgmPlayIdx(' + i + ')">' +
      '<span class="track-index">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<span class="track-name">' + t.name + '</span>' + delBtn + '</li>';
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

// ---- Event bindings ----
function bindBGMEvents() {
  document.getElementById('bgmVolume').value = bgmAudio.volume * 100;
  document.getElementById('bgmVolume').addEventListener('input', function() {
    bgmAudio.volume = this.value / 100;
    localStorage.setItem('bgmVolume', this.value / 100);
  });

  document.getElementById('bgmPlay').addEventListener('click', function() {
    if (bgmAudio.paused || !bgmAudio.src) {
      if (!bgmAudio.src) playCurrentTrack();
      else bgmAudio.play().catch(function() {});
      document.getElementById('bgmPlay').textContent = '⏸';
      document.getElementById('bgmPlay').classList.add('playing');
    } else {
      bgmAudio.pause();
      document.getElementById('bgmPlay').textContent = '▶';
      document.getElementById('bgmPlay').classList.remove('playing');
    }
  });

  document.getElementById('bgmNext').addEventListener('click', playNextTrack);
  document.getElementById('bgmPrev').addEventListener('click', playPrevTrack);

  bgmAudio.addEventListener('ended', playNextTrack);

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
}
