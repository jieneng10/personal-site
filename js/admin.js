// ==================== Admin — Inline Article Manager ====================
// Runs within index.html as a panel section; auth handled by main page.
(function() {
  var sb = window.sb;
  var editingId = null;

  var toast = window.showToast || function(msg, type) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.style.display = '';
    clearTimeout(el._t); el._t = setTimeout(function() { el.style.display = 'none'; }, 2000);
  };
  var esc = window.escHtml || function(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  };

  // ---- loadArticles ----
  async function loadArticles() {
    if (!sb) return;
    var result = await sb.from('articles').select('*').order('created_at', { ascending: false });
    var list = document.getElementById('adminArticleList');
    var data = result.data || [];
    if (!data.length) {
      list.innerHTML = '<div class="admin-empty">还没有文章，写一篇吧 ✦</div>';
      return;
    }
    list.innerHTML = data.map(function(a) {
      var badges = [];
      if (!a.published) badges.push('<span class="admin-badge-pending">[待审核]</span>');
      if (a.recommended) badges.push('<span class="admin-badge-rec">⭐推荐</span>');
      if (a.url) badges.push('<span class="admin-badge-link">🔗外链</span>');
      return '<div class="admin-article-item">' +
        '<div>' +
          '<div class="admin-article-title">' + esc(a.title) + ' ' + badges.join(' ') + '</div>' +
          '<div class="admin-article-meta">' + (a.created_at || '').slice(0, 10) + ' · ' + esc((a.tags || []).join(', ')) + '</div>' +
        '</div>' +
        '<div class="admin-article-actions">' +
          (!a.published ? '<button class="admin-btn-publish" data-publish-id="' + a.id + '">发布</button>' : '') +
          '<button class="admin-btn-edit" data-edit-id="' + a.id + '">编辑</button>' +
          '<button class="admin-btn-delete" data-delete-id="' + a.id + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ---- editArticle ----
  function editArticle(id) {
    sb.from('articles').select('*').eq('id', id).single().then(function(result) {
      var data = result.data;
      if (!data) return;
      document.getElementById('adminEditorTitle').textContent = '编辑文章';
      document.getElementById('adminTitle').value = data.title;
      document.getElementById('adminSlug').value = data.slug || '';
      document.getElementById('adminTags').value = (data.tags || []).join(', ');
      document.getElementById('adminUrl').value = data.url || '';
      document.getElementById('adminCover').value = data.cover || '';
      document.getElementById('adminExcerpt').value = data.excerpt || '';
      document.getElementById('adminContent').value = data.content || '';
      document.getElementById('adminPublished').checked = data.published;
      document.getElementById('adminRecommended').checked = data.recommended || false;
      document.getElementById('adminSpoiler').checked = data.spoiler || false;
      document.getElementById('btnAdminSave').textContent = '保存修改';
      document.getElementById('btnAdminCancel').style.display = '';
      editingId = data.id;
      renderPreview();
    });
  }

  // ---- cancelEdit ----
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
    document.getElementById('adminPublished').checked = true;
    document.getElementById('adminRecommended').checked = false;
    document.getElementById('adminSpoiler').checked = false;
    document.getElementById('btnAdminSave').textContent = '发布';
    document.getElementById('btnAdminCancel').style.display = 'none';
    document.getElementById('adminPreview').innerHTML = '<span style="color:var(--text-dim);">预览区域...</span>';
  }

  // ---- saveArticle ----
  async function saveArticle() {
    var title = document.getElementById('adminTitle').value.trim();
    var content = document.getElementById('adminContent').value.trim();
    if (!title) return toast('标题不能为空');
    if (!content) return toast('正文不能为空');

    var tags = document.getElementById('adminTags').value.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
    var slug = document.getElementById('adminSlug').value.trim()
      || title.toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '').slice(0, 50);
    var published = document.getElementById('adminPublished').checked;

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
      var updateResult = await sb.from('articles').update(payload).eq('id', editingId);
      if (updateResult.error) return toast('保存失败: ' + updateResult.error.message);
      toast('文章已更新！', 'success');
    } else {
      var insertResult = await sb.from('articles').insert(payload);
      if (insertResult.error) return toast('发布失败: ' + insertResult.error.message);
      toast('发布成功！', 'success');
    }
    cancelEdit();
    loadArticles();
    // 刷新主站文章缓存
    if (typeof window._invalidateArticleCache === 'function') window._invalidateArticleCache();
  }

  // ---- deleteArticle ----
  async function deleteArticle(id) {
    if (!confirm('确定删除这篇文章？')) return;
    if (!sb) return;
    var result = await sb.from('articles').delete().eq('id', id);
    if (result.error) return toast('删除失败');
    toast('已删除', 'success');
    loadArticles();
    if (typeof window._invalidateArticleCache === 'function') window._invalidateArticleCache();
  }

  // ---- publishArticle ----
  async function publishArticle(id) {
    if (!sb) return;
    var result = await sb.from('articles').update({ published: true, updated_at: new Date() }).eq('id', id);
    if (result.error) return toast('发布失败: ' + result.error.message);
    toast('已发布！', 'success');
    loadArticles();
    if (typeof window._invalidateArticleCache === 'function') window._invalidateArticleCache();
  }

  // ---- uploadCover ----
  async function uploadCover() {
    var file = document.getElementById('adminCoverFileInput').files[0];
    if (!file) return;
    toast('上传封面中...');
    try {
      var path = 'covers/' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '');
      var uploadResult = await sb.storage.from('wallpapers').upload(path, file);
      if (uploadResult.error) { toast('上传失败: ' + uploadResult.error.message); return; }
      var urlResult = sb.storage.from('wallpapers').getPublicUrl(path);
      document.getElementById('adminCover').value = urlResult.data.publicUrl;
      toast('封面已上传！', 'success');
    } catch (e) { toast('上传失败'); }
    document.getElementById('adminCoverFileInput').value = '';
  }

  // ---- Markdown preview ----
  var _previewBound = false;
  function renderPreview() {
    var md = document.getElementById('adminContent').value;
    if (md) {
      var html = typeof marked !== 'undefined' ? marked.parse(md) : '';
      document.getElementById('adminPreview').innerHTML = typeof window.sanitizeHtml === 'function' ? window.sanitizeHtml(html) : html;
    } else {
      document.getElementById('adminPreview').innerHTML = '<span style="color:var(--text-dim);">预览区域...</span>';
    }
  }

  // ---- Pending Uploads (审核) ----
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  async function loadPendingItems() {
    if (!sb) return;
    var result = await sb.from('user_files').select('*').eq('published', false).order('created_at', { ascending: false });
    var list = document.getElementById('adminPendingList');
    var countEl = document.getElementById('adminPendingCount');
    var data = result.data || [];

    if (countEl) {
      if (data.length > 0) {
        countEl.textContent = data.length;
        countEl.style.display = '';
      } else {
        countEl.style.display = 'none';
      }
    }

    if (!data.length) {
      list.innerHTML = '<div class="admin-empty">暂无待审核项</div>';
      return;
    }

    list.innerHTML = data.map(function(item) {
      var label = item.category === 'wallpaper' ? '🖼 壁纸' : '🎵 BGM';
      var sizeStr = formatFileSize(item.size || 0);
      var preview = item.category === 'wallpaper' && window.sb
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

  async function approveItem(id) {
    if (!sb) return;
    var result = await sb.from('user_files').update({ published: true, updated_at: new Date() }).eq('id', id);
    if (result.error) { toast('操作失败: ' + result.error.message); return; }
    toast('已通过审核', 'success');
    loadPendingItems();
    if (typeof window._invalidateWallpaperCache === 'function') window._invalidateWallpaperCache();
    if (typeof window._invalidateTrackCache === 'function') window._invalidateTrackCache();
  }

  async function rejectItem(id) {
    if (!sb) return;
    try {
      var result = await sb.from('user_files').select('storage_path,category').eq('id', id).single();
      if (result.data) {
        var bucket = result.data.category === 'bgm' ? 'bgm' : 'wallpapers';
        await sb.storage.from(bucket).remove([result.data.storage_path]);
      }
    } catch (e) { /* storage delete best-effort */ }
    await sb.from('user_files').delete().eq('id', id);
    toast('已拒绝并删除', 'success');
    loadPendingItems();
  }

  // ---- Admin Wallpaper Management ----
  async function loadAdminWallpapers() {
    var list = document.getElementById('adminWallpaperList');
    if (!list) return;

    // Default wallpapers (always visible, not deletable)
    var defaults = (window.DEFAULT_WALLPAPERS || []).map(function(d, i) {
      return { id: 'default_' + i, name: d.name, url: d.path, isDefault: true };
    });

    // Cloud wallpapers (all, including unpublished)
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

    var all = defaults.concat(cloudItems);
    if (!all.length) {
      list.innerHTML = '<div class="admin-empty">暂无壁纸</div>';
      return;
    }

    list.innerHTML = all.map(function(item) {
      var sizeStr = item.size ? formatFileSize(item.size) : '';
      var badge = item.isDefault ? '<span class="admin-badge-rec">内置</span>'
        : (item.published ? '<span class="admin-badge-link">已发布</span>' : '<span class="admin-badge-pending">待审核</span>');
      var preview = !item.isDefault && sb
        ? '<img class="admin-pending-preview" src="' + esc(sb.storage.from('wallpapers').getPublicUrl(item.storage_path).data.publicUrl) + '" alt="">'
        : '<div class="admin-pending-icon" style="background:url(\'' + esc(item.url || '') + '\') center/cover;"></div>';
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

  // ---- Admin Track Management ----
  async function loadAdminTracks() {
    var list = document.getElementById('adminTrackList');
    if (!list) return;

    var defaults = (window.DEFAULT_BGMS || []).map(function(d, i) {
      return { id: 'default_bgm_' + i, name: d.name, isDefault: true };
    });

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
    // Refresh caches so changes propagate to main site
    if (typeof window._invalidateWallpaperCache === 'function') window._invalidateWallpaperCache();
    if (typeof window._invalidateTrackCache === 'function') window._invalidateTrackCache();
  }

  // ---- bindAdminEvents ----
  function bindAdminEvents() {
    // Content textarea → preview
    var contentEl = document.getElementById('adminContent');
    if (contentEl && !_previewBound) {
      _previewBound = true;
      contentEl.addEventListener('input', renderPreview);
    }

    // Save
    var btnSave = document.getElementById('btnAdminSave');
    if (btnSave) btnSave.addEventListener('click', saveArticle);

    // Cancel
    var btnCancel = document.getElementById('btnAdminCancel');
    if (btnCancel) btnCancel.addEventListener('click', cancelEdit);

    // Cover upload
    var btnCover = document.getElementById('btnAdminCoverUpload');
    if (btnCover) btnCover.addEventListener('click', function() {
      document.getElementById('adminCoverFileInput').click();
    });
    var coverInput = document.getElementById('adminCoverFileInput');
    if (coverInput) coverInput.addEventListener('change', uploadCover);

    // Article list + pending review delegation
    var secAdmin = document.getElementById('sec-admin');
    if (secAdmin) {
      secAdmin.addEventListener('click', function(e) {
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
      });
    }

    // News editor buttons
    var btnNewsAdd = document.getElementById('btnAdminNewsAdd');
    if (btnNewsAdd) btnNewsAdd.addEventListener('click', function() { showNewsEditor(null); });
    var btnNewsSave = document.getElementById('btnAdminNewsSave');
    if (btnNewsSave) btnNewsSave.addEventListener('click', saveNews);
    var btnNewsCancel = document.getElementById('btnAdminNewsCancel');
    if (btnNewsCancel) btnNewsCancel.addEventListener('click', hideNewsEditor);

    // Load all admin sections
    loadArticles();
    loadPendingItems();
    loadAdminWallpapers();
    loadAdminTracks();
    loadAdminNews();
  }

  // ---- News management ----
  var _newsEditingId = null;

  async function loadAdminNews() {
    var list = document.getElementById('adminNewsList');
    if (!list) return;

    var newsItems = [];
    if (sb) {
      try {
        var result = await sb.from('anime_news').select('*').order('news_date', { ascending: false }).order('id', { ascending: false });
        newsItems = result.data || [];
      } catch (e) { /* ignore */ }
    }

    if (!newsItems.length) {
      list.innerHTML = '<div class="admin-empty">暂无资讯</div>';
      return;
    }

    list.innerHTML = newsItems.map(function(n) {
      return '<div class="admin-article-item">' +
        '<div>' +
          '<div class="admin-article-title">' + esc(n.title) + ' <span class="admin-badge-link">' + (n.source || '') + '</span></div>' +
          '<div class="admin-article-meta">' + (n.news_date || '') + ' · ' + esc((n.summary || '').slice(0, 60)) + '</div>' +
        '</div>' +
        '<div class="admin-article-actions">' +
          '<button class="admin-btn-edit" data-edit-news="' + n.id + '">编辑</button>' +
          '<button class="admin-btn-delete" data-delete-news="' + n.id + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function showNewsEditor(id) {
    document.getElementById('adminNewsEditor').style.display = '';
    document.getElementById('btnAdminNewsAdd').style.display = 'none';
    document.getElementById('btnAdminNewsSave').textContent = '保存';
    document.getElementById('btnAdminNewsCancel').style.display = '';
    if (id && sb) {
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
      _newsEditingId = null;
      document.getElementById('adminNewsTitle').value = '';
      document.getElementById('adminNewsSummary').value = '';
      document.getElementById('adminNewsContent').value = '';
      document.getElementById('adminNewsSource').value = '';
      document.getElementById('adminNewsUrl').value = '';
      document.getElementById('adminNewsDate').value = new Date().toISOString().slice(0, 10);
    }
  }

  function hideNewsEditor() {
    document.getElementById('adminNewsEditor').style.display = 'none';
    document.getElementById('btnAdminNewsAdd').style.display = '';
    document.getElementById('btnAdminNewsCancel').style.display = 'none';
    _newsEditingId = null;
  }

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
      var r = await sb.from('anime_news').update(payload).eq('id', _newsEditingId);
      if (r.error) return toast('保存失败: ' + r.error.message);
      toast('已更新', 'success');
    } else {
      var r = await sb.from('anime_news').insert(payload);
      if (r.error) return toast('保存失败: ' + r.error.message);
      toast('已添加', 'success');
    }
    hideNewsEditor();
    loadAdminNews();
    if (typeof window._refreshNewsPanel === 'function') window._refreshNewsPanel();
  }

  async function deleteNews(id) {
    if (!sb || !confirm('确定删除？')) return;
    await sb.from('anime_news').delete().eq('id', id);
    toast('已删除', 'success');
    loadAdminNews();
    if (typeof window._refreshNewsPanel === 'function') window._refreshNewsPanel();
  }

  window.bindAdminEvents = bindAdminEvents;
})();
