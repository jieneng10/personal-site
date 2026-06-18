/**
 * admin.js — 管理后台面板（内联文章/壁纸/BGM/资讯管理器）
 *
 * 【它是什么】
 *   该文件在 index.html 内以管理面板（section#sec-admin）的形式运行，
 *   提供文章的 CRUD、待审核文件（壁纸/BGM）的审批、壁纸/BGM 的资源管理、
 *   以及动漫资讯的手动编辑功能。
 *   它不负责登录/登出（登录逻辑在 auth.js），但依赖登录状态来决定
 *   能否看到未发布内容（RLS 策略配合）。
 *
 * 【运行时机】
 *   由 main.js 的 init() 在页面启动时调用 window.bindAdminEvents()，
 *   由 auth.js 在登录成功后调用 window._reloadAdminData()。
 *
 * 【数据流向】
 *   Supabase (后端) ←→ admin.js (CRUD) → DOM 渲染
 *                                  ↓
 *                          window.EventBus.emit('cache:invalidate:*')
 *                                  ↓
 *                        main.js / 其他模块 刷新数据
 *
 * 【依赖】
 *   (从 supabase.mjs 导入)
 *     sb, showToast, escHtml, sbStoragePath, sbUpload, sbDelete,
 *     sbPublicUrl, getCachedUser, showLoading, hideLoading
 *   (全局状态 — 跨模块共享)
 *     window.EventBus            — 事件总线
 *     window._isLoggedIn         — 当前是否已登录（由 auth.js 维护）
 *     window.sanitizeHtml(html)  — HTML 净化函数（由 articles.js 注入）
 *     window.DEFAULT_WALLPAPERS  — 内置默认壁纸列表（由 wallpaper.js 注入）
 *     window.DEFAULT_BGMS        — 内置默认 BGM 列表（由 bgm.js 注入）
 *     window.marked              — Markdown 解析库（第三方 CDN 注入）
 *
 * 【ES Module 导出】
 *   export { bindAdminEvents, reloadAdminData }
 *
 * 【向后兼容的 window 接口】
 *   window.bindAdminEvents()   — 绑定所有管理面板事件（main.js 调用）
 *   window._reloadAdminData()  — 登录后重新加载管理面板数据（auth.js 调用）
 *
 * 【为什么从 IIFE 迁移到 ES Module】
 *   原 IIFE 通过 window 全局变量通信，改为 ES Module 后用 import/export。
 *   window._isLoggedIn 和 window.EventBus 保留为全局状态（跨模块共享）。
 *   向后兼容的 window.xxx 别名在文件末尾保留。
 */

// =========================================================================
// 导入（ES Module）
// =========================================================================

import { sb, sbPublicUrl, getCachedUser, showLoading, hideLoading, showToast, escHtml, sbStoragePath, sbUpload, sbDelete } from './supabase.mjs';

// =========================================================================
// 模块级变量
// =========================================================================

/**
 * sb — Supabase 客户端引用
 *
 * 【来源】 从 supabase.mjs 导入，由 supabase.js 在页面加载时初始化。
 * 【用途】 所有数据库操作（增删改查）都通过它执行。
 * 【可能为 undefined】 当 Supabase 未连接或初始化失败时。
 */

/**
 * editingId — 当前正在编辑的文章 ID
 *
 * 【生命周期】
 *   - null: 新建模式（点击「发布」会 INSERT）
 *   - 数字: 编辑模式（点击「保存修改」会 UPDATE）
 * 【修改者】 editArticle() 设置它，cancelEdit() 重置为 null。
 */
var editingId = null;

// =========================================================================
// 本地工具函数（封装 window 上的全局函数，提供降级处理）
// =========================================================================

/**
 * toast — 本地 toast 通知函数
 *
 * 【来源】 优先使用 showToast（从 supabase.mjs 导入），若未加载则用 DOM 操作降级。
 * 【降级逻辑】 直接操作 #toast 元素的 display 和 textContent，
 *             2秒后自动隐藏。使用 clearTimeout 防抖（连续调用时只保留最后一次）。
 * 【为什么做降级】 该脚本可能在 common.js 之前执行，需保证 toast 始终可用。
 */
var toast = showToast || function(msg, type) {
  var el = document.getElementById('toast');
  el.textContent = msg; el.style.display = '';
  clearTimeout(el._t); el._t = setTimeout(function() { el.style.display = 'none'; }, 2000);
};

/**
 * esc — 本地 HTML 转义函数
 *
 * 【来源】 优先使用 escHtml（从 supabase.mjs 导入），若未加载则用字符串替换降级。
 * 【转义字符】 & < > " — 覆盖了最常见的 XSS 攻击向量。
 * 【注意】 不转义单引号 '，因为 HTML 属性值通常用双引号。
 */
var esc = escHtml || function(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
};

// =========================================================================
// 文章管理（Articles CRUD）
// =========================================================================

/**
 * loadArticles — 从 Supabase 加载文章列表并渲染到管理面板
 *
 * 【作用】
 *   查询 articles 表，按 created_at 降序排列，将结果渲染为 HTML 列表
 *   插入 #adminArticleList 元素中。
 *
 * 【输入】 无参数。隐式依赖 window.sb（数据库连接）和 window._isLoggedIn（登录状态）。
 *
 * 【输出】 无返回值（void）。副作用：修改 #adminArticleList 的 innerHTML。
 *
 * 【数据流向】
 *   sb.from('articles').select('*')  →  Supabase REST API  →  JSON 响应
 *   →  逐条构造 HTML 字符串  →  DOM 渲染
 *
 * 【RLS 行为（Row Level Security）】
 *   未登录 (_isLoggedIn = false): Supabase RLS 策略只返回 published=true 的文章。
 *   已登录 (_isLoggedIn = true):  返回所有文章（包括未发布/待审核的）。
 *   因此管理员登录后会看到更多文章。
 *
 * 【调用者】
 *   - bindAdminEvents() — 管理面板初始化时首次加载
 *   - saveArticle()、deleteArticle()、publishArticle() — 操作后刷新列表
 *   - reloadAdminData()  — 登录后重新加载
 *
 * 【为什么不用分页】
 *   个人站点的文章数量通常不超过几百篇，全量加载更简单。
 *   如果未来文章数增长，可改为 Supabase 的 range() 分页 + 滚动加载。
 */
async function loadArticles() {
  var list = document.getElementById('adminArticleList');
  if (!list) return;  // 当前页面不存在管理面板时静默退出

  // ---- 场景1: Supabase 未连接 ----
  if (!sb) {
    list.innerHTML = '<div class="admin-empty" style="padding:30px 0;text-align:center;">' +
      '<div style="font-size:36px;margin-bottom:12px;">🔌</div>' +
      '<div style="color:var(--text-dim);font-size:13px;margin-bottom:6px;">Supabase 未连接</div>' +
      '<div style="color:var(--text-dim);font-size:11px;opacity:0.6;">请检查网络或刷新页面重试</div>' +
      '<button onclick="location.reload()" style="margin-top:12px;padding:6px 20px;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:var(--text-dim);cursor:pointer;font-size:12px;">🔄 刷新页面</button>' +
    '</div>';
    return;
  }

  // ---- 场景2: 加载中状态（先显示 loading 提示，再异步查询） ----
  list.innerHTML = '<div class="admin-empty" style="padding:20px 0;">⏳ 加载中…</div>';

  try {
    var result = await sb.from('articles').select('*').order('created_at', { ascending: false });
    if (result.error) throw new Error(result.error.message || '查询失败');

    var data = result.data || [];
    console.log('[admin] 文章查询完成: ' + data.length + ' 条, isLoggedIn=' + !!window._isLoggedIn + ', status=' + (result.status || 'ok'));

    // ---- 场景3: 无数据 ----
    if (!data.length) {
      // 根据登录状态给出不同的提示信息
      var loggedInHint = window._isLoggedIn
        ? '（已登录管理员，但表中暂无记录）'
        : '（未登录 → RLS 仅返回已发布文章；登录后可管理全部）';
      list.innerHTML = '<div class="admin-empty" style="padding:20px 0;text-align:center;">' +
        '<div style="font-size:36px;margin-bottom:12px;">📝</div>' +
        '<div style="color:var(--text-dim);font-size:14px;margin-bottom:6px;">还没有文章</div>' +
        '<div style="color:var(--text-dim);font-size:11px;opacity:0.6;margin-bottom:12px;">' + loggedInHint + '</div>' +
        '<div style="color:var(--text-dim);font-size:11px;opacity:0.5;">在上方编辑器中写好文章后点击「发布」即可</div>' +
      '</div>';
      return;
    }

    // ---- 场景4: 正常渲染文章列表 ----
    list.innerHTML = data.map(function(a) {
      // 构建状态徽章
      var badges = [];
      if (!a.published) badges.push('<span class="admin-badge-pending">⏳ 待审核</span>');
      else               badges.push('<span class="admin-badge-link">✅ 已发布</span>');
      if (a.recommended) badges.push('<span class="admin-badge-rec">⭐ 推荐</span>');
      if (a.spoiler)     badges.push('<span class="admin-badge-pending">⚠ 剧透</span>');
      if (a.url)         badges.push('<span class="admin-badge-link">🔗 外链</span>');

      // 封面：有 cover 则显示缩略图，否则显示占位符
      var thumb = a.cover
        ? '<img class="admin-item-thumb" src="' + esc(a.cover) + '" alt="" loading="lazy">'
        : '<div class="admin-item-thumb-placeholder">📝</div>';

      // 标签：将 tags 数组渲染为紫色 pills
      // 【为什么用 .map() + .join('') 而不是 innerHTML 赋值】
      //   标签是用户可控数据，必须经过 esc() 转义防止 XSS。
      var tagPills = (a.tags || []).length
        ? '<div class="admin-item-tags">' + (a.tags || []).map(function(t) {
            return '<span class="tag purple">' + esc(t) + '</span>';
          }).join('') + '</div>'
        : '';

      // 摘要：优先用 excerpt 字段，否则从 content 中截取前 150 字符
      var excerpt = a.excerpt || '';
      if (!excerpt && a.content) {
        // 去掉 Markdown 特殊字符后再截取（# * > ` 换行等）
        excerpt = a.content.replace(/[#*>`\n\r]/g, '').slice(0, 150);
      }
      var excerptHtml = excerpt
        ? '<div class="admin-item-excerpt">' + esc(excerpt.slice(0, 150)) + (excerpt.length > 150 ? '…' : '') + '</div>'
        : '';

      // 返回单篇文章的 HTML
      // 【为什么用 data-* 属性传 ID】
      //   事件委托统一在父容器 #sec-admin 上处理 click（见 bindAdminEvents）。
      //   通过 e.target.closest('[data-edit-id]') 找到点击的按钮并读取 data-* 属性，
      //   避免为每个按钮单独绑定事件，减少内存占用。
      return '<div class="admin-article-item">' +
        thumb +
        '<div class="admin-item-body">' +
          '<div class="admin-article-title">' + esc(a.title) + '</div>' +
          '<div class="admin-article-meta">' +
            '📅 ' + (a.created_at || '').slice(0, 10) + ' · ' +
            badges.join(' ') +
          '</div>' +
          tagPills +
          excerptHtml +
        '</div>' +
        '<div class="admin-article-actions">' +
          // 未发布的文章才显示「发布」按钮
          (!a.published ? '<button class="admin-btn-publish" data-publish-id="' + a.id + '">发布</button>' : '') +
          '<button class="admin-btn-edit" data-edit-id="' + a.id + '">编辑</button>' +
          '<button class="admin-btn-delete" data-delete-id="' + a.id + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');  // 用 .join('') 避免数组默认逗号分隔符

  } catch (e) {
    // ---- 场景5: 查询失败 ----
    console.warn('加载文章列表失败:', e.message);
    list.innerHTML = '<div class="admin-empty" style="padding:30px 0;text-align:center;">' +
      '<div style="font-size:36px;margin-bottom:12px;">⚠</div>' +
      '<div style="color:var(--text-dim);font-size:13px;margin-bottom:6px;">加载失败</div>' +
      '<div style="color:#ff7070;font-size:11px;opacity:0.8;margin-bottom:12px;">' + esc(e.message) + '</div>' +
      '<button onclick="window._reloadAdminData&&window._reloadAdminData()" style="padding:6px 20px;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:var(--text-dim);cursor:pointer;font-size:12px;">🔄 重试</button>' +
    '</div>';
  }
}

/**
 * editArticle — 将指定文章的数据填充到编辑表单中
 *
 * 【作用】
 *   根据文章 ID 从 Supabase 查询完整数据，填充到管理面板的编辑器各字段中。
 *   切换编辑器标题为「编辑文章」，按钮文字为「保存修改」，显示取消按钮。
 *
 * 【输入】
 *   id (number) — 文章的 Supabase 主键 ID
 *
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【副作用】
 *   - 修改 DOM 中编辑器各表单字段的 value
 *   - 设置 editingId = id（标记为编辑模式）
 *   - 调用 renderPreview() 显示 Markdown 预览
 *
 * 【调用者】
 *   bindAdminEvents() 中的事件委托 — 用户点击某篇文章的「编辑」按钮
 *
 * 【为什么用 .single() 而不是 .eq().limit(1)】
 *   .single() 在查询结果不是恰好 1 条时会抛出错误（0 条或 >1 条），
 *   这符合预期：通过主键查询必须恰好返回 1 条记录。
 */
function editArticle(id) {
  sb.from('articles').select('*').eq('id', id).single().then(function(result) {
    var data = result.data;
    if (!data) return;  // 数据不存在时静默退出

    // 填充编辑器表单
    document.getElementById('adminEditorTitle').textContent = '编辑文章';
    document.getElementById('adminTitle').value = data.title;
    document.getElementById('adminSlug').value = data.slug || '';
    // tags 是数组，用逗号+空格拼接成字符串供用户编辑
    document.getElementById('adminTags').value = (data.tags || []).join(', ');
    document.getElementById('adminUrl').value = data.url || '';
    document.getElementById('adminCover').value = data.cover || '';
    document.getElementById('adminExcerpt').value = data.excerpt || '';
    document.getElementById('adminContent').value = data.content || '';
    document.getElementById('adminPublished').checked = data.published;
    document.getElementById('adminRecommended').checked = data.recommended || false;
    document.getElementById('adminSpoiler').checked = data.spoiler || false;
    document.getElementById('btnAdminSave').textContent = '保存修改';
    document.getElementById('btnAdminCancel').style.display = '';  // 显示取消按钮
    editingId = data.id;
    renderPreview();  // 显示 Markdown 预览
  });
}

/**
 * cancelEdit — 清空编辑器，回到「新建文章」模式
 *
 * 【作用】
 *   重置所有编辑表单字段为空值，恢复标题为「新建文章」、
 *   按钮文字为「发布」，隐藏取消按钮，清空预览区域。
 *
 * 【输入】 无参数。
 * 【输出】 无返回值。
 *
 * 【副作用】
 *   - 清空所有表单字段的 value
 *   - 重置 editingId = null
 *   - 重置 published checkbox 为 true（新建时默认勾选发布）
 *   - 清空 #adminPreview 的 innerHTML
 *
 * 【调用者】
 *   - bindAdminEvents() — 用户点击「取消」按钮
 *   - saveArticle()     — 保存成功后自动调用，回到新建状态
 *
 * 【为什么保存成功后也要调用 cancelEdit】
 *   保存（新建或更新）完成后，编辑器应恢复到干净的「新建文章」状态，
 *   避免用户误以为还在编辑刚才的文章。
 */
function cancelEdit() {
  editingId = null;
  document.getElementById('adminEditorTitle').textContent = '新建文章';
  document.getElementById('adminTitle').value = '';
  document.getElementById('adminSlug').value = '';
  document.getElementById('adminTags').value = '';
  document.getElementById('adminUrl').value = '';
  document.getElementById('adminCover').value = '';
  document.getElementById('adminExcerpt').value = '';
  document.getElementById('adminContent').value = '';
  document.getElementById('adminPublished').checked = true;    // 新建默认发布
  document.getElementById('adminRecommended').checked = false;
  document.getElementById('adminSpoiler').checked = false;
  document.getElementById('btnAdminSave').textContent = '发布';
  document.getElementById('btnAdminCancel').style.display = 'none';
  document.getElementById('adminPreview').innerHTML = '<span style="color:var(--text-dim);">预览区域...</span>';
}

/**
 * saveArticle — 保存（新建或更新）文章
 *
 * 【作用】
 *   读取编辑器中所有表单字段的值，构造 payload 对象。
 *   如果 editingId 非 null（编辑模式），执行 UPDATE；
 *   如果 editingId 为 null（新建模式），执行 INSERT。
 *
 * 【输入】 无参数。隐式依赖表单 DOM 元素和 editingId 状态。
 *
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【副作用】
 *   - 写入 Supabase 数据库（INSERT 或 UPDATE）
 *   - 调用 cancelEdit() 重置编辑器
 *   - 调用 loadArticles() 刷新文章列表
 *   - 通过 EventBus 发送 'cache:invalidate:articles' 事件，通知主站刷新缓存
 *
 * 【数据校验】
 *   - title 不能为空
 *   - content 不能为空
 *
 * 【slug 自动生成逻辑】
 *   如果用户未手动填写 slug，则自动从标题生成：
 *   title.toLowerCase() → 空格转连字符 → 删除非单词/非中日韩字符 → 截取前 50 字符。
 *   【为什么限制 50 字符】 Supabase slug 列有长度限制，且 SEO 友好的 URL 应简洁。
 *
 * 【调用者】
 *   bindAdminEvents() — #btnAdminSave 点击事件
 */
async function saveArticle() {
  // 读取并校验必填字段
  var title = document.getElementById('adminTitle').value.trim();
  var content = document.getElementById('adminContent').value.trim();
  if (!title) return toast('标题不能为空');
  if (!content) return toast('正文不能为空');

  // 解析 tags：按逗号分割 → 去首尾空格 → 过滤空字符串
  var tags = document.getElementById('adminTags').value.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
  // 生成 slug（优先使用用户填写值，否则从标题自动生成）
  var slug = document.getElementById('adminSlug').value.trim()
    || title.toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '').slice(0, 50);
  var published = document.getElementById('adminPublished').checked;

  // 构造数据库 payload
  // url 和 cover 为空字符串时转为 null（数据库用 NULL 表示"无"）
  var payload = {
    title: title, slug: slug,
    url: document.getElementById('adminUrl').value.trim() || null,
    cover: document.getElementById('adminCover').value.trim() || null,
    excerpt: document.getElementById('adminExcerpt').value.trim(),
    content: content, tags: tags,
    published: published,
    recommended: document.getElementById('adminRecommended').checked,
    spoiler: document.getElementById('adminSpoiler').checked,
    updated_at: new Date(),
  };

  if (!sb) return toast('服务不可用');

  if (editingId) {
    // ---- 编辑模式：UPDATE ----
    var updateResult = await sb.from('articles').update(payload).eq('id', editingId);
    if (updateResult.error) return toast('保存失败: ' + updateResult.error.message);
    toast('文章已更新！', 'success');
  } else {
    // ---- 新建模式：INSERT ----
    var insertResult = await sb.from('articles').insert(payload);
    if (insertResult.error) return toast('发布失败: ' + insertResult.error.message);
    toast('发布成功！', 'success');
  }

  cancelEdit();
  loadArticles();
  // 通知主站：文章缓存已失效，需要重新拉取
  // 【为什么用 EventBus 而不是直接调用】
  //   admin.js 不应该直接知道"谁需要刷新"——那是调用方的职责。
  //   通过事件总线解耦：admin.js 只负责发出「缓存失效」信号，
  //   任何关心这个信号的模块（articles.js、nav.js 等）自行处理。
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('cache:invalidate:articles');
}

/**
 * deleteArticle — 删除指定文章
 *
 * 【作用】
 *   弹出确认对话框，确认后从 articles 表中删除指定 ID 的记录。
 *
 * 【输入】
 *   id (number) — 要删除的文章 ID
 *
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【副作用】
 *   - 删除 Supabase 中的记录（不可逆！）
 *   - 调用 loadArticles() 刷新列表
 *   - 通过 EventBus 发送 cache:invalidate:articles
 *
 * 【为什么用 confirm() 而不是自定义 Modal】
 *   confirm() 是浏览器原生阻塞式对话框，最简单可靠。
 *   这是管理后台操作，不需要花哨的 UI。
 *
 * 【调用者】
 *   bindAdminEvents() — 用户点击「删除」按钮
 */
async function deleteArticle(id) {
  if (!confirm('确定删除这篇文章？')) return;
  if (!sb) return;
  var result = await sb.from('articles').delete().eq('id', id);
  if (result.error) return toast('删除失败');
  toast('已删除', 'success');
  loadArticles();
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('cache:invalidate:articles');
}

/**
 * publishArticle — 将待审核文章发布（设置 published = true）
 *
 * 【作用】
 *   对于未发布的文章（published = false），一键设为已发布状态。
 *   与 saveArticle() 的区别：不需要打开编辑器，直接在列表中操作。
 *
 * 【输入】
 *   id (number) — 要发布的文章 ID
 *
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【副作用】
 *   - 更新 Supabase 中该文章的 published 和 updated_at 字段
 *   - 调用 loadArticles() 刷新列表
 *   - 通过 EventBus 发送 cache:invalidate:articles
 *
 * 【调用者】
 *   bindAdminEvents() — 用户点击文章列表中的「发布」按钮
 *
 * 【为什么单独做一个 publishArticle 而不是在 saveArticle 里处理】
 *   分离关注点：saveArticle 处理编辑器表单的完整保存，
 *   publishArticle 只是一个快捷的状态切换操作。
 *   快捷操作不需要打开编辑器，提升管理效率。
 */
async function publishArticle(id) {
  if (!sb) return;
  var result = await sb.from('articles').update({ published: true, updated_at: new Date() }).eq('id', id);
  if (result.error) return toast('发布失败: ' + result.error.message);
  toast('已发布！', 'success');
  loadArticles();
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('cache:invalidate:articles');
}

// =========================================================================
// 封面上传（Cover Image Upload）
// =========================================================================

/**
 * uploadCover — 上传文章封面图片到 Supabase Storage
 *
 * 【作用】
 *   读取文件选择器中的图片文件，上传到 wallpapers 存储桶的 covers/ 目录下，
 *   然后将公开 URL 填入 cover 输入框。
 *
 * 【输入】 无参数。隐式依赖 #adminCoverFileInput 文件选择器。
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【副作用】
 *   - 上传文件到 Supabase Storage
 *   - 修改 #adminCover 输入框的 value
 *   - 清空文件选择器（防止重复上传同一文件）
 *
 * 【文件名安全处理】
 *   file.name.replace(/[^a-zA-Z0-9._-]/g, '')
 *   移除所有非 ASCII 字母/数字/点/下划线/连字符的字符，防止路径注入。
 *   加上 Date.now() 前缀避免文件名冲突。
 *
 * 【调用者】
 *   bindAdminEvents() — #adminCoverFileInput 的 change 事件
 */
async function uploadCover() {
  var file = document.getElementById('adminCoverFileInput').files[0];
  if (!file) return;
  toast('上传封面中...');
  try {
    // 生成安全的存储路径：covers/<timestamp>_<sanitized_filename>
    var path = 'covers/' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '');
    var uploadResult = await sb.storage.from('wallpapers').upload(path, file);
    if (uploadResult.error) { toast('上传失败: ' + uploadResult.error.message); return; }
    // 获取公开 URL 并填入封面输入框
    var urlResult = sb.storage.from('wallpapers').getPublicUrl(path);
    document.getElementById('adminCover').value = urlResult.data.publicUrl;
    toast('封面已上传！', 'success');
  } catch (e) { toast('上传失败'); }
  // 清空文件选择器，否则再次选择同一文件不会触发 change 事件
  document.getElementById('adminCoverFileInput').value = '';
}

// =========================================================================
// Markdown 预览（Markdown Preview）
// =========================================================================

/**
 * _previewBound — 标记 Markdown 预览事件是否已绑定
 *
 * 【为什么需要这个标记】
 *   bindAdminEvents() 可能被多次调用（如切换管理面板 tab 时）。
 *   如果不加标记，每次调用都会重复 addEventListener，
 *   导致同一按键触发多次 renderPreview()。
 *   用 _previewBound 确保只绑定一次。
 */
var _previewBound = false;

/**
 * renderPreview — 将编辑器中的 Markdown 内容渲染为 HTML 预览
 *
 * 【作用】
 *   读取 #adminContent 的值（Markdown 源码），
 *   用 marked 库解析为 HTML，经 sanitizeHtml 净化后渲染到 #adminPreview。
 *
 * 【输入】 无参数。隐式依赖 #adminContent 的值。
 * 【输出】 无返回值。副作用：修改 #adminPreview 的 innerHTML。
 *
 * 【调用者】
 *   - #adminContent 的 input 事件监听（实时预览）
 *   - editArticle() — 编辑某篇文章时立即显示预览
 *
 * 【为什么需要 sanitizeHtml 净化】
 *   marked 输出的 HTML 可能包含危险内容（虽然 Markdown 语法本身
 *   不包含 script 标签，但 marked 允许内联 HTML）。
 *   sanitizeHtml 做白名单过滤，确保 XSS 安全。
 */
function renderPreview() {
  var md = document.getElementById('adminContent').value;
  if (md) {
    // marked.parse() 将 Markdown 转为 HTML
    var html = typeof marked !== 'undefined' ? marked.parse(md) : '';
    // sanitizeHtml 做 XSS 白名单过滤
    document.getElementById('adminPreview').innerHTML = typeof window.sanitizeHtml === 'function' ? window.sanitizeHtml(html) : html;
  } else {
    // 无内容时显示占位文字
    document.getElementById('adminPreview').innerHTML = '<span style="color:var(--text-dim);">预览区域...</span>';
  }
}

// =========================================================================
// 待审核文件管理（Pending Uploads — 用户上传的壁纸/BGM 审核）
// =========================================================================

/**
 * formatFileSize — 将字节数格式化为人类可读的文件大小
 *
 * 【作用】
 *   纯工具函数，无副作用。
 *   小于 1KB 显示 "X B"，小于 1MB 显示 "X.X KB"，否则显示 "X.X MB"。
 *
 * 【输入】
 *   bytes (number) — 文件字节数
 *
 * 【输出】
 *   (string) 格式化后的文件大小字符串
 *
 * 【调用者】
 *   loadPendingItems() — 渲染待审核文件列表
 *   loadAdminWallpapers() — 渲染壁纸管理列表
 *   loadAdminTracks() — 渲染 BGM 管理列表
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/**
 * loadPendingItems — 加载待审核的用户上传文件（壁纸 + BGM）
 *
 * 【作用】
 *   从 user_files 表查询 published=false 的记录，
 *   渲染到 #adminPendingList，更新 #adminPendingCount 徽章数字。
 *
 * 【输入】 无参数。隐式依赖 window.sb。
 * 【输出】 无返回值（Promise<void>）。副作用：修改 DOM。
 *
 * 【数据流向】
 *   sb.from('user_files').select('*').eq('published', false)  →  Supabase
 *   →  渲染为审核列表（缩略图/图标 + 文件名 + 大小 + 通过/拒绝按钮）
 *
 * 【调用者】
 *   bindAdminEvents() — 管理面板初始化
 *   reloadAdminData()  — 登录后重新加载
 *   approveItem() / rejectItem() — 操作后刷新
 *
 * 【为什么 wallpapers 和 bgm 混在同一个审核列表里】
 *   user_files 表的 category 字段区分类型（wallpaper/bgm），
 *   但审批流程完全一样（通过 → published=true，拒绝 → 删文件+删记录），
 *   合并显示减少 UI 复杂度。
 */
async function loadPendingItems() {
  if (!sb) return;
  var result = await sb.from('user_files').select('*').eq('published', false).order('created_at', { ascending: false });
  var list = document.getElementById('adminPendingList');
  var countEl = document.getElementById('adminPendingCount');
  var data = result.data || [];

  // 更新待审核数量徽章
  if (countEl) {
    if (data.length > 0) {
      countEl.textContent = data.length;
      countEl.style.display = '';
    } else {
      countEl.style.display = 'none';  // 无待审核项时隐藏徽章
    }
  }

  if (!data.length) {
    list.innerHTML = '<div class="admin-empty">暂无待审核项</div>';
    return;
  }

  list.innerHTML = data.map(function(item) {
    var label = item.category === 'wallpaper' ? '🖼 壁纸' : '🎵 BGM';
    var sizeStr = formatFileSize(item.size || 0);
    // 壁纸显示缩略图，BGM 显示图标
    var preview = item.category === 'wallpaper' && sb
      ? '<img class="admin-pending-preview" src="' + esc(sb.storage.from('wallpapers').getPublicUrl(item.storage_path).data.publicUrl) + '" alt="">'
      : '<div class="admin-pending-icon">' + (item.category === 'wallpaper' ? '🖼' : '🎵') + '</div>';
    return '<div class="admin-pending-item">' +
      preview +
      '<div class="admin-pending-info">' +
        '<div class="admin-pending-name">' + esc(item.name) + '</div>' +
        '<div class="admin-pending-meta">' + label + ' · ' + sizeStr + ' · ' + (item.created_at || '').slice(0, 10) + '</div>' +
      '</div>' +
      '<div class="admin-pending-actions">' +
        '<button class="admin-btn-publish" data-approve-id="' + item.id + '">通过</button>' +
        '<button class="admin-btn-delete" data-reject-id="' + item.id + '">拒绝</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

/**
 * approveItem — 审核通过用户上传的文件
 *
 * 【作用】
 *   将 user_files 表中指定记录的 published 设为 true，
 *   使其在网站前台可见（壁纸选择器、BGM 播放列表）。
 *
 * 【输入】
 *   id (number) — user_files 表的主键 ID
 *
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【副作用】
 *   - 更新 Supabase 中的 published 和 updated_at
 *   - 调用 loadPendingItems() 刷新待审核列表
 *   - 通过 EventBus 发送 cache:invalidate:wallpaper 和 cache:invalidate:tracks
 *
 * 【为什么同时发送两个缓存失效事件】
 *   审核通过的文件可能是壁纸也可能是 BGM，但我们不确定（需要额外查询才知道）。
 *   与其额外查询一次 category，不如直接失效两个缓存——对性能影响可忽略。
 *
 * 【调用者】
 *   bindAdminEvents() — 用户点击「通过」按钮
 */
async function approveItem(id) {
  if (!sb) return;
  var result = await sb.from('user_files').update({ published: true, updated_at: new Date() }).eq('id', id);
  if (result.error) { toast('操作失败: ' + result.error.message); return; }
  toast('已通过审核', 'success');
  loadPendingItems();
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('cache:invalidate:wallpaper');
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('cache:invalidate:tracks');
}

/**
 * rejectItem — 拒绝用户上传的文件（删除存储文件 + 数据库记录）
 *
 * 【作用】
 *   先查询该文件的 storage_path 和 category（确定存储桶），
 *   从 Supabase Storage 删除文件，再从 user_files 表删除记录。
 *
 * 【输入】
 *   id (number) — user_files 表的主键 ID
 *
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【副作用】
 *   - 从 Supabase Storage 删除物理文件（壁纸→wallpapers桶，BGM→bgm桶）
 *   - 从 user_files 表删除数据库记录
 *   - 调用 loadPendingItems() 刷新列表
 *
 * 【为什么 storage delete 用 try/catch 包裹且标记 "best-effort"】
 *   如果 storage 删除失败但数据库删除成功，用户会收到「已拒绝」提示，
 *   文件实际上成了「孤儿文件」（在 storage 中存在但数据库无记录）。
 *   这是可接受的降级——网站不会显示孤儿文件，只是占用存储空间。
 *   相比"先删数据库再删 storage"的严格事务，这种 best-effort 方式更简单。
 *
 * 【调用者】
 *   bindAdminEvents() — 用户点击「拒绝」按钮
 */
async function rejectItem(id) {
  if (!sb) return;
  try {
    // 先查询以确定存储桶
    var result = await sb.from('user_files').select('storage_path,category').eq('id', id).single();
    if (result.data) {
      var bucket = result.data.category === 'bgm' ? 'bgm' : 'wallpapers';
      await sb.storage.from(bucket).remove([result.data.storage_path]);
    }
  } catch (e) { /* storage delete best-effort */ }
  // 无论 storage 删除是否成功，都删除数据库记录
  await sb.from('user_files').delete().eq('id', id);
  toast('已拒绝并删除', 'success');
  loadPendingItems();
}

// =========================================================================
// 壁纸管理（Admin Wallpaper Management）
// =========================================================================

/**
 * loadAdminWallpapers — 加载并渲染壁纸管理列表
 *
 * 【作用】
 *   合并「内置默认壁纸」（来自 window.DEFAULT_WALLPAPERS，不可删除）
 *   和「云存储壁纸」（来自 Supabase user_files 表，可删除），
 *   渲染到 #adminWallpaperList。
 *
 * 【输入】 无参数。隐式依赖 window.DEFAULT_WALLPAPERS 和 window.sb。
 * 【输出】 无返回值（Promise<void>）。副作用：修改 DOM。
 *
 * 【数据来源】
 *   内置壁纸: window.DEFAULT_WALLPAPERS 数组（supabase.js 提供），
 *             id 为虚拟的 "default_N"，不可删除。
 *   云壁纸:   sb.from('user_files').eq('category', 'wallpaper')，
 *             包含已发布和待审核的壁纸。
 *
 * 【为什么内置壁纸不存数据库】
 *   内置壁纸是站点默认资源，不应被管理员误删。
 *   它们放在 supabase.js 的常量数组中，通过虚拟 ID 区分。
 *
 * 【调用者】
 *   bindAdminEvents()   — 管理面板初始化
 *   reloadAdminData()   — 登录后重新加载
 *   deleteManagedFile() — 删除文件后刷新
 */
async function loadAdminWallpapers() {
  var list = document.getElementById('adminWallpaperList');
  if (!list) return;

  // 内置默认壁纸（不可删除，显示「内置」徽章）
  var defaults = (window.DEFAULT_WALLPAPERS || []).map(function(d, i) {
    return { id: 'default_' + i, name: d.name, url: d.path, isDefault: true };
  });

  // 云存储壁纸（从 user_files 表查询）
  var cloudItems = [];
  if (sb) {
    try {
      var result = await sb.from('user_files').select('*').eq('category', 'wallpaper').order('created_at', { ascending: false });
      cloudItems = (result.data || []).map(function(c) {
        return {
          id: c.id, name: c.name, size: c.size,
          storage_path: c.storage_path, published: c.published,
          isDefault: false, created_at: c.created_at,
        };
      });
    } catch (e) { /* ignore */ }
  }

  var all = defaults.concat(cloudItems);  // 内置壁纸在前，云端壁纸在后
  if (!all.length) {
    list.innerHTML = '<div class="admin-empty">暂无壁纸</div>';
    return;
  }

  list.innerHTML = all.map(function(item) {
    var sizeStr = item.size ? formatFileSize(item.size) : '';
    // 状态徽章：内置 / 已发布 / 待审核
    var badge = item.isDefault ? '<span class="admin-badge-rec">内置</span>'
      : (item.published ? '<span class="admin-badge-link">已发布</span>' : '<span class="admin-badge-pending">待审核</span>');
    // 预览：云端壁纸用存储 URL，内置壁纸用 path
    var preview = !item.isDefault && sb
      ? '<img class="admin-pending-preview" src="' + esc(sb.storage.from('wallpapers').getPublicUrl(item.storage_path).data.publicUrl) + '" alt="">'
      : '<div class="admin-pending-icon" style="background:url(\'' + esc(item.url || '') + '\') center/cover;"></div>';
    // 内置壁纸不显示删除按钮
    var delBtn = !item.isDefault
      ? '<button class="admin-btn-delete" data-delete-file="' + item.id + '">删除</button>'
      : '';
    return '<div class="admin-pending-item">' +
      preview +
      '<div class="admin-pending-info">' +
        '<div class="admin-pending-name">' + esc(item.name) + ' ' + badge + '</div>' +
        '<div class="admin-pending-meta">' + (sizeStr ? sizeStr + ' · ' : '') + (item.created_at || '').slice(0, 10) + '</div>' +
      '</div>' +
      '<div class="admin-pending-actions">' + delBtn + '</div>' +
    '</div>';
  }).join('');
}

// =========================================================================
// BGM 曲目管理（Admin Track Management）
// =========================================================================

/**
 * loadAdminTracks — 加载并渲染 BGM 曲目管理列表
 *
 * 【作用】
 *   与 loadAdminWallpapers() 结构完全对称：
 *   合并内置默认 BGM（window.DEFAULT_BGMS）和云存储 BGM（user_files 表），
 *   渲染到 #adminTrackList。
 *
 * 【输入】 无参数。隐式依赖 window.DEFAULT_BGMS 和 window.sb。
 * 【输出】 无返回值（Promise<void>）。副作用：修改 DOM。
 *
 * 【与 loadAdminWallpapers 的差异】
 *   - BGM 没有缩略图预览（预览区域显示 🎵 图标）
 *   - 查询条件为 eq('category', 'bgm')
 *   - 删除时使用 bgm 存储桶
 *
 * 【调用者】
 *   bindAdminEvents()   — 管理面板初始化
 *   reloadAdminData()   — 登录后重新加载
 *   deleteManagedFile() — 删除文件后刷新
 */
async function loadAdminTracks() {
  var list = document.getElementById('adminTrackList');
  if (!list) return;

  // 内置默认 BGM
  var defaults = (window.DEFAULT_BGMS || []).map(function(d, i) {
    return { id: 'default_bgm_' + i, name: d.name, isDefault: true };
  });

  // 云存储 BGM
  var cloudItems = [];
  if (sb) {
    try {
      var result = await sb.from('user_files').select('*').eq('category', 'bgm').order('created_at', { ascending: false });
      cloudItems = (result.data || []).map(function(c) {
        return {
          id: c.id, name: c.name, size: c.size,
          storage_path: c.storage_path, published: c.published,
          isDefault: false, created_at: c.created_at,
        };
      });
    } catch (e) { /* ignore */ }
  }

  var all = defaults.concat(cloudItems);
  if (!all.length) {
    list.innerHTML = '<div class="admin-empty">暂无曲目</div>';
    return;
  }

  list.innerHTML = all.map(function(item) {
    var sizeStr = item.size ? formatFileSize(item.size) : '';
    var badge = item.isDefault ? '<span class="admin-badge-rec">内置</span>'
      : (item.published ? '<span class="admin-badge-link">已发布</span>' : '<span class="admin-badge-pending">待审核</span>');
    var icon = '<div class="admin-pending-icon">🎵</div>';
    // 内置 BGM 不显示删除按钮
    var delBtn = !item.isDefault
      ? '<button class="admin-btn-delete" data-delete-file="' + item.id + '">删除</button>'
      : '';
    return '<div class="admin-pending-item">' +
      icon +
      '<div class="admin-pending-info">' +
        '<div class="admin-pending-name">' + esc(item.name) + ' ' + badge + '</div>' +
        '<div class="admin-pending-meta">' + (sizeStr ? sizeStr + ' · ' : '') + (item.created_at || '').slice(0, 10) + '</div>' +
      '</div>' +
      '<div class="admin-pending-actions">' + delBtn + '</div>' +
    '</div>';
  }).join('');
}

/**
 * deleteManagedFile — 删除管理列表中的壁纸或 BGM 文件
 *
 * 【作用】
 *   确认后从 Supabase Storage 删除物理文件，再从 user_files 表删除记录。
 *   用于壁纸管理和 BGM 管理两个列表中的「删除」按钮。
 *
 * 【输入】
 *   id (number) — user_files 表的主键 ID
 *
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【副作用】
 *   - 从 Supabase Storage 删除文件
 *   - 从 user_files 表删除记录
 *   - 调用 loadAdminWallpapers() 和 loadAdminTracks() 刷新两个列表
 *   - 通过 EventBus 发送缓存失效事件
 *
 * 【为什么不区分壁纸/BGM 而同时刷新两个列表】
 *   与 approveItem 同样的原因：避免额外查询 category。
 *   同时刷新两个列表的开销很小。
 *
 * 【调用者】
 *   bindAdminEvents() — 事件委托捕获 data-delete-file 按钮点击
 */
async function deleteManagedFile(id) {
  if (!sb || !confirm('确定删除此项？')) return;
  try {
    var result = await sb.from('user_files').select('storage_path,category').eq('id', id).single();
    if (result.data) {
      var bucket = result.data.category === 'bgm' ? 'bgm' : 'wallpapers';
      await sb.storage.from(bucket).remove([result.data.storage_path]);
    }
  } catch (e) { /* storage delete best-effort */ }
  await sb.from('user_files').delete().eq('id', id);
  toast('已删除', 'success');
  loadAdminWallpapers();
  loadAdminTracks();
  // 通知主站刷新缓存
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('cache:invalidate:wallpaper');
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('cache:invalidate:tracks');
}

// =========================================================================
// 事件绑定（Event Binding）
// =========================================================================

/**
 * bindAdminEvents — 绑定管理面板所有 DOM 事件
 *
 * 【作用】
 *   这是管理面板的初始化入口函数。
 *   做了三件事：
 *   1. 绑定编辑器相关事件（实时预览、保存、取消、封面上传）
 *   2. 绑定文章/审核列表的事件委托（在 #sec-admin 上统一监听 click）
 *   3. 触发所有数据加载函数
 *
 * 【输入】 无参数。依赖 DOM 元素存在。
 * 【输出】 无返回值。副作用：绑定事件监听器、加载数据。
 *
 * 【事件委托策略】
 *   文章列表、待审核列表、壁纸/BGM 管理列表的按钮事件全部通过
 *   #sec-admin 上的一个 click 事件委托统一处理。
 *
 *   【为什么用事件委托而不是为每个按钮绑定事件】
 *    1. 列表内容是动态渲染的（innerHTML 替换），每次渲染后重新绑定事件太复杂。
 *    2. 事件委托只需在父容器上绑定一次，无论内容如何变化都能响应。
 *    3. 减少事件监听器数量，降低内存占用。
 *
 *   【委托流程】
 *    click 事件冒泡到 #sec-admin
 *    → e.target.closest('[data-xxx]') 查找最近的带 data-* 属性的祖先元素
 *    → 根据 data-* 属性名判断是哪个操作
 *    → 调用对应的处理函数
 *
 * 【调用者】
 *   main.js init() — 页面启动时调用
 *   （已通过 window.bindAdminEvents 暴露到全局）
 *
 * 【为什么 _previewBound 标记是必要的】
 *   参见 _previewBound 变量的注释。防止多次调用 bindAdminEvents
 *   导致重复绑定 input 事件。
 */
function bindAdminEvents() {
  // ---- 1. Markdown 实时预览 ----
  var contentEl = document.getElementById('adminContent');
  if (contentEl && !_previewBound) {
    _previewBound = true;
    contentEl.addEventListener('input', renderPreview);
  }

  // ---- 2. 保存按钮 ----
  var btnSave = document.getElementById('btnAdminSave');
  if (btnSave) btnSave.addEventListener('click', saveArticle);

  // ---- 3. 取消按钮 ----
  var btnCancel = document.getElementById('btnAdminCancel');
  if (btnCancel) btnCancel.addEventListener('click', cancelEdit);

  // ---- 4. 封面上传按钮（触发隐藏的 file input） ----
  var btnCover = document.getElementById('btnAdminCoverUpload');
  if (btnCover) btnCover.addEventListener('click', function() {
    document.getElementById('adminCoverFileInput').click();
  });
  var coverInput = document.getElementById('adminCoverFileInput');
  if (coverInput) coverInput.addEventListener('change', uploadCover);

  // ---- 5. 事件委托总入口 ----
  // 在 #sec-admin 上统一处理以下按钮的 click：
  //   [data-edit-id]     → editArticle
  //   [data-delete-id]   → deleteArticle
  //   [data-publish-id]  → publishArticle
  //   [data-approve-id]  → approveItem（审核通过）
  //   [data-reject-id]   → rejectItem（审核拒绝）
  //   [data-delete-file] → deleteManagedFile
  //   [data-edit-news]   → showNewsEditor
  //   [data-delete-news] → deleteNews
  //   [data-pin-news]    → togglePinNews
  var secAdmin = document.getElementById('sec-admin');
  if (secAdmin) {
    secAdmin.addEventListener('click', function(e) {
      // 使用 .closest() 查找最近的带 data-* 属性的元素（处理按钮内嵌套图标等情况）
      var editBtn = e.target.closest('[data-edit-id]');
      if (editBtn) { editArticle(parseInt(editBtn.getAttribute('data-edit-id'))); return; }
      var delBtn = e.target.closest('[data-delete-id]');
      if (delBtn) { deleteArticle(parseInt(delBtn.getAttribute('data-delete-id'))); return; }
      var pubBtn = e.target.closest('[data-publish-id]');
      if (pubBtn) { publishArticle(parseInt(pubBtn.getAttribute('data-publish-id'))); return; }
      var approveBtn = e.target.closest('[data-approve-id]');
      if (approveBtn) { approveItem(parseInt(approveBtn.getAttribute('data-approve-id'))); return; }
      var rejectBtn = e.target.closest('[data-reject-id]');
      if (rejectBtn) { rejectItem(parseInt(rejectBtn.getAttribute('data-reject-id'))); return; }
      var deleteFileBtn = e.target.closest('[data-delete-file]');
      if (deleteFileBtn) { deleteManagedFile(parseInt(deleteFileBtn.getAttribute('data-delete-file'))); return; }
      var editNewsBtn = e.target.closest('[data-edit-news]');
      if (editNewsBtn) { showNewsEditor(parseInt(editNewsBtn.getAttribute('data-edit-news'))); return; }
      var deleteNewsBtn = e.target.closest('[data-delete-news]');
      if (deleteNewsBtn) { deleteNews(parseInt(deleteNewsBtn.getAttribute('data-delete-news'))); return; }
      var pinNewsBtn = e.target.closest('[data-pin-news]');
      if (pinNewsBtn) { togglePinNews(parseInt(pinNewsBtn.getAttribute('data-pin-news')), pinNewsBtn.getAttribute('data-pin-val') === '1'); return; }
    });
  }

  // ---- 6. 资讯编辑器按钮 ----
  var btnNewsAdd = document.getElementById('btnAdminNewsAdd');
  if (btnNewsAdd) btnNewsAdd.addEventListener('click', function() { showNewsEditor(null); });
  var btnNewsSave = document.getElementById('btnAdminNewsSave');
  if (btnNewsSave) btnNewsSave.addEventListener('click', saveNews);
  var btnNewsCancel = document.getElementById('btnAdminNewsCancel');
  if (btnNewsCancel) btnNewsCancel.addEventListener('click', hideNewsEditor);

  // ---- 7. 首次加载所有管理面板数据 ----
  console.log('[admin] 加载管理面板: sb=' + !!sb + ' isLoggedIn=' + !!window._isLoggedIn);
  // 先设置 loading 状态（防止列表区域空白）
  document.getElementById('adminArticleList').innerHTML = '<div class="admin-empty" style="padding:20px 0;">⏳ 加载中…</div>';
  document.getElementById('adminNewsList').innerHTML = '<div class="admin-empty" style="padding:20px 0;">⏳ 加载中…</div>';
  // 并行触发所有异步加载（注意：这些函数内部有各自的 try/catch，互不影响）
  loadArticles();
  loadPendingItems();
  loadAdminWallpapers();
  loadAdminTracks();
  loadAdminNews();
}

// =========================================================================
// 资讯管理（News Management — Supabase 端的手动资讯）
// =========================================================================

/**
 * _newsEditingId — 当前正在编辑的资讯 ID
 *
 * 【与 editingId 的区别】
 *   editingId 管理的是 articles 表（文章），
 *   _newsEditingId 管理的是 anime_news 表（资讯）。
 *   两者是完全独立的数据实体，需要分开追踪。
 */
var _newsEditingId = null;

/**
 * loadAdminNews — 从 Supabase 加载资讯列表并渲染
 *
 * 【作用】
 *   查询 anime_news 表，按 news_date 降序 → id 降序排列，
 *   渲染到 #adminNewsList。
 *   同时尝试读取本地 data/anime-news.json 的条数作为提示信息。
 *
 * 【输入】 无参数。隐式依赖 window.sb 和 window._isLoggedIn。
 * 【输出】 无返回值（Promise<void>）。副作用：修改 DOM。
 *
 * 【两种资讯来源】
 *   1. Supabase anime_news 表 — 管理员手动添加/编辑的资讯（本函数管理）
 *   2. data/anime-news.json — GitHub Action 自动抓取的资讯（只读，不在此管理）
 *
 * 【为什么还要读本地 JSON】
 *   本地 JSON 是自动抓取的，管理面板无法直接编辑。
 *   但显示抓取数量可以提醒管理员：「这里的数据只是手动添加的部分，
 *   自动抓取的数据在另一个文件里」。
 *
 * 【调用者】
 *   bindAdminEvents() — 管理面板初始化
 *   saveNews() / deleteNews() / togglePinNews() — 操作后刷新
 *   reloadAdminData() — 登录后重新加载
 */
async function loadAdminNews() {
  var list = document.getElementById('adminNewsList');
  if (!list) return;

  // Supabase 未连接
  if (!sb) {
    list.innerHTML = '<div class="admin-empty" style="padding:30px 0;text-align:center;">' +
      '<div style="font-size:36px;margin-bottom:12px;">🔌</div>' +
      '<div style="color:var(--text-dim);font-size:13px;">Supabase 未连接，无法加载资讯</div>' +
    '</div>';
    return;
  }

  list.innerHTML = '<div class="admin-empty" style="padding:20px 0;">⏳ 加载中…</div>';

  var newsItems = [];
  try {
    var result = await sb.from('anime_news').select('*').order('news_date', { ascending: false }).order('id', { ascending: false });
    if (result.error) throw new Error(result.error.message || '查询失败');
    newsItems = result.data || [];
    console.log('[admin] 资讯查询完成: Supabase=' + newsItems.length + ' 条, isLoggedIn=' + !!window._isLoggedIn);
  } catch (e) {
    console.warn('加载资讯列表失败:', e.message);
    list.innerHTML = '<div class="admin-empty" style="padding:30px 0;text-align:center;">' +
      '<div style="font-size:36px;margin-bottom:12px;">⚠</div>' +
      '<div style="color:var(--text-dim);font-size:13px;">资讯加载失败</div>' +
      '<div style="color:#ff7070;font-size:11px;opacity:0.8;">' + esc(e.message) + '</div>' +
    '</div>';
    return;
  }

  // 读取本地 JSON 文件中的资讯条数（仅用于提示信息）
  var jsonNewsCount = 0;
  try {
    var localRes = await fetch('data/anime-news.json');
    var localData = await localRes.json();
    jsonNewsCount = (localData || []).length;
  } catch (e) { /* ignore — 本地文件可能不存在，不影响主流程 */ }

  // 无数据时的提示（包含本地 JSON 信息）
  if (!newsItems.length) {
    var loginStatus = window._isLoggedIn ? '已登录管理员' : '未登录';
    var jsonInfo = jsonNewsCount > 0
      ? '<div style="color:var(--text-dim);font-size:12px;margin-top:12px;line-height:1.6;">' +
          '📡 自动抓取的 ' + jsonNewsCount + ' 条资讯来自每日 GitHub Action，<br>' +
          '存储在 <code style="background:rgba(255,255,255,0.06);padding:1px 6px;border-radius:4px;">data/anime-news.json</code>（无需 Supabase）。<br>' +
          '📝 此管理面板仅列出在 Supabase 中手动添加的资讯。<br>' +
          '如需管理抓取的资讯，请使用下方「+ 新增资讯」按钮或编辑 <code>data/anime-news.json</code>。</div>'
      : '<div style="color:var(--text-dim);font-size:11px;opacity:0.5;margin-top:8px;">本地 JSON 文件中也无资讯数据</div>';
    list.innerHTML = '<div class="admin-empty" style="padding:20px 0;text-align:center;">' +
      '<div style="font-size:36px;margin-bottom:12px;">📡</div>' +
      '<div style="color:var(--text-dim);font-size:14px;margin-bottom:6px;">Supabase 中暂无资讯</div>' +
      '<div style="color:var(--text-dim);font-size:11px;opacity:0.5;">（' + loginStatus + '）</div>' +
      jsonInfo +
    '</div>';
    return;
  }

  // 正常渲染资讯列表
  list.innerHTML = newsItems.map(function(n) {
    // 状态徽章
    var badges = [];
    badges.push('<span class="admin-badge-link">' + esc(n.source || '未知来源') + '</span>');
    if (n.pinned) badges.push('<span class="admin-badge-rec">📌 置顶</span>');
    if (n.heat)  badges.push('<span class="admin-badge-link">🔥 ' + n.heat + '</span>');
    if (n.content) badges.push('<span class="admin-badge-rec">📝 含正文</span>');

    // 正文预览（去除 Markdown 标记后截取 120 字符）
    var contentPreview = n.content
      ? '<div class="admin-item-content-preview">📝 ' + esc(n.content.replace(/[#*>`\n\r]/g, '').slice(0, 120)) + (n.content.length > 120 ? '…' : '') + '</div>'
      : '';

    // 摘要预览（截取 180 字符）
    var summary = n.summary || '';
    var summaryHtml = summary
      ? '<div class="admin-item-excerpt">' + esc(summary.slice(0, 180)) + (summary.length > 180 ? '…' : '') + '</div>'
      : '';

    // 外链 URL 预览（截取 80 字符）
    var urlHtml = n.url
      ? '<div class="admin-article-meta">🔗 ' + esc(n.url.slice(0, 80)) + (n.url.length > 80 ? '…' : '') + '</div>'
      : '';

    return '<div class="admin-article-item">' +
      '<div class="admin-item-thumb-placeholder" style="font-size:20px;">📡</div>' +
      '<div class="admin-item-body">' +
        '<div class="admin-article-title">' + esc(n.title) + '</div>' +
        '<div class="admin-article-meta">' +
          '📅 ' + (n.news_date || '') + ' · ' +
          badges.join(' ') +
        '</div>' +
        summaryHtml +
        contentPreview +
        urlHtml +
      '</div>' +
      '<div class="admin-article-actions">' +
        '<button class="admin-btn-edit" data-edit-news="' + n.id + '">编辑</button>' +
        // 置顶按钮：根据当前状态显示「置顶」或「取消置顶」
        '<button class="admin-btn-pin" data-pin-news="' + n.id + '" data-pin-val="' + (n.pinned ? '1' : '0') + '">' + (n.pinned ? '取消置顶' : '置顶') + '</button>' +
        '<button class="admin-btn-delete" data-delete-news="' + n.id + '">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

/**
 * showNewsEditor — 显示资讯编辑器表单
 *
 * 【作用】
 *   显示 #adminNewsEditor 区域，隐藏「新增」按钮，显示「取消」按钮。
 *   如果传入 id，从 Supabase 查询该资讯数据并填充表单（编辑模式）；
 *   如果 id 为 null，清空表单并使用当天日期（新建模式）。
 *
 * 【输入】
 *   id (number|null) — 资讯 ID（null 表示新建模式）
 *
 * 【输出】 无返回值。
 *
 * 【副作用】
 *   - 修改 #adminNewsEditor 的 display
 *   - 设置 _newsEditingId（null = 新建，数字 = 编辑）
 *   - 填充或清空表单字段
 *
 * 【调用者】
 *   bindAdminEvents() — 事件委托中 data-edit-news 按钮
 *   #btnAdminNewsAdd 点击 — 传入 null 进入新建模式
 */
function showNewsEditor(id) {
  document.getElementById('adminNewsEditor').style.display = '';
  document.getElementById('btnAdminNewsAdd').style.display = 'none';
  document.getElementById('btnAdminNewsSave').textContent = '保存';
  document.getElementById('btnAdminNewsCancel').style.display = '';

  if (id && sb) {
    // ---- 编辑模式：从 Supabase 查询数据填充表单 ----
    _newsEditingId = id;
    sb.from('anime_news').select('*').eq('id', id).single().then(function(r) {
      if (!r.data) return;
      document.getElementById('adminNewsTitle').value = r.data.title || '';
      document.getElementById('adminNewsSummary').value = r.data.summary || '';
      document.getElementById('adminNewsContent').value = r.data.content || '';
      document.getElementById('adminNewsSource').value = r.data.source || '';
      document.getElementById('adminNewsUrl').value = r.data.url || '';
      document.getElementById('adminNewsDate').value = (r.data.news_date || '').slice(0, 10);
    });
  } else {
    // ---- 新建模式：清空表单，日期默认今天 ----
    _newsEditingId = null;
    document.getElementById('adminNewsTitle').value = '';
    document.getElementById('adminNewsSummary').value = '';
    document.getElementById('adminNewsContent').value = '';
    document.getElementById('adminNewsSource').value = '';
    document.getElementById('adminNewsUrl').value = '';
    document.getElementById('adminNewsDate').value = new Date().toISOString().slice(0, 10);
  }
}

/**
 * hideNewsEditor — 隐藏资讯编辑器表单
 *
 * 【作用】
 *   隐藏 #adminNewsEditor，显示「新增」按钮，隐藏「取消」按钮，重置 _newsEditingId。
 *
 * 【输入】 无参数。
 * 【输出】 无返回值。副作用：修改 DOM display 属性。
 *
 * 【调用者】
 *   - #btnAdminNewsCancel 点击事件
 *   - saveNews() — 保存成功后调用
 */
function hideNewsEditor() {
  document.getElementById('adminNewsEditor').style.display = 'none';
  document.getElementById('btnAdminNewsAdd').style.display = '';
  document.getElementById('btnAdminNewsCancel').style.display = 'none';
  _newsEditingId = null;
}

/**
 * saveNews — 保存（新建或更新）资讯
 *
 * 【作用】
 *   读取资讯编辑器表单的值，根据 _newsEditingId 判断是 INSERT 还是 UPDATE。
 *
 * 【输入】 无参数。隐式依赖表单 DOM 和 _newsEditingId。
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【副作用】
 *   - 写入 Supabase anime_news 表
 *   - 调用 hideNewsEditor() 隐藏编辑器
 *   - 调用 loadAdminNews() 刷新列表
 *   - 通过 EventBus 发送 'news:refresh' 事件通知主站
 *
 * 【校验】 title 不能为空。
 *
 * 【调用者】
 *   bindAdminEvents() — #btnAdminNewsSave 点击事件
 */
async function saveNews() {
  var title = document.getElementById('adminNewsTitle').value.trim();
  if (!title) { toast('标题不能为空'); return; }
  if (!sb) return;

  var payload = {
    title: title,
    summary: document.getElementById('adminNewsSummary').value.trim(),
    content: document.getElementById('adminNewsContent').value.trim(),
    source: document.getElementById('adminNewsSource').value.trim(),
    url: document.getElementById('adminNewsUrl').value.trim(),
    news_date: document.getElementById('adminNewsDate').value || new Date().toISOString().slice(0, 10),
    updated_at: new Date(),
  };

  if (_newsEditingId) {
    // 编辑模式：UPDATE
    var r = await sb.from('anime_news').update(payload).eq('id', _newsEditingId);
    if (r.error) return toast('保存失败: ' + r.error.message);
    toast('已更新', 'success');
  } else {
    // 新建模式：INSERT
    var r = await sb.from('anime_news').insert(payload);
    if (r.error) return toast('保存失败: ' + r.error.message);
    toast('已添加', 'success');
  }
  hideNewsEditor();
  loadAdminNews();
  // 通知主站资讯面板刷新
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('news:refresh');
}

/**
 * deleteNews — 删除指定资讯
 *
 * 【作用】
 *   确认后从 anime_news 表删除记录，刷新列表，通知主站。
 *
 * 【输入】
 *   id (number) — 资讯 ID
 *
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【调用者】
 *   bindAdminEvents() — 事件委托中 data-delete-news 按钮
 */
async function deleteNews(id) {
  if (!sb || !confirm('确定删除？')) return;
  await sb.from('anime_news').delete().eq('id', id);
  toast('已删除', 'success');
  loadAdminNews();
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('news:refresh');
}

/**
 * togglePinNews — 切换资讯的置顶状态
 *
 * 【作用】
 *   将资讯的 pinned 字段取反。置顶的资讯在客户端列表中排在最前面。
 *
 * 【输入】
 *   id         (number)  — 资讯 ID
 *   currentVal (boolean) — 当前置顶状态（true=已置顶, false=未置顶）
 *
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【调用者】
 *   bindAdminEvents() — 事件委托中 data-pin-news 按钮
 *
 * 【为什么 currentVal 通过 data-pin-val 属性传递】
 *   事件委托中，JavaScript 闭包无法直接获取当前项的 pinned 状态。
 *   把状态写入 data-pin-val 属性是最简单的办法。
 */
async function togglePinNews(id, currentVal) {
  if (!sb) return;
  var newVal = !currentVal;
  var r = await sb.from('anime_news').update({ pinned: newVal, updated_at: new Date() }).eq('id', id);
  if (r.error) return toast('操作失败: ' + r.error.message);
  toast(newVal ? '已置顶' : '已取消置顶', 'success');
  loadAdminNews();
  if (typeof window.EventBus !== 'undefined') window.EventBus.emit('news:refresh');
}

// =========================================================================
// ES Module 导出
// =========================================================================

export { bindAdminEvents, reloadAdminData };

// =========================================================================
// 对外暴露的 window 接口（向后兼容旧式脚本调用）
// =========================================================================

/**
 * window.bindAdminEvents — 绑定管理面板事件的全局入口
 *
 * 【调用者】 main.js init() — 页面启动时
 * 【为什么暴露到 window】 向后兼容旧式 <script> 标签引用。
 */
window.bindAdminEvents = bindAdminEvents;

/**
 * reloadAdminData — 登录后重新加载管理面板所有数据
 *
 * 【作用】
 *   管理员登录成功后，RLS 策略放开，需要重新查询以获取之前看不到的未发布内容。
 *   此函数加载所有管理面板的列表数据。
 *
 * 【输入】 无参数。隐式依赖 sb（Supabase 客户端）和 window._isLoggedIn。
 * 【输出】 无返回值（Promise<void>）。
 *
 * 【调用者】
 *   - auth.js — 登录成功后调用
 *   - main.js onLoginSuccess() — 登录成功处理
 *
 * 【为什么需要 _isLoggedIn 检查】
 *   防止在未登录状态下被意外调用。虽然登录成功后才调用此函数，
 *   但加一个守卫更安全。
 *
 * 【暴露方式】 window._reloadAdminData（以下划线开头约定为内部 API）
 */
function reloadAdminData() {
  if (!sb || !window._isLoggedIn) return;
  loadArticles();
  loadPendingItems();
  loadAdminWallpapers();
  loadAdminTracks();
  loadAdminNews();
}
window._reloadAdminData = reloadAdminData;
