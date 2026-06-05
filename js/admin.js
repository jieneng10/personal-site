// ==================== Admin Article Manager ====================
(function() {
  var sb = window.sb;
  var editingId = null;

  // 使用 supabase.js 中的通用工具
  var toast = window.showToast || function(msg, type) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.style.display = '';
    clearTimeout(el._t); el._t = setTimeout(function() { el.style.display = 'none'; }, 2000);
  };
  var escHtml = window.escHtml || function(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
  };

  async function verifyAdmin() {
    try {
      var userResult = await sb.auth.getUser();
      if (!userResult.data.user) return false;
      var adminResult = await sb.from('admins').select('user_id').eq('user_id', userResult.data.user.id).single();
      return !!adminResult.data;
    } catch (e) { return false; }
  }

  async function login() {
    var result = await sb.auth.signInWithPassword({
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
    });
    if (result.error) return toast('登录失败: ' + result.error.message);

    var isAdmin = await verifyAdmin();
    if (!isAdmin) {
      var userResult = await sb.auth.getUser();
      var uid = userResult.data.user ? userResult.data.user.id : 'YOUR_USER_ID';
      toast('你不是管理员！请在 Supabase SQL Editor 中执行: INSERT INTO admins VALUES (\'' + uid + '\');');
      await sb.auth.signOut();
      return;
    }
    document.getElementById('loginBox').style.display = 'none';
    document.getElementById('editor').style.display = 'block';
    loadArticles();
  }

  async function logout() { await sb.auth.signOut(); location.reload(); }

  async function loadArticles() {
    var result = await sb.from('articles').select('*').order('created_at', { ascending: false });
    var list = document.getElementById('articleList');
    var data = result.data || [];
    if (!data.length) {
      list.innerHTML = '<div class="empty">还没有文章，写一篇吧 ✦</div>';
      return;
    }
    list.innerHTML = data.map(function(a) {
      var badges = [];
      if (!a.published) badges.push('<span style="color:#ff6060;">[待审核]</span>');
      if (a.recommended) badges.push('<span style="color:#f0c040;">⭐推荐</span>');
      if (a.url) badges.push('<span style="color:#70c0ff;">🔗外链</span>');
      return '<div class="article-item">' +
        '<div>' +
          '<div class="title">' + escHtml(a.title) + ' ' + badges.join(' ') + '</div>' +
          '<div class="meta">' + (a.created_at || '').slice(0, 10) + ' · ' + escHtml((a.tags || []).join(', ')) + '</div>' +
        '</div>' +
        '<div class="actions">' +
          (!a.published ? '<button onclick="window._publishArticle(' + a.id + ')" style="background:#7c3aed;color:#fff;border:none;">发布</button>' : '') +
          '<button onclick="window._editArticle(' + a.id + ')" style="background:transparent;border:1px solid #555;color:var(--dim);">编辑</button>' +
          '<button class="danger" onclick="window._deleteArticle(' + a.id + ')">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function editArticle(id) {
    sb.from('articles').select('*').eq('id', id).single().then(function(result) {
      var data = result.data;
      if (!data) return;
      document.getElementById('editorTitle').textContent = '编辑文章';
      document.getElementById('title').value = data.title;
      document.getElementById('slug').value = data.slug || '';
      document.getElementById('tags').value = (data.tags || []).join(', ');
      document.getElementById('url').value = data.url || '';
      document.getElementById('cover').value = data.cover || '';
      document.getElementById('excerpt').value = data.excerpt || '';
      document.getElementById('content').value = data.content || '';
      document.getElementById('published').checked = data.published;
      document.getElementById('recommended').checked = data.recommended || false;
      document.getElementById('spoiler').checked = data.spoiler || false;
      document.getElementById('btnSave').textContent = '保存修改';
      document.getElementById('btnCancel').style.display = '';
      editingId = data.id;
      renderPreview();
    });
  }

  function cancelEdit() {
    editingId = null;
    document.getElementById('editorTitle').textContent = '新建文章';
    document.getElementById('title').value = '';
    document.getElementById('slug').value = '';
    document.getElementById('tags').value = '';
    document.getElementById('url').value = '';
    document.getElementById('cover').value = '';
    document.getElementById('excerpt').value = '';
    document.getElementById('content').value = '';
    document.getElementById('published').checked = true;
    document.getElementById('recommended').checked = false;
    document.getElementById('spoiler').checked = false;
    document.getElementById('btnSave').textContent = '发布';
    document.getElementById('btnCancel').style.display = 'none';
    document.getElementById('preview').innerHTML = '';
  }

  async function saveArticle() {
    var title = document.getElementById('title').value.trim();
    var content = document.getElementById('content').value.trim();
    if (!title) return toast('标题不能为空');
    if (!content) return toast('正文不能为空');

    var tags = document.getElementById('tags').value.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
    var slug = document.getElementById('slug').value.trim()
      || title.toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '').slice(0, 50);
    var published = document.getElementById('published').checked;

    var payload = {
      title: title, slug: slug,
      url: document.getElementById('url').value.trim() || null,
      cover: document.getElementById('cover').value.trim() || null,
      excerpt: document.getElementById('excerpt').value.trim(),
      content: content, tags: tags,
      published: published,
      recommended: document.getElementById('recommended').checked,
      spoiler: document.getElementById('spoiler').checked,
      updated_at: new Date(),
    };

    if (editingId) {
      var updateResult = await sb.from('articles').update(payload).eq('id', editingId);
      if (updateResult.error) return toast('保存失败: ' + updateResult.error.message);
      toast('文章已更新！');
    } else {
      var insertResult = await sb.from('articles').insert(payload);
      if (insertResult.error) return toast('发布失败: ' + insertResult.error.message);
      toast('发布成功！');
    }
    cancelEdit();
    loadArticles();
  }

  async function deleteArticle(id) {
    if (!confirm('确定删除这篇文章？')) return;
    var result = await sb.from('articles').delete().eq('id', id);
    if (result.error) return toast('删除失败');
    toast('已删除');
    loadArticles();
  }

  async function uploadCover() {
    var file = document.getElementById('coverFileInput').files[0];
    if (!file) return;
    toast('上传封面中...');
    try {
      var path = 'covers/' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '');
      var uploadResult = await sb.storage.from('wallpapers').upload(path, file);
      if (uploadResult.error) { toast('上传失败: ' + uploadResult.error.message); return; }
      var urlResult = sb.storage.from('wallpapers').getPublicUrl(path);
      document.getElementById('cover').value = urlResult.data.publicUrl;
      toast('封面已上传！');
    } catch (e) { toast('上传失败'); }
    document.getElementById('coverFileInput').value = '';
  }

  async function publishArticle(id) {
    var result = await sb.from('articles').update({ published: true, updated_at: new Date() }).eq('id', id);
    if (result.error) return toast('发布失败: ' + result.error.message);
    toast('已发布！');
    loadArticles();
  }

  // Markdown 预览
  document.getElementById('content').addEventListener('input', renderPreview);
  function renderPreview() {
    var md = document.getElementById('content').value;
    if (md) {
      var html = marked.parse(md);
      document.getElementById('preview').innerHTML = sanitizePreview(html);
    } else {
      document.getElementById('preview').innerHTML = '<span style="color:var(--dim);">预览区域...</span>';
    }
  }

  function sanitizePreview(html) {
    try {
      var doc = new DOMParser().parseFromString(String(html), 'text/html');
      walkSanitizePreview(doc.body);
      return doc.body.innerHTML;
    } catch (e) { return String(html).replace(/<[^>]*>/g, ''); }
  }
  var BLOCKED_TAGS = { script:1, iframe:1, object:1, embed:1, applet:1, link:1, style:1,
    meta:1, base:1, form:1, input:1, textarea:1, button:1, select:1, option:1 };
  function walkSanitizePreview(node) {
    if (node.nodeType === 3) return;
    if (node.nodeType !== 1) { node.parentNode && node.parentNode.removeChild(node); return; }
    var tag = node.tagName.toLowerCase();
    if (BLOCKED_TAGS[tag]) { node.parentNode && node.parentNode.removeChild(node); return; }
    var attrs = node.attributes;
    if (attrs) {
      for (var i = attrs.length - 1; i >= 0; i--) {
        var an = attrs[i].name.toLowerCase();
        if (/^on\w+/.test(an)) { node.removeAttribute(an); continue; }
        var av = attrs[i].value || '';
        if (/^\s*javascript\s*:/i.test(av)) { node.removeAttribute(an); continue; }
        if ((an === 'href' || an === 'src' || an === 'action' || an === 'formaction')
            && /^\s*javascript\s*:/i.test(av)) {
          node.removeAttribute(an);
        }
      }
    }
    var kids = Array.prototype.slice.call(node.childNodes);
    for (var j = 0; j < kids.length; j++) { walkSanitizePreview(kids[j]); }
  }

  // 回车登录
  document.getElementById('password').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') login();
  });

  // 检查已有 session — 必须通过管理员验证
  (async function() {
    var sessionResult = await sb.auth.getSession();
    if (sessionResult.data.session) {
      var isAdmin = await verifyAdmin();
      if (!isAdmin) {
        await sb.auth.signOut();
        return;
      }
      document.getElementById('loginBox').style.display = 'none';
      document.getElementById('editor').style.display = 'block';
      loadArticles();
    }
  })();

  // Expose for HTML onclick handlers
  window.login = login;
  window.logout = logout;
  window.saveArticle = saveArticle;
  window.cancelEdit = cancelEdit;
  window.uploadCover = uploadCover;
  window._editArticle = editArticle;
  window._deleteArticle = deleteArticle;
  window._publishArticle = publishArticle;
  window.loadArticles = loadArticles;
})();
