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
        .select('id, slug, title, excerpt, content, tags, created_at')
        .eq('published', true)
        .order('created_at', { ascending: false });

      if (!result.error && result.data && result.data.length > 0) {
        articles = result.data.map(function(a) {
          _articleMap[a.id] = a;
          return {
            id: a.id, title: a.title,
            date: a.created_at.slice(0, 10),
            excerpt: a.excerpt, tags: a.tags,
          };
        });
        allTags = ['全部'].concat(Array.from(new Set(articles.flatMap(function(a) { return a.tags; }))));
        renderFilters(); renderArticles(); return;
      }
    } catch (e) { console.warn('Supabase 文章查询失败，降级到本地'); }
  }

  // 降级
  try {
    var res = await fetch('data/articles.json');
    articles = await res.json();
    articles.forEach(function(a) { _articleMap[a.id] = a; });
  } catch (e) { articles = []; }
  allTags = ['全部'].concat(Array.from(new Set(articles.flatMap(function(a) { return a.tags; }))));
  renderFilters(); renderArticles();
}

function renderArticles() {
  var filtered = activeFilter === '全部' ? articles : articles.filter(function(a) { return a.tags.includes(activeFilter); });
  var grid = document.getElementById('articleGrid');
  grid.innerHTML = filtered.map(function(a) {
    return '<div class="article-card" onclick="openArticleDetail(' + a.id + ')">' +
      '<div class="article-title">' + escHtml(a.title) + '</div>' +
      '<div class="article-meta">📅 ' + escHtml(a.date) + '</div>' +
      '<div class="article-excerpt">' + escHtml(a.excerpt) + '</div>' +
      '<div class="article-tags">' + a.tags.map(function(t) { return '<span class="tag purple">' + escHtml(t) + '</span>'; }).join('') + '</div>' +
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

  document.getElementById('articleModalTitle').textContent = a.title;
  document.getElementById('articleModalMeta').textContent = '📅 ' + (a.created_at || a.date || '').slice(0, 10);

  var tagsHtml = (a.tags || []).map(function(t) {
    return '<span class="tag purple">' + escHtml(t) + '</span>';
  }).join(' ');
  document.getElementById('articleModalTags').innerHTML = tagsHtml;

  // 渲染 Markdown 正文
  var content = a.content || a.excerpt || '';
  if (typeof marked !== 'undefined') {
    document.getElementById('articleModalContent').innerHTML = marked.parse(content);
  } else {
    document.getElementById('articleModalContent').textContent = content;
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
