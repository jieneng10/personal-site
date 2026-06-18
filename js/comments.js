/**
 * ==================== 评论系统 — ES Module ====================
 *
 * 【它做什么】
 *   留言板 / 文章评论区。支持：
 *     - 游客匿名评论（需管理员审核）
 *     - 登录用户直接发布（自动通过）
 *     - 回复嵌套（两级：顶级 + 回复）
 *     - 管理员审核 / 删除
 *
 * 【数据流】
 *   游客提交 → Supabase (published=false) → 管理员面板审核 → published=true → 所有人可见
 *   登录提交 → Supabase (published=true) → 立刻可见
 *
 * 【依赖】
 *   import { sb, escHtml, showToast, getCachedUser } from './supabase.mjs'
 *   import { on } from './event-bus.mjs'
 */
import { sb, escHtml, showToast, getCachedUser } from './supabase.mjs';
import { on } from './event-bus.mjs';

// ═══════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════

/** 当前评论列表（内存缓存） */
let _comments = [];

/** 当前上下文：null = 留言板首页，数字 = 某篇文章的评论区 */
let _articleId = null;

/** 回复某条评论时，parentId 被设置 */
let _replyTo = null;

/** 是否正在加载 */
let _loading = false;

// ═══════════════════════════════════════════════════════════
// API：从 Supabase 拉取评论
// ═══════════════════════════════════════════════════════════

/**
 * 拉取已发布的评论（含嵌套回复）
 *
 * @param {number|null} articleId - 文章 ID，null = 留言板
 * @returns {Promise<Array>} 评论数组（树形结构）
 */
async function fetchComments(articleId) {
  if (!sb) {
    // Supabase 未加载（离线/headless），显示提示
    const container = document.getElementById('commentsList');
    if (container) {
      container.innerHTML = '<div class="comment-empty">请登录后查看留言 ✦</div>';
    }
    return [];
  }

  const query = sb
    .from('comments')
    .select('*')
    .eq('published', true)
    .order('created_at', { ascending: false });

  if (articleId) {
    query.eq('article_id', articleId);
  } else {
    query.is('article_id', null); // 留言板：article_id IS NULL
  }

  const { data } = await query;
  if (!data) return [];

  // 构建树形：顶级评论 + 子评论
  const roots = [];
  const map = {};
  for (const c of data) {
    c.replies = [];
    map[c.id] = c;
  }
  for (const c of data) {
    if (c.parent_id && map[c.parent_id]) {
      map[c.parent_id].replies.push(c);
    } else {
      roots.push(c);
    }
  }
  return roots;
}

// ═══════════════════════════════════════════════════════════
// API：提交评论
// ═══════════════════════════════════════════════════════════

/**
 * 提交一条新评论
 *
 * @param {string} content   - 评论正文（1-2000 字）
 * @param {number|null} articleId - 文章 ID
 * @param {number|null} parentId  - 回复哪条评论
 * @returns {Promise<boolean>} 是否成功
 */
async function submitComment(content, articleId, parentId) {
  // 离线/未初始化时仍可填写，但提交时需要网络
  if (!sb) {
    showToast('离线模式不可用，请连接网络后重试', 'warn');
    return false;
  }
  if (!content || !content.trim()) {
    showToast('内容不能为空', 'warn');
    return false;
  }
  if (content.length > 2000) {
    showToast('评论不能超过 2000 字', 'warn');
    return false;
  }

  const user = await getCachedUser();
  const isLoggedIn = !!user;

  const row = {
    article_id: articleId || null,
    parent_id:  parentId  || null,
    author_name: isLoggedIn ? (user.user_metadata?.nickname || '用户') : '匿名',
    content:     content.trim(),
    published:   isLoggedIn, // 登录用户自动通过
  };
  if (isLoggedIn) row.user_id = user.id;

  const { error } = await sb.from('comments').insert(row);
  if (error) {
    showToast('提交失败，请重试', 'error');
    return false;
  }

  showToast(
    isLoggedIn ? '评论已发布 ✦' : '评论已提交，审核通过后可见',
    'success'
  );
  return true;
}

/**
 * 管理员删除评论
 *
 * @param {number} id - 评论 ID
 */
async function deleteComment(id) {
  if (!confirm('确定删除这条评论？')) return;
  const { error } = await sb.from('comments').delete().eq('id', id);
  if (error) {
    showToast('删除失败', 'error');
    return;
  }
  showToast('已删除', 'success');
  renderComments();
}

// ═══════════════════════════════════════════════════════════
// UI 渲染
// ═══════════════════════════════════════════════════════════

/**
 * 渲染一条评论（递归渲染回复）
 *
 * @param {object}  comment - 评论对象
 * @param {number}  depth   - 嵌套深度（0 = 顶级，1 = 回复）
 * @param {boolean} isAdmin - 当前用户是否为管理员
 * @returns {string} HTML
 */
function renderCommentHTML(comment, depth, isAdmin) {
  const date = (comment.created_at || '').slice(0, 10);
  const time = (comment.created_at || '').slice(11, 16);
  const indent = depth > 0 ? ' style="margin-left:32px;border-left:2px solid rgba(180,140,220,0.15);padding-left:14px;"' : '';

  const replyBtn = !depth
    ? `<button class="comment-reply-btn" data-reply-to="${comment.id}" title="回复">↩</button>`
    : '';

  const deleteBtn = isAdmin
    ? `<button class="comment-del-btn" data-delete-comment="${comment.id}" title="删除">✕</button>`
    : '';

  const pendingBadge = !comment.published
    ? '<span class="comment-pending-badge">待审核</span>'
    : '';

  let html =
    `<div class="comment-item"${indent} data-comment-id="${comment.id}">` +
      `<div class="comment-meta">` +
        `<span class="comment-author">${escHtml(comment.author_name)}</span>` +
        `<span class="comment-date">${date} ${time}</span>` +
        pendingBadge +
      `</div>` +
      `<div class="comment-content">${escHtml(comment.content)}</div>` +
      `<div class="comment-actions">${replyBtn}${deleteBtn}</div>` +
    `</div>`;

  // 渲染子回复
  if (comment.replies && comment.replies.length) {
    for (const reply of comment.replies) {
      html += renderCommentHTML(reply, depth + 1, isAdmin);
    }
  }
  return html;
}

/**
 * 渲染评论区完整 UI
 */
async function renderComments() {
  const container = document.getElementById('commentsList');
  if (!container) return;

  if (_loading) return;
  _loading = true;
  container.innerHTML = '<div class="comment-loading">加载评论中...</div>';

  try {
    _comments = await fetchComments(_articleId);
  } catch (e) {
    _comments = [];
    container.innerHTML = '<div class="comment-empty">加载失败，请稍后重试</div>';
    _loading = false;
    return;
  }
  _loading = false;

  if (!_comments.length) {
    container.innerHTML = '<div class="comment-empty">还没有评论，来说两句吧 ✦</div>';
    return;
  }

  const isAdmin = window._isLoggedIn && document.querySelector('.admin-only[style*="display:none"]') === null;

  let html = '';
  for (const c of _comments) {
    html += renderCommentHTML(c, 0, isAdmin);
  }
  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════
// 事件绑定
// ═══════════════════════════════════════════════════════════

function bindCommentsEvents() {
  const form = document.getElementById('commentForm');
  if (!form) return;

  // 提交表单
  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    const textarea = document.getElementById('commentInput');
    if (!textarea) return;
    const ok = await submitComment(textarea.value, _articleId, _replyTo);
    if (ok) {
      textarea.value = '';
      _replyTo = null;
      updateReplyIndicator();
      renderComments();
    }
  });

  // 评论区事件委托
  const list = document.getElementById('commentsList');
  if (list) {
    list.addEventListener('click', async function(e) {
      // 回复按钮
      const replyBtn = e.target.closest('[data-reply-to]');
      if (replyBtn) {
        _replyTo = parseInt(replyBtn.dataset.replyTo);
        updateReplyIndicator();
        document.getElementById('commentInput')?.focus();
        return;
      }
      // 删除按钮（管理员）
      const delBtn = e.target.closest('[data-delete-comment]');
      if (delBtn) {
        await deleteComment(parseInt(delBtn.dataset.deleteComment));
      }
    });
  }
}

/** 更新回复提示条 */
function updateReplyIndicator() {
  const el = document.getElementById('replyIndicator');
  if (!el) return;
  if (!_replyTo) {
    el.style.display = 'none';
    return;
  }
  const parent = _comments.find(c => c.id === _replyTo) || {};
  el.innerHTML = `↩ 回复 <strong>${escHtml(parent.author_name || '')}</strong> <button id="cancelReply" style="margin-left:8px;cursor:pointer;background:none;border:none;color:var(--accent);">取消</button>`;
  el.style.display = '';
  document.getElementById('cancelReply')?.addEventListener('click', function() {
    _replyTo = null;
    updateReplyIndicator();
  });
}

// ═══════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════

/**
 * 初始化评论模块
 *
 * @param {number|null} [articleId] - 文章 ID，null 为留言板首页
 * @returns {Promise<void>}
 */
export async function initComments(articleId) {
  _articleId = articleId || null;
  _replyTo = null;
  bindCommentsEvents();
  updateReplyIndicator();
  await renderComments();
}

// 页面启动后自动初始化留言板
on('init:ready', function() {
  initComments(null); // null = 留言板首页（非文章内评论区）
});

// 登录成功时自动刷新评论
on('auth:login', function() {
  renderComments();
});

// 暴露到 window（admin.js 可能需要刷新审核状态）
window._renderComments = renderComments;
window._initComments = initComments;
