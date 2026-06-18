// ==================== BGM Player ====================
//
// 【这个文件是什么】
//   个人站点的背景音乐（BGM）播放器模块。
//   负责曲目加载（默认曲目 + Supabase 云端 + IndexedDB 本地）、播放控制、
//   播放列表 UI 渲染、音频文件上传（云端/本地）、以及相关的 DOM 事件绑定。
//
// 【数据流向】
//   曲目来源有三层，按优先级拼合：
//     1. DEFAULT_BGMS（硬编码的默认曲目，始终存在）
//     2. Supabase user_files 表（category='bgm'，登录用户或 guest 上传）
//     3. IndexedDB PersonalSiteDB.tracks（未登录时落地的本地曲目）
//   → _fetchAllTracks() 合并三者 → createCache 包装为 30 秒缓存
//   → getAllTracks() 供播放器/播放列表调用
//
// 【与 window 全局变量的关系】
//   - 读取 window.sb（Supabase 客户端）、window._isLoggedIn（登录状态）
//   - 读取 window.createCache（缓存工厂，来自 utils.js）
//   - 读取 window.EventBus（跨模块事件总线，来自 event-bus.js）
//   - 调用 window.sbPublicUrl / sbStoragePath / sbUpload / sbDelete / saveToLocalDB
//     （来自 supabase.js / common.js）
//   - 调用 window.showLoading / hideLoading / showToast / escHtml / safeSetItem
//     （来自 utils.js / common.js）
//   - 调用 window.getCachedUser（来自 supabase.js）
//   - 向 window 导出：DEFAULT_BGMS, getAllTracks, playCurrentTrack,
//     renderBGMPlaylist, bindBGMEvents, deleteBGMById, bgmPlayIdx,
//     _invalidateTrackCache, currentTrackIdx (getter/setter), bgmAudio (getter)
//
// 【为什么用 IIFE】
//   避免污染全局作用域。内部变量 currentTrackIdx、bgmAudio、_bgmInited 等
//   对外不可见，只有通过 window 导出的 API 才能访问/修改。
//

import { sb, sbStoragePath, sbUpload, sbPublicUrl, sbDelete, saveToLocalDB, getCachedUser, showLoading, hideLoading, showToast, escHtml } from './supabase.mjs';
import { createCache } from './cache.mjs';
import { safeSetItem } from './config.mjs';

// =========================================================================
// 默认曲目列表
// =========================================================================

/**
 * 硬编码的默认 BGM 曲目。
 * 即使没有网络、没有登录、没有本地文件，这些曲目也始终可用。
 *
 * @type {{ name: string, path: string }[]}
 */
var DEFAULT_BGMS = [
  { name: 'Arte Refact - DESIR', path: 'bgm/desir.mp3' },
  { name: '雪 - May day+', path: 'bgm/snow.mp3' },
  { name: 'riya - one of a kind', path: 'bgm/riya_one.mp3' },
];

// =========================================================================
// 模块内部状态（闭包私有，外部不可直接访问）
// =========================================================================

/** 当前播放的曲目在曲目列表中的索引。-1 表示尚未选中任何曲目。 */
var currentTrackIdx = -1;

/**
 * 全局唯一的 Audio 元素。整个页面只用一个 Audio 实例，而不是每次播放新建，
 * 这样可以避免多个音频同时播放、资源浪费和状态混乱。
 */
var bgmAudio = new Audio();
bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
bgmAudio.loop = false;       // 不循环单曲——由 ended 事件驱动自动切下一首
// 懒加载策略：明确设置 preload='none'，浏览器不会在页面加载时预取任何音频数据。
// 音频数据仅在以下时机按需加载：
//   1. 用户首次交互（_onUserInteract）→ 加载默认第一首
//   2. 切歌（playCurrentTrack）→ 设置 src 后显式调用 load() 再 play()
// 这样避免了页面加载时同时拉取多首大文件（前 3 首默认曲目合计约 31MB），
// 只在真正要播放时才发起网络请求。
bgmAudio.preload = 'none';

/**
 * 标记 BGM 是否已初始化（即用户已完成首次交互，Audio 已加载并开始播放）。
 * 浏览器自动播放策略要求：audio.play() 必须在用户手势（click/touchend）中
 * 或之后调用，否则会被浏览器静默拒绝。此标记确保我们不会在用户交互前尝试播放。
 */
var _bgmInited = false;

// =========================================================================
// 数据获取层（由 createCache 包装）
// =========================================================================

/**
 * @typedef {object} TrackItem
 * @property {string|number} id       - 曲目标识（Supabase 用数字 id，本地用 local_ 前缀字符串）
 * @property {string}        name     - 曲目显示名
 * @property {string}        url      - 可播放的音频 URL（或默认曲目的相对路径）
 * @property {string}        [path]   - 相对路径（仅默认曲目）
 * @property {boolean}       [isDefault] - 是否为默认曲目（默认曲目不可删除）
 */

/**
 * _fetchAllTracks —— 获取所有音频曲目。
 *
 * 【它做什么】
 *   从三个来源获取曲目并按顺序合并：默认曲目 → Supabase 云端 → IndexedDB 本地。
 *   这是整个 BGM 模块的"数据源"函数。
 *
 * 【数据流向】
 *   1. DEFAULT_BGMS 直接映射为 TrackItem[]
 *   2. 如果 sb 存在，查询 Supabase user_files 表（category='bgm', published=true）
 *      → 用 sbPublicUrl() 构造公开访问 URL
 *   3. 如果 Supabase 不可用或查询失败，从 IndexedDB PersonalSiteDB.tracks 读取本地文件
 *      → 用 URL.createObjectURL(blob) 构造临时 URL
 *   4. 三者在内存中拼接，不做持久化去重
 *
 * 【输入】
 *   无参数。依赖全局 sb、window._isLoggedIn、IndexedDB。
 *
 * 【输出】
 *   Promise<TrackItem[]> — 所有可用曲目的数组。
 *
 * 【调用者】
 *   getAllTracks()（内部）、track cache 的 factory 函数。
 *
 * 【为什么这么做】
 *   三层优先级确保用户在离线、未登录、无数据时仍能听到默认曲目。
 *   云端和本地数据不做去重——因为三条数据源的来源不同，不应互相覆盖。
 */
async function _fetchAllTracks() {
  var defaults = DEFAULT_BGMS.map(function(b, i) {
    return { id: 'default_bgm_' + i, name: b.name, path: b.path, url: b.path, isDefault: true };
  });

  var cloudTracks = [];
  var localTracks = [];

  // Supabase cloud (RLS auto-filters)
  if (sb) {
    try {
      var result = await sb
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

/**
 * _trackCache —— 曲目列表缓存。
 *
 * 【它做什么】
 *   用 createCache 包装 _fetchAllTracks，缓存 30 秒。
 *   30 秒内重复调用 getAllTracks() 直接返回缓存，不重新查数据库。
 *
 * 【为什么 30 秒】
 *   曲目列表变更不频繁（用户上传/删除时才变），30 秒足够覆盖一次页面交互周期。
 *   太短则缓存无意义，太长则上传后列表不刷新。
 */
var _trackCache = createCache
  ? createCache(_fetchAllTracks, 30000)
  : null;

/**
 * getAllTracks —— 获取所有可用曲目（带缓存）。
 *
 * 【它做什么】
 *   返回合并后的曲目列表。优先走缓存，缓存不存在/过期则直接调用 _fetchAllTracks。
 *
 * 【输入】
 *   无。
 *
 * 【输出】
 *   Promise<TrackItem[]> — 所有曲目。
 *
 * 【调用者】
 *   playCurrentTrack()、playNextTrack()、playPrevTrack()、renderBGMPlaylist()、
 *   deleteBGMById()、handleBGMFiles()。
 *   也通过 window.getAllTracks 暴露给外部（如 admin.js 调用刷新列表）。
 *
 * 【副作用】
 *   无副作用。纯读操作。
 */
async function getAllTracks() {
  if (_trackCache) return _trackCache.get();
  return _fetchAllTracks();
}

/**
 * invalidateTrackCache —— 使曲目缓存失效。
 *
 * 【它做什么】
 *   清空 _trackCache，下次调用 getAllTracks() 时强制重新获取。
 *
 * 【调用者】
 *   handleBGMFiles()（上传后）、deleteBGMById()（删除后）、
 *   EventBus 'cache:invalidate:tracks' 事件回调（admin.js 触发）。
 *
 * 【为什么单独抽一个函数】
 *   因为多处需要刷新缓存，且通过 window._invalidateTrackCache 暴露给外部模块
 *   （如 admin.js 管理员操作后需要刷新前端曲目列表）。
 */
function invalidateTrackCache() {
  if (_trackCache) _trackCache.invalidate();
}

// =========================================================================
// IndexedDB 辅助函数 —— 本地曲目读写删
// =========================================================================

/**
 * _readLocalTracks —— 从 IndexedDB 读取本地保存的音频文件。
 *
 * 【它做什么】
 *   打开 PersonalSiteDB 数据库，读取 tracks object store 中的所有记录，
 *   将每条记录的 ArrayBuffer 包装成 Blob → Object URL，返回 TrackItem 数组。
 *
 * 【数据流向】
 *   IndexedDB PersonalSiteDB.tracks → ArrayBuffer → Blob → URL.createObjectURL()
 *   → TrackItem[]（id 前缀 'local_' 以区分云端数据）
 *
 * 【输入】
 *   无。
 *
 * 【输出】
 *   Promise<TrackItem[]> — IndexedDB 中的本地曲目列表。
 *
 * 【调用者】
 *   _fetchAllTracks()。
 *
 * 【为什么用 Object URL 而不是 base64】
 *   音频文件可能很大（几 MB 到几十 MB），Object URL 是浏览器原生的 blob 引用，
 *   不占用 JS 堆内存，性能远优于 base64 转换。
 */
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

/**
 * _deleteLocalTrack —— 从 IndexedDB 删除指定曲目。
 *
 * 【它做什么】
 *   打开 PersonalSiteDB，在 tracks store 中删除指定 id 的记录。
 *
 * 【输入】
 *   id — 曲目标识（与 _readLocalTracks 生成的 id 匹配）
 *
 * 【输出】
 *   Promise<void>
 *
 * 【调用者】
 *   deleteBGMById()（当删除的是本地曲目时）。
 */
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
// First-interaction gate — 推迟音频加载直到用户首次交互
// =========================================================================

/**
 * _interactDone / _onUserInteract —— 首次交互门控。
 *
 * 【它做什么】
 *   在用户首次点击或触摸屏幕之前，不加载任何音频资源。
 *   首次交互时加载第一首默认曲目并尝试自动播放。
 *
 * 【为什么这么做】
 *   现代浏览器（Chrome/Safari/Firefox）均有自动播放策略：
 *   页面加载时 audio.play() 会被静默拒绝（返回 rejected promise）。
 *   必须在用户手势（click/touchend）中或之后才能成功播放音频。
 *   这里用"首次交互"作为触发点，既满足浏览器策略，又避免冷加载时的资源浪费。
 *
 * 【副作用】
 *   设置 bgmAudio.src、调用 bgmAudio.play()、更新播放按钮 UI。
 */
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
// 播放控制
// =========================================================================

/**
 * playCurrentTrack —— 播放当前索引指向的曲目。
 *
 * 【它做什么】
 *   获取所有曲目，取 currentTrackIdx 对应的曲目，设置 bgmAudio.src 并播放。
 *   如果同一曲目已经在播放则跳过（避免中断当前播放）。
 *   如果尚未初始化（用户未交互），仅更新 UI 但不实际加载音频。
 *
 * 【输入】
 *   无。依赖闭包变量 currentTrackIdx、_bgmInited。
 *
 * 【输出】
 *   Promise<void>
 *
 * 【调用者】
 *   bgmPlayIdx()、playNextTrack()、playPrevTrack()、bgmPlay 按钮点击、
 *   handleBGMFiles()（上传后自动播放新曲目）、deleteBGMById()（删除后切换曲目）。
 *
 * 【副作用】
 *   - 修改 bgmAudio.src，触发媒体加载
 *   - 调用 bgmAudio.play()
 *   - 更新 DOM：bgmPlay 按钮文字/样式、bgmTrackName 文本
 *   - 调用 renderBGMPlaylist() 刷新列表高亮
 *   - 释放之前 blob: URL（如果有）
 *
 * 【为什么做文件名精确比较】
 *   两个 URL 可能因为 host/query string 不同但指向同一个文件，
 *   通过提取文件名（去掉路径前缀和 query string）做精确比较，
 *   避免同名文件被误判为不同文件而重复加载。
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
  bgmAudio.load();   // 懒加载：preload='none' 时设置 src 后需显式 load() 才会开始取数据
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

/**
 * playNextTrack —— 播放下一首。
 *
 * 【它做什么】
 *   currentTrackIdx 循环 +1（到达末尾回到 0），然后调用 playCurrentTrack()。
 *
 * 【调用者】
 *   bgmNext 按钮点击事件、bgmAudio 'ended' 事件（一首播完自动切）。
 */
function playNextTrack() {
  getAllTracks().then(function(tracks) {
    if (tracks.length === 0) return;
    currentTrackIdx = (currentTrackIdx + 1) % tracks.length;
    playCurrentTrack();
  });
}

/**
 * playPrevTrack —— 播放上一首。
 *
 * 【它做什么】
 *   currentTrackIdx 循环 -1（到达 0 回到末尾），然后调用 playCurrentTrack()。
 *
 * 【调用者】
 *   bgmPrev 按钮点击事件。
 */
function playPrevTrack() {
  getAllTracks().then(function(tracks) {
    if (tracks.length === 0) return;
    currentTrackIdx = (currentTrackIdx - 1 + tracks.length) % tracks.length;
    playCurrentTrack();
  });
}

/**
 * bgmPlayIdx —— 设置曲目索引并开始播放。
 *
 * 【它做什么】
 *   设置 currentTrackIdx 为 i，然后调用 playCurrentTrack()。
 *   这是从播放列表点击曲目时的入口函数。
 *
 * 【输入】
 *   i — 曲目索引（number）
 *
 * 【调用者】
 *   播放列表 li[data-track-index] 的 click 事件委托。
 *   也通过 window.bgmPlayIdx 暴露给外部。
 */
function bgmPlayIdx(i) {
  currentTrackIdx = i;
  playCurrentTrack();
}

// =========================================================================
// 上传 / 添加曲目
// =========================================================================

/**
 * handleBGMFiles —— 处理用户上传或拖放的音频文件。
 *
 * 【它做什么】
 *   接收 FileList，过滤出音频文件，然后根据登录状态选择上传目标：
 *     - 已登录 → Supabase user_files（published=true，直接可见）
 *     - 有 sb 但未登录 → Supabase user_files（published=false，需管理员审核）
 *     - 无 sb → IndexedDB 本地存储
 *   上传完成后刷新缓存、重渲染播放列表、自动播最后一首。
 *
 * 【数据流向】
 *   FileList → 过滤音频 → (Supabase Storage + user_files 表) 或 (IndexedDB PersonalSiteDB.tracks)
 *   → invalidateTrackCache() → renderBGMPlaylist() → playCurrentTrack()
 *
 * 【输入】
 *   fileList — FileList 对象（来自 input[type=file] 或拖放事件的 e.dataTransfer.files）
 *
 * 【输出】
 *   Promise<void>
 *
 * 【调用者】
 *   bgmDropZone 的 click（触发文件选择器）和 drop（拖放）事件处理器。
 *
 * 【副作用】
 *   - 上传到 Supabase Storage + 写入 user_files 表
 *   - 或写入 IndexedDB
 *   - 显示 loading / toast 提示
 *   - 刷新曲目缓存和播放列表
 *   - 自动播放新上传的最后一首
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
  if (sb && window._isLoggedIn) {
    user = await getCachedUser();
  }

  if (user) {
    showLoading('上传到云端...');
    try {
      for (var j = 0; j < audioFiles.length; j++) {
        var cf = audioFiles[j];
        var path = sbStoragePath(user.id, 'bgm', cf.name);
        await sbUpload('bgm', cf, path);
        await sb.from('user_files').insert({
          user_id: user.id, category: 'bgm', published: true,
          name: cf.name, size: cf.size, mime_type: cf.type, storage_path: path,
        });
      }
      showToast('已上传 ' + audioFiles.length + ' 首到云端', 'success');
    } catch (e) {
      showToast('云端上传失败: ' + (e.message || '请检查网络'), 'error');
      await _saveToLocalDB(audioFiles);
    } finally { hideLoading(); }
  } else if (sb) {
    showLoading('上传到云端...');
    try {
      for (var k = 0; k < audioFiles.length; k++) {
        var gf = audioFiles[k];
        var gpath = 'guest/' + Date.now().toString(36) + '_' + gf.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        await sbUpload('bgm', gf, gpath);
        await sb.from('user_files').insert({
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
  safeSetItem('bgmTrackIdx', currentTrackIdx);
  playCurrentTrack();
}

/**
 * _saveToLocalDB —— 将音频文件保存到 IndexedDB。
 *
 * 【它做什么】
 *   将 File 对象读取为 ArrayBuffer，存入 IndexedDB PersonalSiteDB.tracks store。
 *
 * 【数据流向】
 *   File[] → File.arrayBuffer() → IndexedDB PersonalSiteDB.tracks
 *
 * 【输入】
 *   audioFiles — File 对象数组
 *
 * 【输出】
 *   Promise<void>
 *
 * 【调用者】
 *   handleBGMFiles()（云端上传失败或用户未登录时的 fallback）。
 *
 * 【副作用】
 *   - 显示 loading / toast
 *   - 写入 IndexedDB
 */
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
// 播放列表 & 删除
// =========================================================================

/**
 * renderBGMPlaylist —— 重新渲染 BGM 播放列表。
 *
 * 【它做什么】
 *   获取所有曲目，用 <li> 渲染到 #bgmPlaylist 容器。
 *   当前播放的曲目添加 .current 类高亮。
 *   非默认曲目显示删除按钮（✕）。
 *
 * 【输入】
 *   无。依赖 getAllTracks() 和闭包 currentTrackIdx。
 *
 * 【输出】
 *   Promise<void>
 *
 * 【调用者】
 *   playCurrentTrack()、handleBGMFiles()、deleteBGMById()、
 *   bgmPlaylistBtn/btnBgm 点击（打开 BGM Modal）。
 *   也通过 window.renderBGMPlaylist 暴露给外部。
 *
 * 【副作用】
 *   修改 #bgmPlaylist 的 innerHTML。
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
 * deleteBGMById —— 按 id 删除曲目（云端或本地）。
 *
 * 【它做什么】
 *   根据 id 类型判断是云端（number）还是本地（string），执行对应删除逻辑。
 *   删除后更新 currentTrackIdx（如果删的是当前曲目则切换到前一首）、
 *   刷新缓存、重渲染播放列表。
 *
 * 【数据流向】
 *   id 为 number → Supabase: 查 storage_path → sbDelete('bgm', path) → 删 user_files 行
 *   id 为 string → IndexedDB: _deleteLocalTrack(id)
 *   → invalidateTrackCache() → 调整 currentTrackIdx → renderBGMPlaylist()
 *
 * 【输入】
 *   id — 曲目标识（number=云端, string=本地）
 *
 * 【输出】
 *   Promise<void>
 *
 * 【调用者】
 *   播放列表中删除按钮的 click 事件委托。
 *   也通过 window.deleteBGMById 暴露（admin.js 可能调用）。
 *
 * 【为什么 require sb】
 *   删除操作需要 Supabase 客户端权限（删除 Storage 文件 + DB 行）。
 *   如果没有 sb 则不执行，避免无意义的错误。
 *
 * 【为什么删除后切换到前一首而不是下一首】
 *   用户体验：删除当前播放的曲目后，退到前一首比跳到下一首更符合
 *   "撤销" 的直觉（用户可能误删，前一首是刚听过的）。
 */
async function deleteBGMById(id) {
  if (!sb) return;
  var tracks = await getAllTracks();
  var idx = tracks.findIndex(function(t) { return t.id === id; });
  if (idx < 0 || tracks[idx].isDefault) return;

  try {
    if (typeof id === 'number') {
      var result = await sb.from('user_files').select('storage_path').eq('id', id).single();
      if (result.data) {
        await sbDelete('bgm', result.data.storage_path);
        await sb.from('user_files').delete().eq('id', id);
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
    safeSetItem('bgmTrackIdx', currentTrackIdx);
  }
  renderBGMPlaylist();
}

// =========================================================================
// 事件绑定 —— bindBGMEvents
// =========================================================================

/**
 * bindBGMEvents —— 绑定所有 BGM 相关 DOM 事件。
 *
 * 【它做什么】
 *   一次性绑定以下事件：
 *     - 音量滑块 → bgmAudio.volume + localStorage 持久化
 *     - 播放/暂停按钮 → bgmAudio.play()/pause()
 *     - 上一首/下一首按钮 → playPrevTrack()/playNextTrack()
 *     - audio ended → 自动切下一首
 *     - audio timeupdate → 更新进度条 + 当前时间
 *     - audio loadedmetadata → 更新总时长
 *     - 进度条 click/touch → seek
 *     - 播放列表 click 委托 → 切歌 / 删除
 *     - 打开/关闭 BGM Modal
 *     - 文件上传（拖放 + 点击选择）
 *     - 移动端展开按钮
 *
 * 【输入】
 *   无。依赖全局 DOM 元素（#bgmPlay, #bgmNext, #bgmModal 等）。
 *
 * 【输出】
 *   无。
 *
 * 【调用者】
 *   页面初始化时由 main.js 调用（通过 window.bindBGMEvents）。
 *
 * 【为什么一次性绑定而不是按需绑定】
 *   BGM 相关 DOM 在页面加载时即存在且不会动态重建（除播放列表内容外）。
 *   一次性绑定简化了生命周期管理，避免重复绑定的问题。
 *
 * 【为什么在移动端动态创建展开按钮】
 *   展开按钮和 BGM 播放器是紧耦合的，放在这里比放在 HTML 模板里更灵活——
 *   可以按需决定是否显示（比如 PC 端不需要）。
 */
function bindBGMEvents() {
  document.getElementById('bgmVolume').value = bgmAudio.volume * 100;
  document.getElementById('bgmVolume').addEventListener('input', function() {
    bgmAudio.volume = this.value / 100;
    safeSetItem('bgmVolume', this.value / 100);
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
    /**
     * seekFromEvent —— 根据鼠标/触摸位置计算并跳转到对应时间。
     *
     * 【它做什么】
     *   获取进度条容器的 getBoundingClientRect，按点击/触摸的水平位置
     *   计算百分比，设置 bgmAudio.currentTime 实现跳转。
     *
     * 【为什么同时支持 click 和 touch】
     *   桌面端用 click，移动端用 touch。通过 e.touches 判断事件类型。
     *   touchstart 时额外绑定 touchmove + touchend 实现拖拽 seek。
     */
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
   * formatTime —— 格式化秒数为 m:ss 格式。
   *
   * 【它做什么】
   *   将秒数转为 分:秒 格式，秒数始终两位（补零）。
   *
   * 【输入】
   *   sec — 秒数（number）
   *
   * 【输出】
   *   string — 格式化后的时间字符串，如 "3:05"
   *
   * 【为什么显式检查 null/NaN/Infinity】
   *   B-15: isFinite(null) 返回 true（JS 类型转换陷阱），
   *   需要先检查 null/undefined，再检查 isNaN 和 isFinite。
   */
  function formatTime(sec) {
    // B-15: null/undefined 也会被 isFinite(null)===true 绕过，加显式 null 检查
    if (sec == null || isNaN(sec) || !isFinite(sec)) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // Playlist event delegation —— 播放列表内的点击统一在这里处理
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

  // Open BGM modal —— 两个入口按钮（桌面端 + 移动端）
  document.getElementById('bgmPlaylistBtn').addEventListener('click', function() {
    document.getElementById('bgmModal').classList.remove('hidden');
    renderBGMPlaylist();
  });
  document.getElementById('btnBgm').addEventListener('click', function() {
    document.getElementById('bgmModal').classList.remove('hidden');
    renderBGMPlaylist();
  });
  // Close BGM modal —— 点击背景遮罩关闭
  document.getElementById('bgmModal').addEventListener('click', function(e) {
    if (e.target === this) { e.stopPropagation(); this.classList.add('hidden'); }
  });

  // BGM drop zone —— 支持点击选择文件 + 拖放
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

  // Mobile BGM expand toggle —— 小屏设备上折叠/展开播放器
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

// =========================================================================
// 跨模块通信 —— 监听 admin 面板发出的缓存失效事件
// =========================================================================

/**
 * 监听 EventBus 的 'cache:invalidate:tracks' 事件。
 *
 * 【数据流向】
 *   admin.js（管理员操作）→ EventBus.emit('cache:invalidate:tracks')
 *   → invalidateTrackCache() → 下次 getAllTracks() 强制重新获取
 *
 * 【为什么用 EventBus 而不是直接调用】
 *   bgm.js 和 admin.js 是独立模块，不应该互相 import。
 *   EventBus 提供了解耦的发布/订阅机制，admin.js 不需要知道 bgm.js 的存在。
 */
if (typeof window.EventBus !== 'undefined') {
  window.EventBus.on('cache:invalidate:tracks', function() {
    invalidateTrackCache();
  });
}

// =========================================================================
// window exports —— 暴露给其他模块和页面脚本的 API
// =========================================================================

/**
 * 暴露 DEFAULT_BGMS 常量，供其他模块（如 main.js 初始化）读取默认曲目列表。
 * @type {typeof DEFAULT_BGMS}
 */
window.DEFAULT_BGMS = DEFAULT_BGMS;

/**
 * 暴露 getAllTracks，供 admin.js 等模块获取完整曲目列表。
 * @type {typeof getAllTracks}
 */
window.getAllTracks = getAllTracks;

/**
 * 暴露 playCurrentTrack，供 main.js 在页面恢复时续播。
 * @type {typeof playCurrentTrack}
 */
window.playCurrentTrack = playCurrentTrack;

/**
 * 暴露 renderBGMPlaylist，供 admin.js 在管理操作后刷新列表。
 * @type {typeof renderBGMPlaylist}
 */
window.renderBGMPlaylist = renderBGMPlaylist;

/**
 * 暴露 bindBGMEvents，供 main.js 在 DOM 就绪时调用。
 * @type {typeof bindBGMEvents}
 */
window.bindBGMEvents = bindBGMEvents;

/**
 * 暴露 deleteBGMById，供 admin.js 远程删除曲目。
 * @type {typeof deleteBGMById}
 */
window.deleteBGMById = deleteBGMById;

/**
 * 暴露 bgmPlayIdx，供外部直接跳转播放指定索引曲目。
 * @type {typeof bgmPlayIdx}
 */
window.bgmPlayIdx = bgmPlayIdx;

/**
 * 暴露缓存失效函数（以下划线前缀标记为"内部用"）。
 * @type {typeof invalidateTrackCache}
 */
window._invalidateTrackCache = invalidateTrackCache;

// 可变状态的 getter/setter —— 通过 Object.defineProperty 暴露

/**
 * currentTrackIdx 的 getter/setter。
 * 外部可以通过 window.currentTrackIdx 读取或设置当前曲目索引。
 * main.js 在页面恢复时会设置此值来恢复播放位置。
 */
Object.defineProperty(window, 'currentTrackIdx', {
  get: function() { return currentTrackIdx; },
  set: function(v) { currentTrackIdx = v; }
});

/**
 * bgmAudio 的只读 getter。
 * 外部可以读取 Audio 实例（如 main.js 检查播放状态），但不能替换。
 */
Object.defineProperty(window, 'bgmAudio', {
  get: function() { return bgmAudio; }
});

export { DEFAULT_BGMS, getAllTracks, playCurrentTrack, renderBGMPlaylist, bindBGMEvents, deleteBGMById, bgmPlayIdx, _invalidateTrackCache };

