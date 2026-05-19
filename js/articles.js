// ==================== Articles ====================
var activeFilter = '全部';
var searchQuery = '';
var allTags = [];
var articles = [];
var _articleMap = {};

async function loadArticles() {
  if (sb && _isLoggedIn) {
    try {
      var result = await sb
        .from('articles')
        .select('id, slug, title, excerpt, content, tags, url, cover, recommended, public, spoiler, created_at')
        .eq('published', true)
        .order('created_at', { ascending: false });

      if (!result.error && result.data && result.data.length > 0) {
        articles = result.data.map(function(a) {
          _articleMap[a.id] = a;
          return {
            id: a.id, title: a.title,
            date: a.created_at.slice(0, 10),
            excerpt: a.excerpt, tags: a.tags,
            url: a.url, cover: a.cover, recommended: a.recommended, spoiler: a.spoiler,
          };
        });
        allTags = ['全部'].concat(Array.from(new Set(articles.flatMap(function(a) { return a.tags; }))));
        renderFilters(); renderArticles(); bindSearchEvents(); return;
      }
    } catch (e) { console.warn('Supabase 文章查询失败，降级到本地'); }
  }

  // 降级：未登录仅显示公开文章，已登录显示全部
  try {
    var res = await fetch('data/articles.json');
    var all = await res.json();
    articles = _isLoggedIn ? all : all.filter(function(a) { return a.public !== false; });
    articles.forEach(function(a) { _articleMap[a.id] = a; });
  } catch (e) { articles = []; }
  allTags = ['全部'].concat(Array.from(new Set(articles.flatMap(function(a) { return a.tags; }))));
  renderFilters(); renderArticles(); bindSearchEvents();
}

function renderArticles() {
  var filtered = articles;
  if (activeFilter !== '全部') {
    filtered = filtered.filter(function(a) { return a.tags.includes(activeFilter); });
  }
  if (searchQuery) {
    var q = searchQuery.toLowerCase();
    filtered = filtered.filter(function(a) {
      return a.title.toLowerCase().indexOf(q) !== -1
        || a.excerpt.toLowerCase().indexOf(q) !== -1
        || a.tags.some(function(t) { return t.toLowerCase().indexOf(q) !== -1; });
    });
  }
  var grid = document.getElementById('articleGrid');
  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><div>该标签下暂无文章</div></div>';
    return;
  }
  grid.innerHTML = filtered.map(function(a) {
    var coverHtml = a.cover ? '<img class="article-cover" src="' + escHtml(a.cover) + '" alt="" loading="lazy">' : '';
    var recBadge = a.recommended ? '<span class="article-rec-badge" title="推荐">⭐ 推荐</span>' : '';
    var spoilerBadge = a.spoiler ? '<span class="article-spoiler-badge" title="含剧透">⚠ 剧透</span>' : '';
    var linkBtn = a.url ? '<a class="article-link-btn" href="' + escHtml(a.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="打开外链">🔗 去逛逛</a>' : '';
    return '<div class="article-card" onclick="openArticleDetail(' + a.id + ')">' +
      coverHtml +
      '<div class="article-title">' + escHtml(a.title) + recBadge + spoilerBadge + '</div>' +
      '<div class="article-meta">📅 ' + escHtml(a.date) + '</div>' +
      '<div class="article-excerpt">' + escHtml(a.excerpt) + '</div>' +
      '<div class="article-tags">' + a.tags.map(function(t) { return '<span class="tag purple">' + escHtml(t) + '</span>'; }).join('') + '</div>' +
      linkBtn +
    '</div>';
  }).join('');
}

function renderFilters() {
  var bar = document.getElementById('filterBar');
  bar.innerHTML = allTags.map(function(t) {
    return '<span class="filter-tag' + (t === activeFilter ? ' selected' : '') + '" onclick="setFilter(\'' + escHtml(t).replace(/'/g, "\\'") + '\')">' + escHtml(t) + '</span>';
  }).join('');
}

function setFilter(tag) {
  activeFilter = tag;
  renderFilters();
  renderArticles();
}

function bindSearchEvents() {
  var input = document.getElementById('articleSearch');
  if (!input) return;
  input.addEventListener('input', function() {
    searchQuery = this.value.trim();
    renderArticles();
  });
}

// ---- Article Detail Modal ----
function openArticleDetail(id) {
  var a = _articleMap[id];
  if (!a) return;

  // 重置滚动位置，避免看到上一篇的滚动位置
  var modal = document.getElementById('articleModal');
  var scrollContainer = modal.querySelector('.modal');
  if (scrollContainer) scrollContainer.scrollTop = 0;

  var recBadge = a.recommended ? ' ⭐推荐' : '';
  var spoilerBadge = a.spoiler ? ' ⚠剧透' : '';
  document.getElementById('articleModalTitle').textContent = a.title + recBadge + spoilerBadge;
  document.getElementById('articleModalMeta').textContent = '📅 ' + (a.created_at || a.date || '').slice(0, 10);

  var tagsHtml = (a.tags || []).map(function(t) {
    return '<span class="tag purple">' + escHtml(t) + '</span>';
  }).join(' ');
  document.getElementById('articleModalTags').innerHTML = tagsHtml;

  // 封面图
  var coverEl = document.getElementById('articleModalCover');
  if (a.cover) {
    if (!coverEl) {
      coverEl = document.createElement('img');
      coverEl.id = 'articleModalCover';
      coverEl.style.cssText = 'width:100%;max-height:240px;object-fit:cover;border-radius:12px;margin-bottom:16px;';
      var tagsContainer = document.getElementById('articleModalTags');
      tagsContainer.parentNode.insertBefore(coverEl, tagsContainer);
    }
    coverEl.src = a.cover;
    coverEl.style.display = '';
  } else if (coverEl) {
    coverEl.style.display = 'none';
  }

  // 剧透警告
  var spoilerWarn = document.getElementById('articleModalSpoilerWarn');
  if (a.spoiler) {
    if (!spoilerWarn) {
      spoilerWarn = document.createElement('div');
      spoilerWarn.id = 'articleModalSpoilerWarn';
      spoilerWarn.className = 'spoiler-warn';
      spoilerWarn.textContent = '⚠ 本文含有剧透内容，未通关相关作品请谨慎阅读';
      var contentEl = document.getElementById('articleModalContent');
      contentEl.parentNode.insertBefore(spoilerWarn, contentEl);
    }
    spoilerWarn.style.display = '';
  } else if (spoilerWarn) {
    spoilerWarn.style.display = 'none';
  }

  // 渲染 Markdown 正文（移除原始 HTML 防 XSS）
  var content = a.content || a.excerpt || '';
  if (typeof marked !== 'undefined') {
    var html = marked.parse(content);
    document.getElementById('articleModalContent').innerHTML = sanitizeHtml(html);
  } else {
    document.getElementById('articleModalContent').textContent = content;
  }

  // 外链按钮
  var linkWrap = document.getElementById('articleModalLinkWrap');
  if (a.url) {
    if (!linkWrap) {
      linkWrap = document.createElement('div');
      linkWrap.id = 'articleModalLinkWrap';
      linkWrap.style.cssText = 'margin-top:20px;text-align:center;';
      document.getElementById('articleModalContent').after(linkWrap);
    }
    linkWrap.innerHTML = '<a href="' + escHtml(a.url) + '" target="_blank" rel="noopener" class="modal-link-btn">🔗 访问原文</a>';
    linkWrap.style.display = '';
  } else if (linkWrap) {
    linkWrap.style.display = 'none';
  }

  document.getElementById('articleModal').classList.remove('hidden');
}

function closeArticleModal() {
  document.getElementById('articleModal').classList.add('hidden');
}

// 点击遮罩关闭
document.addEventListener('click', function(e) {
  if (e.target.id === 'articleModal') closeArticleModal();
});

// ==================== Article Submission ====================
async function submitArticle() {
  var title = document.getElementById('submitTitle').value.trim();
  var content = document.getElementById('submitContent').value.trim();
  var msgEl = document.getElementById('submitMsg');

  if (!title) { msgEl.textContent = '请填写文章标题'; msgEl.className = 'submit-msg error'; return; }
  if (!content) { msgEl.textContent = '请填写正文内容'; msgEl.className = 'submit-msg error'; return; }
  if (content.length < 20) { msgEl.textContent = '正文至少 20 个字符'; msgEl.className = 'submit-msg error'; return; }

  var tagsRaw = document.getElementById('submitTags').value.trim();
  var tags = tagsRaw ? tagsRaw.split(/[,，]/).map(function(t) { return t.trim(); }).filter(Boolean) : [];
  var url = document.getElementById('submitUrl').value.trim() || null;
  var cover = document.getElementById('submitCover').value.trim() || null;

  if (!sb) {
    msgEl.textContent = '服务暂不可用，请稍后再试';
    msgEl.className = 'submit-msg error';
    return;
  }

  var btn = document.getElementById('btnSubmitArticle');
  btn.disabled = true;
  btn.textContent = '提交中...';
  msgEl.textContent = '';
  msgEl.className = 'submit-msg';

  try {
    var result = await sb.from('articles').insert({
      title: title,
      slug: title.toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '').slice(0, 50),
      content: content,
      tags: tags,
      url: url,
      cover: cover,
      excerpt: content.replace(/[#*>`\n\r]/g, '').slice(0, 120),
      published: false,
      recommended: false,
      spoiler: false,
    });

    if (result.error) {
      msgEl.textContent = '投稿失败: ' + (result.error.message || '未知错误');
      msgEl.className = 'submit-msg error';
    } else {
      msgEl.textContent = '投稿成功！等待管理员审核后即可发布 ✦';
      msgEl.className = 'submit-msg success';
      document.getElementById('submitTitle').value = '';
      document.getElementById('submitContent').value = '';
      document.getElementById('submitTags').value = '';
      document.getElementById('submitUrl').value = '';
      document.getElementById('submitCover').value = '';
    }
  } catch (e) {
    msgEl.textContent = '网络错误，请稍后重试';
    msgEl.className = 'submit-msg error';
  }

  btn.disabled = false;
  btn.textContent = '提交投稿';
}

function sanitizeHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript\s*:/gi, 'blocked:');
}

function bindSubmitEvents() {
  var btn = document.getElementById('btnSubmitArticle');
  if (btn) btn.addEventListener('click', submitArticle);
}
