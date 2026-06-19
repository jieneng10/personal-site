/**
 * ==================== Supabase 客户端 + 工具箱 ====================
 *
 * 【这是什么】
 *   整个网站最重要的工具文件。所有模块都用它和后端（Supabase）通信。
 *   它包含了：
 *     1. 数据库连接（sb — Supabase 客户端）
 *     2. 文件存储操作（上传/下载/删除/获取 URL）
 *     3. HTML 转义（防 XSS 攻击）
 *     4. 用户缓存（避免频繁查"我是谁"）
 *     5. 登录状态监听（登录/登出时自动刷新 UI）
 *     6. UI 提示（loading 指示器 / toast 通知）
 *     7. 本地数据库写入（IndexedDB 批量存数据）
 *
 * 【怎么用】
 *   所有函数都导出到 window 上：
 *     window.sb             — Supabase 客户端
 *     window.sbUpload(...)  — 上传文件
 *     window.escHtml(...)   — 转义 HTML
 *     window.showToast(...) — 弹出提示
 *     ... 等等
 *
 * 【加载前提】
 *   这个文件必须在 shared.js 之后加载（需要 window.SUPABASE_URL）
 *   这个文件必须在 CDN supabase SDK 之后加载（需要全局 supabase 对象）
 */
(function() {

  // ═══════════════════════════════════════════════════════════
  // 第 1 部分：Supabase 客户端初始化
  // ═══════════════════════════════════════════════════════════

  /**
   * sb = Supabase 客户端实例
   *
   * 如果 CDN 的 supabase SDK 加载成功（全局有 supabase 对象），
   * 就用项目 URL 和密钥创建一个客户端。
   * 如果 SDK 没加载（比如离线环境），sb 为 null，所有操作都会降级到离线模式。
   */
  /** @type {import('@supabase/supabase-js').SupabaseClient|null} */
  var sb = null;

  if (typeof supabase !== 'undefined' && window.SUPABASE_URL && window.SUPABASE_KEY) {
    sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
  } else if (typeof supabase === 'undefined') {
    console.warn('Supabase SDK 未加载，使用离线模式');
  }

  // ═══════════════════════════════════════════════════════════
  // 第 2 部分：文件存储操作
  // ═══════════════════════════════════════════════════════════

  /**
   * 生成唯一的文件存储路径
   *
   * 【为什么需要这个函数】
   *   如果两个用户都上传了 "avatar.png"，直接存在同一个路径会互相覆盖。
   *   这个函数给每个文件生成唯一 ID，所以永远不会重名。
   *
   * 【路径格式】
   *   <用户ID>/<分类>/<时间戳+随机数>.<原始扩展名>
   *   例如：abc123/wallpaper/mk7x_a3b2c1.jpg
   *
   * 【UUID 是什么】
   *   Date.now().toString(36) 把当前时间戳转成 36 进制（更短）
   *   Math.random().toString(36).slice(2,8) 生成 6 位随机字符
   *   两者拼在一起，几乎不可能重复
   *
   * @param {string} userId   - Supabase 用户 ID（auth.uid()）
   * @param {string} category - 存储分类：'wallpaper' | 'bgm' | 'cloud' | 'avatar'
   * @param {string} fileName - 原始文件名，只取扩展名
   * @returns {string} 例如 'abc123/wallpaper/mk7x_a3b2c1.jpg'
   */
  function sbStoragePath(userId, category, fileName) {
    var ext = fileName.split('.').pop();           // "photo.jpg" → "jpg"
    var uuid = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    return userId + '/' + category + '/' + uuid + '.' + ext;
  }

  /**
   * 上传文件到 Supabase Storage
   *
   * @param {string} bucket - 存储桶名：'wallpapers' | 'bgm' | 'avatars' | 'files'
   * @param {File}   file   - 浏览器 File 对象（用户选择的文件）
   * @param {string} path   - 目标路径（用 sbStoragePath() 生成）
   * @returns {Promise<string>} 上传成功后返回文件路径
   * @throws  {Error} 如果 sb 不可用或上传失败
   *
   * 【流程】
   *   1. 检查 Supabase 客户端是否可用
   *   2. 调用 Supabase Storage API 上传
   *   3. 如果 Supabase 返回错误，抛异常
   *   4. 返回文件路径供后续使用（比如写入 user_files 表）
   *
   * 【示例】
   *   var path = sbStoragePath(user.id, 'wallpaper', file.name);
   *   var storedPath = await sbUpload('wallpapers', file, path);
   *   // storedPath = 'abc123/wallpaper/mk7x_a3b2c1.jpg'
   */
  async function sbUpload(bucket, file, path) {
    if (!sb) throw new Error('Supabase unavailable');
    var result = await sb.storage.from(bucket).upload(path, file, { upsert: false });
    if (result.error) throw result.error;
    return result.data.path;
  }

  /**
   * 获取文件的公开 URL（public bucket 专用）
   *
   * 【公开 URL vs 签名 URL 的区别】
   *   公开 URL：永久有效，不需要登录就能访问
   *   签名 URL：有时效（60 秒），需要权限才能生成
   *
   *   wallpapers、bgm、avatars 桶是 public → 用这个函数
   *   files 桶是 private → 用 sbSignedUrl()
   *
   * @param {string} bucket - 'wallpapers' | 'bgm' | 'avatars'
   * @param {string} path   - 文件路径
   * @returns {string|null} 公开访问 URL，sb 不可用时返回 null
   */
  function sbPublicUrl(bucket, path) {
    if (!sb) return null;
    return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  /**
   * 获取文件的临时签名 URL（private bucket 专用）
   *
   * 【工作原理】
   *   Supabase 生成一个带签名的临时链接，60 秒后自动失效。
   *   这样即使链接被分享出去，也不会永久暴露文件内容。
   *
   * @param {string}  bucket       - 'files'（唯一 private 桶）
   * @param {string}  path         - 文件路径
   * @param {number}  [expiresIn]  - 有效期（秒），默认 60
   * @returns {Promise<string|null>} 签名 URL
   */
  async function sbSignedUrl(bucket, path, expiresIn) {
    if (!sb) return null;
    expiresIn = expiresIn || 60;
    var result = await sb.storage.from(bucket).createSignedUrl(path, expiresIn);
    return result.data ? result.data.signedUrl : null;
  }

  /**
   * 删除一个或多个文件
   *
   * @param {string}          bucket - 存储桶名
   * @param {string|string[]} paths  - 单个路径或路径数组
   * @returns {Promise<void>}
   * @throws  {Error} 如果 sb 不可用或删除失败
   *
   * 【注意】
   *   传入空数组或 null 不会报错，只是什么都不做。
   *   这是故意设计的——调用方不需要预先检查 paths 是否为空。
   */
  async function sbDelete(bucket, paths) {
    if (!sb) throw new Error('Supabase unavailable');
    if (!paths || paths.length === 0) return;
    // [].concat(paths) 把单个路径也变成数组，统一处理
    var result = await sb.storage.from(bucket).remove([].concat(paths));
    if (result.error) throw result.error;
  }

  // ═══════════════════════════════════════════════════════════
  // 第 3 部分：HTML 安全转义（防 XSS 攻击）
  // ═══════════════════════════════════════════════════════════

  /**
   * HTML 实体转义
   *
   * 【什么是 XSS（跨站脚本攻击）】
   *   攻击者在评论或投稿中插入 <script>alert('hack')</script>，
   *   如果直接插入 HTML，这段代码会在所有访问者浏览器中执行。
   *   转义就是把这些特殊字符变成无害的文本。
   *
   * 【转义对照表】
   *   & → &amp;    （与号 — HTML 实体起始符）
   *   < → &lt;     （小于号 — HTML 标签起始符）
   *   > → &gt;     （大于号 — HTML 标签结束符）
   *   " → &quot;   （双引号 — 属性边界）
   *   ' → &#39;    （单引号 — 属性边界）
   *
   * 【什么情况用这个函数】
   *   ✅ 用户输入的名字、签名、文章标题 — 必须转义
   *   ✅ 从 API 拉回来的数据 — 不知道来源是否可信，转义最安全
   *   ❌ 经过 sanitizeHtml() 处理的富文本 — 已经净化过，不需要
   *   ❌ 你确定是安全的内部字符串 — 不转义也行但转了没坏处
   *
   * @param {*} str - 要转义的值（不是字符串也会被转成字符串）
   * @returns {string} 安全的 HTML 文本
   *
   * 【示例】
   *   escHtml('<script>alert(1)</script>')
   *   → '&lt;script&gt;alert(1)&lt;/script&gt;'
   *   这段文本在页面上显示为 "<script>alert(1)</script>"，不会执行
   */
  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ═══════════════════════════════════════════════════════════
  // 第 4 部分：用户缓存
  // ═══════════════════════════════════════════════════════════

  /** @type {object|null} 缓存的用户对象 */
  var _cachedUser = null;

  /** @type {number} 上次获取用户的时间戳 */
  var _cachedUserTs = 0;

  /**
   * 获取当前登录用户（带 2 分钟缓存）
   *
   * 【为什么需要缓存】
   *   多个模块都需要知道"当前是谁"：
   *     cloud.js 上传文件时需要用户 ID
   *     wallpaper.js 保存壁纸时需要用户 ID
   *     settings.js 同步设置时需要用户 ID
   *   如果每次都调 Supabase API，会产生大量重复请求。
   *   2 分钟内存缓存：第一次真正查，后面直接用缓存结果。
   *   登录/登出时缓存会被清掉（见下面的 onAuthStateChange）。
   *
   * @returns {Promise<object|null>} Supabase User 对象，未登录时返回 null
   */
  async function getCachedUser() {
    // 缓存未过期 → 直接返回
    if (_cachedUser && Date.now() - _cachedUserTs < 120000) return _cachedUser;
    if (!sb) return null;
    try {
      var result = await sb.auth.getUser();
      _cachedUser = result.data.user;
      _cachedUserTs = Date.now();
      return _cachedUser;
    } catch (e) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 第 5 部分：登录/登出监听
  // ═══════════════════════════════════════════════════════════

  /**
   * 【监听登录状态变化】
   *
   * 这是 Supabase 提供的事件监听。
   * 当用户登录或登出时，Supabase 会自动触发回调。
   *
   * 登录时 (SIGNED_IN)：
   *   1. 清除用户缓存（下次 getCachedUser 会重新查）
   *   2. 发送 'auth:login' 事件 → main.js 收到后会刷新头像/文章/壁纸/BGM
   *
   * 登出时 (SIGNED_OUT)：
   *   1. 设置 _isLoggedIn = false
   *   2. 清除用户缓存
   *   3. 把锁图标改回"登录"状态
   *   4. 隐藏管理员专属元素（管理按钮、管理员徽章）
   *   5. 发送 'auth:logout' 事件
   */
  if (sb) {
    sb.auth.onAuthStateChange(function(event) {
      if (event === 'SIGNED_IN') {
        _cachedUser = null;
        _cachedUserTs = 0;
        if (typeof window.EventBus !== 'undefined') {
          window.EventBus.emit('auth:login');
        }
      }
      if (event === 'SIGNED_OUT') {
        window._isLoggedIn = false;
        _cachedUser = null;
        _cachedUserTs = 0;

        // 把底部锁图标改成"锁"（表示未登录状态）
        var lockBtn = document.getElementById('btnLock');
        if (lockBtn) {
          lockBtn.innerHTML = '<svg viewBox="0 0 24 24" class="nav-icon nav-icon-sys"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
          lockBtn.title = '登录';
        }

        // 隐藏管理员徽章
        var adminBadge = document.getElementById('adminBadge');
        if (adminBadge) adminBadge.style.display = 'none';

        // 隐藏所有 admin-only 元素
        var adminOnly = document.querySelectorAll('.admin-only');
        for (var i = 0; i < adminOnly.length; i++) {
          adminOnly[i].style.display = 'none';
        }

        if (typeof window.EventBus !== 'undefined') {
          window.EventBus.emit('auth:logout');
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 第 6 部分：UI 提示组件
  // ═══════════════════════════════════════════════════════════

  var _loadingToast = null; // loading 指示器的 DOM 元素

  /**
   * 显示屏幕顶部的 loading 指示器
   *
   * 【视觉效果】
   *   屏幕顶部中间出现一个半透明紫色圆角条，显示文字。
   *   用于告知用户"正在处理中，请稍候"。
   *
   * 【调用规范】
   *   一定要配对使用：
   *     showLoading('上传中...');
   *     try { ... 做耗时操作 ... }
   *     finally { hideLoading(); }    ← finally 确保不管成功失败都会消失
   *
   * @param {string} msg - 提示文字
   */
  function showLoading(msg) {
    // 第一次调用时创建 DOM 元素，之后只改文字
    if (!_loadingToast) {
      _loadingToast = document.createElement('div');
      _loadingToast.id = 'loadingToast';
      _loadingToast.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999;' +
        'background:rgba(20,18,30,0.92);border:1px solid rgba(180,140,220,0.5);border-radius:20px;' +
        'padding:10px 24px;color:#d4a0ff;font-size:13px;backdrop-filter:blur(12px);pointer-events:none;';
      document.body.appendChild(_loadingToast);
    }
    _loadingToast.textContent = msg;
    _loadingToast.style.display = '';
  }

  /** 隐藏 loading 指示器 */
  function hideLoading() {
    if (_loadingToast) _loadingToast.style.display = 'none';
  }

  var _toastTimer = null; // toast 自动消失的定时器

  /**
   * 弹出 toast 通知（自动消失的提示框）
   *
   * 【视觉区别】
   *   和 loading 不同，toast 是"结果通知"——操作完成后的反馈。
   *   2.5 秒后自动消失。
   *
   * @param {string} msg  - 提示文字
   * @param {string} [type] - 'success'（绿）/ 'error'（红）/ 'warn'（橙）
   *
   * 【使用场景】
   *   showToast('上传成功', 'success');
   *   showToast('网络错误，请重试', 'error');
   *   showToast('文件太大，最多 50MB', 'warn');
   */
  function showToast(msg, type) {
    // 第一次调用时创建 DOM 元素
    var t = document.getElementById('toastMsg');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toastMsg';
      t.style.cssText =
        'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:9999;' +
        'padding:10px 24px;border-radius:20px;font-size:13px;pointer-events:none;' +
        'transition:opacity 0.3s;opacity:0;';
      document.body.appendChild(t);
    }

    // 根据类型选择背景色
    var bg = type === 'error'
      ? 'rgba(255,60,60,0.85)'      // 红色：错误
      : type === 'warn'
        ? 'rgba(255,180,60,0.85)'    // 橙色：警告
        : 'rgba(100,200,120,0.85)';  // 绿色：成功（默认）

    t.style.background = bg;
    t.style.color = '#fff';
    t.textContent = msg;
    t.style.opacity = '1';

    // 2.5 秒后自动消失
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function() { t.style.opacity = '0'; }, 2500);
  }

  // ═══════════════════════════════════════════════════════════
  // 第 7 部分：IndexedDB 批量写入
  // ═══════════════════════════════════════════════════════════

  /**
   * 把一批数据写入浏览器的 IndexedDB 数据库
   *
   * 【什么是 IndexedDB】
   *   浏览器内置的"本地小数据库"，比 localStorage 大得多（几百 MB）。
   *   用来存离线数据：壁纸图片、BGM 音频、用户上传的文件。
   *
   * 【为什么用这个而不是直接操作 IndexedDB】
   *   IndexedDB 的原生 API 非常繁琐（回调嵌套地狱）。
   *   这个函数用 Promise 封装了打开数据库、检查表、插入数据的全流程。
   *
   * @param {string}   storeName - 表名（'wallpapers' | 'tracks' | 'files'）
   * @param {object[]} entries   - 要插入的数据数组，每项自动分配自增 id
   * @returns {Promise<void>}
   *
   * 【流程】
   *   1. 打开数据库（DB_NAME, DB_VERSION）
   *   2. 如果表不存在 → 创建表（keyPath: 'id', autoIncrement: true）
   *   3. 开启读写事务 → 逐条 add
   *   4. 等事务完成 → 关闭数据库
   */
  async function saveToLocalDB(storeName, entries) {
    var db = null;
    try {
      // 第 1 步：打开数据库
      db = await new Promise(function(res, rej) {
        var req = indexedDB.open(window.DB_NAME || 'PersonalSiteDB', window.DB_VERSION || 1);
        req.onupgradeneeded = function(e) {
          // 版本升级时：如果表不存在就创建
          if (!e.target.result.objectStoreNames.contains(storeName)) {
            e.target.result.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = function(e) { res(e.target.result); };
        req.onerror = function() { rej(req.error); };
      });

      // 第 2 步：如果打开后发现表还是不存在，需要升级版本号重新打开
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        db = await new Promise(function(res, rej) {
          var req = indexedDB.open(window.DB_NAME || 'PersonalSiteDB', (window.DB_VERSION || 1) + 1);
          req.onupgradeneeded = function(e) {
            if (!e.target.result.objectStoreNames.contains(storeName)) {
              e.target.result.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
            }
          };
          req.onsuccess = function(e) { res(e.target.result); };
          req.onerror = function() { rej(req.error); };
        });
      }

      // 第 3 步：批量插入数据
      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      for (var i = 0; i < entries.length; i++) {
        store.add(entries[i]);
      }

      // 第 4 步：等待事务完成
      await new Promise(function(res, rej) {
        tx.oncomplete = res;
        tx.onerror = function() { rej(tx.error); };
      });
    } finally {
      // 无论如何都要关闭数据库连接，否则会泄漏
      if (db) db.close();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 共享工具：删除 user_files 表记录 + Storage 文件
  // ═══════════════════════════════════════════════════════════

  /**
   * _deleteUserFile —— 删除 user_files 表中的记录及其 Storage 文件。
   *
   * 【它做什么】
   *   1. 查询 user_files 表获取 storage_path + category
   *   2. 从对应 Supabase Storage bucket 删除文件 (best-effort)
   *   3. 从 user_files 表删除记录
   *   4. 返回 { category } 让调用方自行刷新 UI
   *
   * 【调用者】
   *   wallpaper.js removeCustomWallpaper() / bgm.js deleteBGMById()
   *   / admin.js deleteManagedFile() rejectItem()
   *
   * 【为什么统一】
   *   四个删除函数共享 ~80% 逻辑。统一后 Storage 删除策略一处改全站生效。
   */
  async function _deleteUserFile(id) {
    if (!sb) return null;
    try {
      var result = await sb.from('user_files').select('storage_path,category').eq('id', id).single();
      if (result.data) {
        var bucket = result.data.category === 'bgm' ? 'bgm' : 'wallpapers';
        try { await sb.storage.from(bucket).remove([result.data.storage_path]); }
        catch (e) { /* storage delete best-effort */ }
      }
      await sb.from('user_files').delete().eq('id', id);
      return result.data ? result.data.category : null;
    } catch (e) { console.warn('[supabase] 删除文件失败:', e); return null; }
  }
  window._deleteUserFile = _deleteUserFile;

  /**
   * _upsertArticle —— 插入或更新文章（admin + 投稿共用）
   *
   * 【调用者】
   *   admin.js saveArticle() / articles.js submitArticle()
   *
   * @param {object}  payload  — 文章字段（title, content, tags, url, cover, excerpt, slug, published, recommended, spoiler）
   * @param {number}  [editId] — 非 null 时执行 UPDATE，null 时执行 INSERT
   * @returns {Promise<object|null>} Supabase 返回的数据或 null
   */
  async function _upsertArticle(payload, editId) {
    if (!sb) return null;
    var result;
    if (editId) {
      payload.updated_at = new Date();
      result = await sb.from('articles').update(payload).eq('id', editId);
    } else {
      result = await sb.from('articles').insert(payload);
    }
    if (result.error) throw result.error;
    return result.data;
  }
  window._upsertArticle = _upsertArticle;

  /**
   * renderMarkdown —— 将 Markdown 渲染为安全的 HTML。
   *
   * 统一 marked.parse() + sanitizeHtml() 调用模式。
   * 免去 articles.js/anime-news.js/admin.js 三处各自的 typeof marked !== 'undefined' guard。
   */
  function renderMarkdown(md) {
    if (typeof marked === 'undefined') return escHtml(md || '');
    var html = marked.parse(md || '');
    return typeof window.sanitizeHtml === 'function' ? window.sanitizeHtml(html) : html;
  }
  window.renderMarkdown = renderMarkdown;

  // ═══════════════════════════════════════════════════════════
  // 导出：挂载到 window 上
  // ═══════════════════════════════════════════════════════════

  window.sb            = sb;             // Supabase 客户端
  window.sbStoragePath = sbStoragePath;  // 生成路径
  window.sbUpload      = sbUpload;       // 上传文件
  window.sbPublicUrl   = sbPublicUrl;    // 公开 URL
  window.sbSignedUrl   = sbSignedUrl;    // 签名 URL
  window.sbDelete      = sbDelete;       // 删除文件
  window.escHtml       = escHtml;        // HTML 转义
  window.getCachedUser = getCachedUser;  // 获取当前用户
  window.showLoading   = showLoading;    // 显示 loading
  window.hideLoading   = hideLoading;    // 隐藏 loading
  window.showToast     = showToast;      // 弹出 toast
  window.saveToLocalDB = saveToLocalDB;  // 写 IndexedDB
})();
