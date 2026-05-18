// ==================== Articles ====================
var activeFilter = '全部';
var allTags = [];
var articles = [];

async function loadArticles() {
  // 优先从 Supabase 读取
  if (sb && _isLoggedIn) {
    try {
      var result = await sb
        .from('articles')
        .select('id, slug, title, excerpt, tags, created_at')
        .eq('published', true)
        .order('created_at', { ascending: false });

      if (!result.error && result.data && result.data.length > 0) {
        articles = result.data.map(function(a) {
          return {
            id: a.id,
            title: a.title,
            date: a.created_at.slice(0, 10),
            excerpt: a.excerpt,
            tags: a.tags,
          };
        });
        allTags = ['全部'].concat(Array.from(new Set(articles.flatMap(function(a) { return a.tags; }))));
        renderFilters();
        renderArticles();
        return;
      }
    } catch (e) {
      console.warn('Supabase 文章查询失败，降级到本地数据');
    }
  }

  // 降级: 本地 JSON
  try {
    var res = await fetch('data/articles.json');
    articles = await res.json();
  } catch (e) {
    articles = [];
  }
  allTags = ['全部'].concat(Array.from(new Set(articles.flatMap(function(a) { return a.tags; }))));
  renderFilters();
  renderArticles();
}

function renderArticles() {
  var filtered = activeFilter === '全部' ? articles : articles.filter(function(a) { return a.tags.includes(activeFilter); });
  var grid = document.getElementById('articleGrid');
  grid.innerHTML = filtered.map(function(a) {
    return '<div class="article-card">' +
      '<div class="article-title">' + a.title + '</div>' +
      '<div class="article-meta">📅 ' + a.date + '</div>' +
      '<div class="article-excerpt">' + a.excerpt + '</div>' +
      '<div class="article-tags">' + a.tags.map(function(t) { return '<span class="tag purple" style="font-size:11px;padding:3px 10px;">' + t + '</span>'; }).join('') + '</div>' +
    '</div>';
  }).join('');
}

function renderFilters() {
  var bar = document.getElementById('filterBar');
  bar.innerHTML = allTags.map(function(t) {
    return '<span class="filter-tag' + (t === activeFilter ? ' selected' : '') + '" onclick="setFilter(\'' + t + '\')">' + t + '</span>';
  }).join('');
}

function setFilter(tag) {
  activeFilter = tag;
  renderFilters();
  renderArticles();
}
