// ==================== Articles ====================
var activeFilter = '全部';
var allTags = [];
var articles = [];
var _articleMap = {};

async function loadArticles() {
  if (sb && _isLoggedIn) {
    try {
      var result = await sb
        .from('articles')
        .select('id, slug, title, excerpt, content, tags, url, cover, recommended, public, created_at')
        .eq('published', true)
        .order('created_at', { ascending: false });

      if (!result.error && result.data && result.data.length > 0) {
        articles = result.data.map(function(a) {
          _articleMap[a.id] = a;
          return {
            id: a.id, title: a.title,
            date: a.created_at.slice(0, 10),
            excerpt: a.excerpt, tags: a.tags,
            url: a.url, cover: a.cover, recommended: a.recommended,
          };
        });
        allTags = ['全部'].concat(Array.from(new Set(articles.flatMap(function(a) { return a.tags; }))));
        renderFilters(); renderArticles(); return;
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
  renderFilters(); renderArticles();
}

function renderArticles() {
  var filtered = activeFilter === '全部' ? articles : articles.filter(function(a) { return a.tags.includes(activeFilter); });
  var grid = document.getElementById('articleGrid');
  grid.innerHTML = filtered.map(function(a) {
    var coverHtml = a.cover ? '<img class="article-cover" src="' + escHtml(a.cover) + '" alt="" loading="lazy">' : '';
    var recBadge = a.recommended ? '<span class="article-rec-badge" title="推荐">⭐ 推荐</span>' : '';
    var linkBtn = a.url ? '<a class="article-link-btn" href="' + escHtml(a.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="打开外链">🔗 去逛逛</a>' : '';
    return '<div class="article-card" onclick="openArticleDetail(' + a.id + ')">' +
      coverHtml +
      '<div class="article-title">' + escHtml(a.title) + recBadge + '</div>' +
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

// ---- Article Detail Modal ----
function openArticleDetail(id) {
  var a = _articleMap[id];
  if (!a) return;

  var recBadge = a.recommended ? ' ⭐推荐' : '';
  document.getElementById('articleModalTitle').textContent = a.title + recBadge;
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

  // 渲染 Markdown 正文
  var content = a.content || a.excerpt || '';
  if (typeof marked !== 'undefined') {
    document.getElementById('articleModalContent').innerHTML = marked.parse(content);
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
