/**
 * cloud.js — 云端文件管理 (网盘功能)
 *
 * 【它做什么】
 *   提供用户私有的云端文件存储功能:
 *   - 文件列表渲染 (从 Supabase user_files 表读取)
 *   - 文件上传 (拖拽 / 点击选择，客户端校验类型和大小)
 *   - 文件下载 (生成 Supabase Signed URL)
 *   - 文件删除 (同时清理 Storage 和数据库记录)
 *   - 存储空间用量展示 (进度条 + 文字)
 *   - 一键清空所有文件
 *   - IndexedDB → Supabase 数据迁移 (旧版本地数据迁移到云端)
 *
 * 【数据流】
 *   上传: 用户选择文件 → 客户端校验 → Supabase Storage (bucket: 'files') → user_files 表 INSERT
 *   下载: user_files 表查询 storage_path → Supabase Signed URL → <a download> 触发下载
 *   删除: user_files 表查询 storage_path → Supabase Storage DELETE → user_files 表 DELETE
 *   渲染: user_files 表 SELECT (按 user_id + category: 'cloud') → DOM (#fileList)
 *   迁移: IndexedDB (PersonalSiteDB) → 读取 Blob → Supabase Storage 上传 → user_files 表 INSERT
 *
 * 【数据库表】
 *   user_files 表结构 (Supabase):
 *     id            — serial primary key
 *     user_id       — uuid, 关联 auth.users
 *     category      — text, 文件分类: 'cloud' | 'wallpaper' | 'bgm' | 'avatar'
 *     name          — text, 原始文件名
 *     size          — integer, 文件大小 (bytes)
 *     mime_type     — text, MIME 类型
 *     storage_path  — text, Supabase Storage 中的路径
 *     created_at    — timestamptz
 *
 * 【与 window 全局变量的关系】
 *   读取:
 *     sb, sbStoragePath, sbUpload, sbSignedUrl, sbDelete,
 *     getCachedUser, showToast, showLoading, hideLoading, escHtml (all imported)
 *     window._isLoggedIn     — 登录状态标记 (由 settings.js 注入)
 *
 *   写入 (暴露给外部):
 *     window.renderFileList       — 渲染文件列表 (供 settings.js 登录后回调)
 *     window.downloadFile         — 下载文件 (供事件委托调用)
 *     window.removeFile           — 删除文件 (供事件委托调用)
 *     window.clearCloudData       — 清空所有文件 (供设置页调用)
 *     window.migrateLocalToCloud  — IndexedDB 迁移 (供管理面板调用)
 *     window.bindCloudEvents      — 事件绑定 (供 main.js 初始化调用)
 *
 * 【副作用】
 *   - 读写 Supabase (user_files 表 + Storage)
 *   - 读取 IndexedDB (PersonalSiteDB, 迁移时)
 *   - 修改 DOM (#fileList, #storageText, #storageBar)
 *   - 调用 showToast / showLoading / hideLoading
 */

import { tSync } from './i18n.js';

import { sb, sbStoragePath, sbUpload, sbPublicUrl, sbSignedUrl, sbDelete, saveToLocalDB, getCachedUser, showLoading, hideLoading, showToast, escHtml } from './supabase.mjs';

// ==================== Cloud Drive ====================

// ============================
// 工具函数
// ============================

// formatFileSize is provided by supabase.js on window

/**
 * getFileIcon()
 *
 * 【它做什么】
 *   根据文件扩展名返回对应的 emoji 图标。
 *   覆盖常见文件类型: 文档/图片/音频/视频/压缩包/文本/代码。
 *   未知类型返回 📁 (文件夹图标)。
 *
 * 【为什么用 emoji 而不是图标字体】
 *   1. 零外部依赖，不需要加载图标库
 *   2. emoji 在所有平台上原生渲染，无兼容性问题
 *   3. 足够覆盖常见文件类型的视觉区分需求
 *
 * 【输入】name — string，文件名 (如 "report.pdf")
 * 【输出】string — 单个 emoji 字符
 * 【调用者】renderFileList()
 */
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

// ============================
// 文件列表渲染
// ============================

/**
 * renderFileList()
 *
 * 【它做什么】
 *   从 Supabase 查询当前用户的 cloud 分类文件，渲染到 #fileList。
 *   未登录时显示登录提示；无文件时显示空状态提示。
 *   每条文件显示: 图标 + 文件名 + 大小 + 日期 + 下载/删除按钮。
 *
 * 【为什么渲染完成后调用 updateStorageInfo】
 *   存储空间用量需要最新的文件列表数据。
 *   在同一个查询结果后立即更新，保证数据一致性。
 *
 * 【错误处理】
 *   查询失败时显示 "加载失败，请检查网络"。
 *   不抛出异常，避免破坏页面其他功能。
 *
 * 【输入】无
 * 【输出】无 (void, async)
 * 【副作用】修改 #fileList 的 innerHTML (DOM 写入)
 * 【调用者】
 *   - 外部: window.renderFileList (登录成功后调用)
 *   - 内部: handleFiles() 上传完成后
 *   - 内部: removeFile() 删除完成后
 *   - 内部: clearCloudData() 清空完成后
 *   - 内部: migrateLocalToCloud() 迁移完成后
 */
async function renderFileList() {
  var list = document.getElementById('fileList');

  // 未初始化或未登录 → 空状态
  if (!sb || !window._isLoggedIn) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>' + tSync('cloud.emptyLogin') + '</div></div>';
    return;
  }

  try {
    var user = await getCachedUser();
    if (!user) {
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>请先登录</div></div>';
      return;
    }

    // 查询当前用户的 cloud 分类文件，按创建时间倒序
    var result = await sb
      .from('user_files')
      .select('*')
      .eq('user_id', user.id)
      .eq('category', 'cloud')
      .order('created_at', { ascending: false });

    var files = result.data || [];
    if (files.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>' + tSync('cloud.emptyNoFiles') + '</div></div>';
    } else {
      // 构建文件列表 HTML
      // data-file-download 和 data-file-remove 属性用于事件委托
      list.innerHTML = files.map(function(f) {
        return '<div class="file-item">' +
          '<div class="file-info">' +
            '<span class="file-icon">' + getFileIcon(f.name) + '</span>' +
            '<span class="file-name" title="' + escHtml(f.name) + '">' + escHtml(f.name) + '</span>' +
          '</div>' +
          '<div class="file-meta">' + window.formatFileSize(f.size || 0) + ' · ' + (f.created_at || '').slice(0, 10) + '</div>' +
          '<div class="file-actions">' +
            '<button class="file-btn" data-file-download="' + f.id + '" title="' + tSync('cloud.downloadTitle') + '">⬇</button>' +
            '<button class="file-btn danger" data-file-remove="' + f.id + '" title="' + tSync('cloud.deleteTitle') + '">✕</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    // 每次渲染后更新存储空间用量
    updateStorageInfo();
  } catch (e) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>' + tSync('cloud.loadFailed') + '</div></div>';
  }
}

// escHtml is now imported from supabase.mjs — no local fallback wrapper needed.

// ============================
// 存储空间信息
// ============================

/**
 * updateStorageInfo()
 *
 * 【它做什么】
 *   计算当前用户 cloud 分类文件的总大小，更新存储空间进度条和文字。
 *
 * 【为什么最大值是 100 MB】
 *   Supabase 免费计划的 Storage 限制。防止用户无限制上传。
 *   100 * 1048576 = 104857600 bytes ≈ 100 MB。
 *
 * 【进度条逻辑】
 *   用 Math.min(100, pct) 防止超出 100% (用户可能已有接近上限的文件)。
 *
 * 【为什么用 reduce 而非 SUM 查询】
 *   Supabase REST API 不直接支持 SUM 聚合。
 *   客户端聚合对于小数据量 (< 几百条) 足够高效。
 *
 * 【输入】无
 * 【输出】无 (void, async)
 * 【副作用】
 *   - 修改 #storageText 的 textContent (DOM 写入)
 *   - 修改 #storageBar 的 style.width (DOM 写入)
 * 【调用者】renderFileList()
 */
async function updateStorageInfo() {
  if (!sb) return;
  try {
    var user = await getCachedUser();
    if (!user) return;

    // 查询当前用户所有 cloud 文件的大小 (只 select size，减少数据传输)
    var result = await sb
      .from('user_files')
      .select('size')
      .eq('user_id', user.id)
      .eq('category', 'cloud');

    // 客户端聚合总大小
    var total = (result.data || []).reduce(function(s, f) { return s + (f.size || 0); }, 0);
    var maxSize = 100 * 1048576; // 100 MB
    var pct = Math.min(100, (total / maxSize) * 100);

    document.getElementById('storageText').textContent = tSync('cloud.storageUsed') + window.formatFileSize(total);
    document.getElementById('storageBar').style.width = pct + '%';
  } catch (e) { /* ignore — 存储信息展示失败不影响核心功能 */ }
}

// ============================
// 文件上传
// ============================

/**
 * handleFiles()
 *
 * 【它做什么】
 *   接收用户选择的文件列表，进行客户端校验后上传到 Supabase。
 *   校验内容:
 *     1. 文件大小 ≤ 50 MB (单文件限制)
 *     2. 文件扩展名在白名单内
 *   上传流程:
 *     for each file:
 *       1. 上传二进制到 Supabase Storage (bucket: 'files')
 *       2. 写入 user_files 表记录
 *
 * 【为什么不是并行上传】
 *   顺序上传 (for + await) 的好处:
 *     1. 避免并发写 user_files 表导致的主键冲突风险
 *     2. 加载动画持续到最后一个文件完成
 *     3. Supabase 免费计划有并发请求限制
 *   缺点: 大量文件时较慢，但单次上传文件数通常很少 (< 5)
 *
 * 【为什么用客户端白名单校验】
 *   1. 减少无效的网络请求 — 在本地就拦掉不支持的类型
 *   2. 安全: 即使跳过客户端校验，Supabase RLS 策略也有服务端限制
 *   3. 防御纵深: 客户端 + 服务端双重校验
 *
 * 【输入】
 *   fileList — FileList 对象 (来自 input[type=file] 或拖拽事件)
 * 【输出】无 (void, async)
 * 【副作用】
 *   - 上传文件到 Supabase Storage
 *   - 写入 user_files 表
 *   - 调用 showToast / showLoading / hideLoading
 *   - 上传成功后刷新文件列表
 * 【调用者】
 *   - #fileInput change 事件
 *   - #dropZone drop 事件
 */
async function handleFiles(fileList) {
  if (!sb) return;
  var user = await getCachedUser();
  if (!user) return;

  // ========================================
  // 客户端校验: 文件大小和类型
  // ========================================
  var MAX_FILE_SIZE = 50 * 1048576; // 50MB 单文件上限

  // 允许的文件扩展名白名单
  // 覆盖: 文档/图片/音频/视频/压缩包/文本/代码/字体
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
      return; // 任一文件不合规就中止全部上传
    }
    var ext = f.name.split('.').pop().toLowerCase();
    if (ALLOWED_EXTS.indexOf(ext) === -1) {
      showToast(tSync('cloud.fileTypeUnsupported', { ext: ext }), 'warn');
      return;
    }
  }

  // ========================================
  // 上传流程
  // ========================================
  showLoading(tSync('cloud.uploading'));
  try {
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      // 生成 Storage 路径: {user_id}/cloud/{filename}
      var path = sbStoragePath(user.id, 'cloud', file.name);
      // 上传文件二进制到 Supabase Storage
      await sbUpload('files', file, path);
      // 写入数据库记录
      await sb.from('user_files').insert({
        user_id: user.id,
        category: 'cloud',
        name: file.name,
        size: file.size,
        mime_type: file.type,
        storage_path: path,
      });
    }
  } catch (e) {
    showToast(tSync('cloud.uploadFailed') + e.message, 'error');
  } finally {
    hideLoading();
  }
  // 上传完成 (无论成功失败) 都刷新列表
  renderFileList();
}

// ============================
// 文件下载
// ============================

/**
 * downloadFile()
 *
 * 【它做什么】
 *   根据文件 id 查询 storage_path，生成 60 秒有效的 Signed URL，
 *   然后通过程序化点击 <a> 标签触发浏览器下载。
 *
 * 【为什么用 Signed URL 而不是公开 URL】
 *   Supabase Storage bucket 是私有的 (非 public)。
 *   用户只能下载自己的文件。Signed URL 提供临时授权，60 秒后失效。
 *   这比公开 URL + RLS 更安全，因为 URL 本身就包含了临时授权。
 *
 * 【为什么用 <a download> 而不是 fetch + Blob】
 *   <a download> 利用浏览器原生下载能力，支持大文件流式下载，
 *   不占用 JS 内存，不会因为 Blob 过大导致 OOM。
 *
 * 【为什么 60 秒 TTL】
 *   下载操作通常立即执行，60 秒足够用户点击。
 *   太短可能因网络延迟失败，太长增加 URL 泄露后的风险窗口。
 *
 * 【输入】id — number，user_files 表的记录 id
 * 【输出】无 (void, async)
 * 【副作用】
 *   - 查询 user_files 表
 *   - 生成 Supabase Signed URL
 *   - 创建并点击 <a> 元素 (触发浏览器下载)
 * 【调用者】#fileList 事件委托 (data-file-download 按钮)
 */
async function downloadFile(id) {
  if (!sb) return;
  var user = await getCachedUser();
  if (!user) return; // 安全：未登录不能下载
  try {
    // 安全：必须验证文件属于当前用户（防止 IDOR 越权下载）
    var result = await sb.from('user_files').select('storage_path, name').eq('id', id).eq('user_id', user.id).single();
    if (!result.data) return;

    showLoading(tSync('cloud.downloadPreparing'));
    try {
      // 生成 60 秒有效的临时下载链接
      var signedUrl = await sbSignedUrl('files', result.data.storage_path, 60);
      if (!signedUrl) { showToast(tSync('cloud.downloadUrlFailed'), 'error'); return; }

      // 程序化创建 <a> 标签触发下载
      var a = document.createElement('a');
      a.href = signedUrl;
      a.download = result.data.name;
      a.click(); // 触发浏览器原生下载行为
    } finally {
      hideLoading();
    }
  } catch (e) {
    showToast(tSync('cloud.downloadFailed') + e.message, 'error');
  }
}

// ============================
// 文件删除
// ============================

/**
 * removeFile()
 *
 * 【它做什么】
 *   根据文件 id 删除 Supabase Storage 中的文件和 user_files 表中的记录。
 *   先查 storage_path → 删除 Storage 文件 → 删除数据库记录。
 *
 * 【为什么先删 Storage 再删数据库】
 *   如果先删数据库再删 Storage，中间出错会导致 Storage 中有孤儿文件
 *   (数据库记录已删除，无法找到 storage_path 来清理)。
 *   反过来: 即使数据库删除失败，Storage 文件还在，用户重试即可。
 *
 * 【为什么不做 confirm 弹窗】
 *   按钮上已有视觉区分 (danger class)，且删除是常见操作。
 *   避免过多的确认弹窗影响体验。误删可以通过重新上传恢复。
 *
 * 【输入】id — number，user_files 表的记录 id
 * 【输出】无 (void, async)
 * 【副作用】
 *   - 删除 Supabase Storage 文件
 *   - 删除 user_files 表记录
 *   - 刷新文件列表 (renderFileList)
 * 【调用者】#fileList 事件委托 (data-file-remove 按钮)
 */
async function removeFile(id) {
  if (!sb) return;
  var user = await getCachedUser();
  if (!user) return; // 安全：未登录不能删除
  try {
    // 安全：必须验证文件属于当前用户（防止 IDOR 越权删除）
    var result = await sb.from('user_files').select('storage_path').eq('id', id).eq('user_id', user.id).single();
    if (result.data) {
      await sbDelete('files', result.data.storage_path);
      await sb.from('user_files').delete().eq('id', id).eq('user_id', user.id);
    }
  } catch (e) { console.warn('[cloud] 删除文件失败:', e); showToast(tSync('cloud.deleteFailed') + (e.message || ''), 'warn'); return; }
  renderFileList();
}

// ============================
// 清空所有文件
// ============================

/**
 * clearCloudData()
 *
 * 【它做什么】
 *   一键清空当前用户的所有 cloud 分类文件。
 *   操作不可撤销，因此有 confirm 确认弹窗。
 *   流程: 查询所有 storage_path → 批量删除 Storage 文件 → 批量删除数据库记录。
 *
 * 【为什么有 confirm 弹窗】
 *   这是一个破坏性操作，删除所有文件。与单文件删除不同。
 *
 * 【为什么用 confirm 而不是自定义 Modal】
 *   confirm 是浏览器原生弹窗，100% 可靠，不会被 CSS 遮挡/覆盖。
 *   对于破坏性操作，用最可靠的方式来确认。
 *
 * 【批量删除策略】
 *   sbDelete 支持数组参数，一次调用删除多个 Storage 文件。
 *   user_files 表用 .eq('user_id', user.id).eq('category', 'cloud') 条件批量删除。
 *
 * 【输入】无
 * 【输出】无 (void, async)
 * 【副作用】
 *   - confirm() 弹窗
 *   - 批量删除 Supabase Storage 文件
 *   - 批量删除 user_files 表记录
 *   - 调用 showToast / showLoading / hideLoading
 *   - 刷新文件列表
 * 【调用者】设置页/管理面板的 "清空网盘" 按钮
 */
async function clearCloudData() {
  if (!sb) return;
  var user = await getCachedUser();
  if (!user) return;
  if (!confirm(tSync('cloud.confirmClear'))) return;

  showLoading(tSync('cloud.clearing'));
  try {
    // 1. 查询所有文件的 storage_path
    var result = await sb
      .from('user_files')
      .select('storage_path')
      .eq('user_id', user.id)
      .eq('category', 'cloud');
    var files = result.data || [];
    // 2. 批量删除 Storage 文件
    if (files.length > 0) {
      await sbDelete('files', files.map(function(f) { return f.storage_path; }));
    }
    // 3. 批量删除数据库记录
    await sb.from('user_files').delete().eq('user_id', user.id).eq('category', 'cloud');
  } catch (e) {
    showToast(tSync('cloud.clearFailed') + e.message, 'error');
  } finally {
    hideLoading();
  }
  renderFileList();
}

// ============================
// IndexedDB → Supabase 迁移
// ============================

/**
 * dataUrlToBlob()
 *
 * 【它做什么】
 *   将 Data URL (base64) 转换为 Blob 对象。
 *   旧版 IndexedDB 中图片以 Data URL 格式存储，迁移时需要转回 Blob 才能上传。
 *
 * 【Data URL 格式】
 *   "data:image/png;base64,iVBORw0KGgo..."
 *   第1步: 按逗号分割，前半部分提取 MIME 类型，后半部分是 base64 数据
 *   第2步: atob() 解码 base64 → 二进制字符串
 *   第3步: 逐字符转 Uint8Array → Blob
 *
 * 【输入】dataUrl — string，Data URL 格式的字符串
 * 【输出】Blob — 可用于上传的二进制对象
 * 【调用者】migrateLocalToCloud() (壁纸和头像迁移)
 */
function dataUrlToBlob(dataUrl) {
  var parts = dataUrl.split(',');
  var mime = parts[0].match(/:(.*?);/)[1]; // 提取 MIME 类型: "image/png"
  var bytes = atob(parts[1]);               // base64 解码
  var arr = new Uint8Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/**
 * dbGetAllFrom()
 *
 * 【它做什么】
 *   从 IndexedDB 的指定 object store 中读取全部记录。
 *   包装为 Promise，方便在 async/await 中使用。
 *
 * 【为什么不用 IDB 库】
 *   这个迁移函数是一次性操作，没必要引入 dexie.js 等库增加体积。
 *   原生 IndexedDB API 虽然繁琐，但此处只用到 getAll()，代码量可控。
 *
 * 【输入】
 *   db        — IDBDatabase 实例 (已打开的 IndexedDB)
 *   storeName — string，object store 名称
 * 【输出】Promise<Array> — 所有记录的数组
 * 【调用者】migrateLocalToCloud()
 */
function dbGetAllFrom(db, storeName) {
  return new Promise(function(resolve, reject) {
    try {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).getAll();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    } catch (e) { resolve([]); } // store 不存在 → 返回空数组
  });
}

/**
 * migrateLocalToCloud()
 *
 * 【它做什么】
 *   将旧版 IndexedDB (PersonalSiteDB) 中的用户数据迁移到 Supabase。
 *   迁移对象:
 *     - wallpapers store → Supabase Storage ('wallpapers' bucket) + user_files 表 (category: 'wallpaper')
 *     - files store      → Supabase Storage ('files' bucket)       + user_files 表 (category: 'cloud')
 *     - tracks store     → Supabase Storage ('bgm' bucket)         + user_files 表 (category: 'bgm')
 *     - avatar store     → Supabase Storage ('avatars' bucket)     + avatars 表
 *
 * 【为什么需要这个功能】
 *   旧版网站用 IndexedDB 在浏览器本地存储用户数据。
 *   升级到 Supabase 后，需要帮助用户把旧数据搬过来。
 *   这是一次性操作，迁移后用户可以清空 IndexedDB。
 *
 * 【迁移策略】
 *   每类数据独立 try/catch — 一类失败不影响其他类别。
 *   错误收集到 errors 数组，最后统一报告。
 *
 * 【为什么用 showLoading 显示不同阶段】
 *   迁移可能涉及大量数据，需要给用户进度反馈。
 *   虽然只是文字变化，但至少让用户知道在做什么。
 *
 * 【输入】无
 * 【输出】无 (void, async)
 * 【副作用】
 *   - 读取 IndexedDB (PersonalSiteDB)
 *   - 上传文件到 Supabase Storage (多个 bucket)
 *   - 写入 user_files 表和 avatars 表
 *   - 调用 showToast / showLoading / hideLoading
 *   - 关闭 IndexedDB 连接
 * 【调用者】管理面板或设置页的 "迁移到云端" 按钮
 */
async function migrateLocalToCloud() {
  if (!sb) { showToast('服务不可用', 'warn'); return; }
  var user = await getCachedUser();
  if (!user) { showToast(tSync('cloud.emptyNotLoggedIn'), 'warn'); return; }

  // 打开旧版 IndexedDB
  var oldDB;
  try {
    oldDB = await new Promise(function(resolve, reject) {
      var req = indexedDB.open('PersonalSiteDB', 1);
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function() { reject(req.error); };
    });
  } catch (e) {
    showToast(tSync('cloud.migrateNoData'), 'warn');
    return;
  }

  showLoading('检查本地数据...');
  var migrated = { wallpapers: 0, files: 0, tracks: 0, avatar: false };
  var errors = [];

  try {
    // ========================================
    // 迁移 1: 壁纸 (wallpapers store)
    // ========================================
    // 旧版壁纸以 Data URL 或 ArrayBuffer 存储
    if (oldDB.objectStoreNames.contains('wallpapers')) {
      showLoading(tSync('cloud.migrateWalls'));
      var wallpapers = await dbGetAllFrom(oldDB, 'wallpapers');
      for (var i = 0; i < wallpapers.length; i++) {
        try {
          var w = wallpapers[i];
          var wblob;
          // 兼容两种旧格式
          if (w.dataUrl) {
            wblob = dataUrlToBlob(w.dataUrl);       // Data URL 格式
          } else if (w.data) {
            wblob = new Blob([w.data], { type: w.type || 'image/png' }); // ArrayBuffer 格式
          } else {
            continue; // 无数据，跳过
          }
          var wfile = new File([wblob], w.name, { type: wblob.type || 'image/png' });
          var wpath = sbStoragePath(user.id, 'wallpaper', w.name);
          await sbUpload('wallpapers', wfile, wpath);
          await sb.from('user_files').insert({
            user_id: user.id, category: 'wallpaper',
            name: w.name, size: wblob.size, mime_type: wblob.type || 'image/png', storage_path: wpath,
          });
          migrated.wallpapers++;
        } catch (e) { errors.push('壁纸 ' + (w.name || '')); }
      }
    }

    // ========================================
    // 迁移 2: 文件 (files store)
    // ========================================
    if (oldDB.objectStoreNames.contains('files')) {
      showLoading(tSync('cloud.migrateFiles'));
      var files = await dbGetAllFrom(oldDB, 'files');
      for (var j = 0; j < files.length; j++) {
        try {
          var f = files[j];
          if (!f.data) continue;
          var fblob = new Blob([f.data]);
          var ffile = new File([fblob], f.name, { type: 'application/octet-stream' });
          var fpath = sbStoragePath(user.id, 'cloud', f.name);
          await sbUpload('files', ffile, fpath);
          await sb.from('user_files').insert({
            user_id: user.id, category: 'cloud',
            name: f.name, size: f.size || fblob.size, storage_path: fpath,
          });
          migrated.files++;
        } catch (e) { errors.push('文件 ' + (f.name || '')); }
      }
    }

    // ========================================
    // 迁移 3: BGM 音乐 (tracks store)
    // ========================================
    if (oldDB.objectStoreNames.contains('tracks')) {
      showLoading(tSync('cloud.migrateBgm'));
      var tracks = await dbGetAllFrom(oldDB, 'tracks');
      for (var k = 0; k < tracks.length; k++) {
        try {
          var t = tracks[k];
          if (!t.data) continue;
          var tblob = new Blob([t.data]);
          var tfile = new File([tblob], t.name, { type: t.type || 'audio/mpeg' });
          var tpath = sbStoragePath(user.id, 'bgm', t.name);
          await sbUpload('bgm', tfile, tpath);
          await sb.from('user_files').insert({
            user_id: user.id, category: 'bgm',
            name: t.name, size: tblob.size, storage_path: tpath,
          });
          migrated.tracks++;
        } catch (e) { errors.push('BGM ' + (t.name || '')); }
      }
    }

    // ========================================
    // 迁移 4: 头像 (avatar store)
    // ========================================
    // 头像只有一条记录，upsert 到独立的 avatars 表 (不是 user_files)
    if (oldDB.objectStoreNames.contains('avatar')) {
      showLoading(tSync('cloud.migrateAvatar'));
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
            // 头像表用 upsert: 已有则更新，无则插入
            await sb.from('avatars').upsert({ user_id: user.id, storage_path: apath, updated_at: new Date() });
            migrated.avatar = true;
          }
        } catch (e) { errors.push('头像'); }
      }
    }

    // 迁移结果报告
    var msg = tSync('cloud.migrateDone', { walls: migrated.wallpapers, files: migrated.files, tracks: migrated.tracks }) + (migrated.avatar ? ', 头像 1 个' : '');
    if (errors.length > 0) msg += '（' + errors.length + ' 项失败）';
    showToast(msg, errors.length > 0 ? 'warn' : 'success');
  } catch (e) {
    showToast(tSync('cloud.migrateFailed') + (e.message || ''), 'error');
  } finally {
    hideLoading();
    if (oldDB) oldDB.close(); // 关闭 IndexedDB 连接，避免资源泄漏
  }
}

// ============================
// 事件绑定
// ============================

/**
 * bindCloudEvents()
 *
 * 【它做什么】
 *   绑定网盘面板所有 DOM 事件监听器:
 *     1. 文件列表事件委托 (下载/删除按钮)
 *     2. 拖拽区域点击 → 触发文件选择
 *     3. 文件选择 change → 上传
 *     4. 拖拽事件 (dragover / dragleave / drop)
 *
 * 【为什么用事件委托处理下载/删除】
 *   文件列表通过 innerHTML 动态渲染，按钮是动态生成的。
 *   用事件委托绑定在 #fileList 上，一次绑定，永久有效。
 *
 * 【拖拽上传】
 *   dragover: 阻止默认行为 (否则浏览器会打开文件) + 添加视觉反馈
 *   dragleave: 移除视觉反馈
 *   drop: 阻止默认行为 + 移除反馈 + 调用 handleFiles
 *
 * 【为什么暴露到 window】
 *   函数在模块中，外部不可见。main.js 初始化时调用 window.bindCloudEvents()。
 *
 * 【输入】无
 * 【输出】无
 * 【副作用】添加事件监听器到多个 DOM 元素
 * 【调用者】main.js 或直接通过 window.bindCloudEvents
 */
function bindCloudEvents() {
  // 1. 文件列表事件委托
  document.getElementById('fileList').addEventListener('click', function(e) {
    // 下载按钮
    var dl = e.target.closest('[data-file-download]');
    if (dl) { downloadFile(parseInt(dl.getAttribute('data-file-download'))); return; }
    // 删除按钮
    var rm = e.target.closest('[data-file-remove]');
    if (rm) { removeFile(parseInt(rm.getAttribute('data-file-remove'))); return; }
  });

  // 2. 拖拽区域点击 → 触发隐藏的 file input
  document.getElementById('dropZone').addEventListener('click', function() {
    document.getElementById('fileInput').click();
  });

  // 3. 文件选择 → 上传
  document.getElementById('fileInput').addEventListener('change', function(e) {
    handleFiles(e.target.files);
    e.target.value = ''; // 清空 input，允许重复上传同一个文件
  });

  // 4. 拖拽上传事件
  document.getElementById('dropZone').addEventListener('dragover', function(e) {
    e.preventDefault(); // 必须阻止默认行为，否则 drop 事件不会触发
    e.target.closest('.drop-zone').classList.add('drag-over');
  });
  document.getElementById('dropZone').addEventListener('dragleave', function(e) {
    e.target.closest('.drop-zone').classList.remove('drag-over');
  });
  document.getElementById('dropZone').addEventListener('drop', function(e) {
    e.preventDefault(); // 阻止浏览器打开拖入的文件
    e.target.closest('.drop-zone').classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
}

// ============================
// 对外暴露 API (向后兼容)
// ============================

/**
 * 【暴露到 window 全局的原因】
 *   其他脚本需要调用这些函数来驱动网盘功能:
 *   - settings.js 登录成功后调用 renderFileList 刷新列表
 *   - main.js 初始化时调用 bindCloudEvents 绑定事件
 *   - 设置页调用 clearCloudData 清空文件
 *   - 管理面板调用 migrateLocalToCloud 执行迁移
 */
window.renderFileList = renderFileList;
window.downloadFile = downloadFile;
window.removeFile = removeFile;
window.clearCloudData = clearCloudData;
window.migrateLocalToCloud = migrateLocalToCloud;
window.bindCloudEvents = bindCloudEvents;

// ---------------------------------------------------------------
// ES Module 导出
// ---------------------------------------------------------------

export { renderFileList, downloadFile, removeFile, clearCloudData, migrateLocalToCloud, bindCloudEvents };
