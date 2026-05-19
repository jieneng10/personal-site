// ==================== Articles ====================
(function() {
  var activeFilter = '全部';
  var searchQuery = '';
  var articleView = 'cards';
  var allTags = [];
  var articles = [];
  var _articleMap = {};

  async function loadArticles() {
    var sbClient = window.sb;
    if (sbClient && window._isLoggedIn) {
      try {
        var result = await sbClient
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
      articles = window._isLoggedIn ? all : all.filter(function(a) { return a.public !== false; });
      articles.forEach(function(a) { _articleMap[a.id] = a; });
    } catch (e) { articles = []; }
    allTags = ['全部'].concat(Array.from(new Set(articles.flatMap(function(a) { return a.tags; }))));
    renderFilters(); renderArticles(); bindSearchEvents();
  }

  function getFilteredArticles() {
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
    return filtered;
  }

  function ensureTimelineEl() {
    var el = document.getElementById('articleTimeline');
    if (!el) {
      el = document.createElement('div');
      el.id = 'articleTimeline';
      el.className = 'article-timeline';
      document.getElementById('articleGrid').after(el);
    }
    return el;
  }

  function renderArticles() {
    var filtered = getFilteredArticles();
    var grid = document.getElementById('articleGrid');
    var timeline = ensureTimelineEl();

    if (articleView === 'cards') {
      timeline.classList.remove('active');
      grid.classList.add('active');
      grid.style.display = '';
      timeline.style.display = 'none';
      if (filtered.length === 0) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><div>该标签下暂无文章</div></div>';
        return;
      }
      grid.innerHTML = filtered.map(function(a) {
        var coverHtml = a.cover ? '<img class="article-cover" src="' + escHtml(a.cover) + '" alt="" loading="lazy">' : '';
        var recBadge = a.recommended ? '<span class="article-rec-badge" title="推荐">⭐ 推荐</span>' : '';
        var spoilerBadge = a.spoiler ? '<span class="article-spoiler-badge" title="含剧透">⚠ 剧透</span>' : '';
        var linkBtn = a.url ? '<a class="article-link-btn" href="' + escHtml(a.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="打开外链">🔗 去逛逛</a>' : '';
        return '<div class="article-card" onclick="window.openArticleDetail(' + a.id + ')">' +
          coverHtml +
          '<div class="article-title">' + escHtml(a.title) + recBadge + spoilerBadge + '</div>' +
          '<div class="article-meta">📅 ' + escHtml(a.date) + '</div>' +
          '<div class="article-excerpt">' + escHtml(a.excerpt) + '</div>' +
          '<div class="article-tags">' + a.tags.map(function(t) { return '<span class="tag purple">' + escHtml(t) + '</span>'; }).join('') + '</div>' +
          linkBtn +
        '</div>';
      }).join('');
    } else {
      grid.classList.remove('active');
      grid.style.display = 'none';
      timeline.classList.add('active');
      timeline.style.display = '';
      if (filtered.length === 0) {
        timeline.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><div>该标签下暂无文章</div></div>';
        return;
      }
      var byYear = {};
      filtered.forEach(function(a) {
        var y = (a.date || '').slice(0, 4) || '未知';
        if (!byYear[y]) byYear[y] = [];
        byYear[y].push(a);
      });
      var years = Object.keys(byYear).sort(function(a, b) { return b - a; });
      timeline.innerHTML = years.map(function(y) {
        var items = byYear[y].map(function(a) {
          var recBadge = a.recommended ? '<span class="article-rec-badge" title="推荐">⭐</span>' : '';
          var spoilerBadge = a.spoiler ? '<span class="article-spoiler-badge" title="含剧透">⚠</span>' : '';
          return '<div class="timeline-item" onclick="window.openArticleDetail(' + a.id + ')">' +
            '<div class="timeline-item-date">📅 ' + escHtml(a.date) + '</div>' +
            '<div class="timeline-item-title">' + escHtml(a.title) + recBadge + spoilerBadge + '</div>' +
            '<div class="timeline-item-excerpt">' + escHtml(a.excerpt) + '</div>' +
            '<div class="timeline-item-tags">' + a.tags.map(function(t) { return '<span class="tag purple">' + escHtml(t) + '</span>'; }).join('') + '</div>' +
          '</div>';
        }).join('');
        return '<div class="timeline-year">' + escHtml(y) + '</div>' + items;
      }).join('');
    }
  }

  function renderFilters() {
    var bar = document.getElementById('filterBar');
    bar.innerHTML = allTags.map(function(t) {
      return '<span class="filter-tag' + (t === activeFilter ? ' selected' : '') + '" onclick="window.setFilter(\'' + escHtml(t).replace(/'/g, "\\'") + '\')">' + escHtml(t) + '</span>';
    }).join('');
  }

  function setFilter(tag) {
    activeFilter = tag;
    renderFilters();
    renderArticles();
  }

  function bindSearchEvents() {
    var input = document.getElementById('articleSearch');
    if (input) {
      input.addEventListener('input', function() {
        searchQuery = this.value.trim();
        renderArticles();
      });
    }
    var toggle = document.getElementById('viewToggle');
    if (toggle) {
      toggle.addEventListener('click', function(e) {
        var opt = e.target.closest('.view-option');
        if (!opt) return;
        articleView = opt.dataset.view;
        toggle.querySelectorAll('.view-option').forEach(function(o) { o.classList.remove('active'); });
        opt.classList.add('active');
        renderArticles();
      });
    }
  }

  // ---- Article Detail Modal ----
  function openArticleDetail(id) {
    var a = _articleMap[id];
    if (!a) return;

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

    var content = a.content || a.excerpt || '';
    if (typeof marked !== 'undefined') {
      var html = marked.parse(content);
      document.getElementById('articleModalContent').innerHTML = sanitizeHtml(html);
    } else {
      document.getElementById('articleModalContent').textContent = content;
    }

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

    var sbClient = window.sb;
    if (!sbClient) {
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
      var result = await sbClient.from('articles').insert({
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
    try {
      var doc = new DOMParser().parseFromString(String(html), 'text/html');
      _walkSanitize(doc.body);
      return doc.body.innerHTML;
    } catch (e) {
      return String(html).replace(/<[^>]*>/g, '');
    }
  }

  var _BLOCKED_TAGS = { script:1, iframe:1, object:1, embed:1, applet:1, link:1, style:1,
    meta:1, base:1, form:1, input:1, textarea:1, button:1, select:1, option:1 };

  function _walkSanitize(node) {
    if (node.nodeType === 3) return;
    if (node.nodeType !== 1) { node.parentNode && node.parentNode.removeChild(node); return; }
    var tag = node.tagName.toLowerCase();
    if (_BLOCKED_TAGS[tag]) { node.parentNode && node.parentNode.removeChild(node); return; }
    var attrs = node.attributes;
    if (attrs) {
      for (var i = attrs.length - 1; i >= 0; i--) {
        var aname = attrs[i].name.toLowerCase();
        if (/^on\w+/.test(aname)) { node.removeAttribute(aname); continue; }
        var aval = attrs[i].value || '';
        if (/^\s*javascript\s*:/i.test(aval)) { node.removeAttribute(aname); continue; }
        if ((aname === 'href' || aname === 'src' || aname === 'action' || aname === 'formaction')
            && /^\s*javascript\s*:/i.test(aval)) {
          node.removeAttribute(aname);
        }
      }
    }
    var children = Array.prototype.slice.call(node.childNodes);
    for (var j = 0; j < children.length; j++) { _walkSanitize(children[j]); }
  }

  function bindSubmitEvents() {
    var btn = document.getElementById('btnSubmitArticle');
    if (btn) btn.addEventListener('click', submitArticle);
  }

  window.loadArticles = loadArticles;
  window.renderArticles = renderArticles;
  window.renderFilters = renderFilters;
  window.setFilter = setFilter;
  window.openArticleDetail = openArticleDetail;
  window.closeArticleModal = closeArticleModal;
  window.sanitizeHtml = sanitizeHtml;
  window.bindSubmitEvents = bindSubmitEvents;
})();
