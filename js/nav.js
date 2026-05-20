// ==================== Navigation ====================
(function() {
  var currentSection = 'home';
  var panelOpen = true;

  var sectionTitles = {
    home: '🏠 首页',
    articles: '📝 文章',
    cloud: '📁 文件',
    submit: '✉️ 投稿',
    settings: '⚙ 设置',
  };

  function switchSection(name) {
    currentSection = name;
    document.querySelectorAll('.panel-section').forEach(function(s) { s.classList.remove('active'); });
    document.getElementById('sec-' + name).classList.add('active');

    document.querySelectorAll('.side-nav-item').forEach(function(n) {
      n.classList.toggle('active', n.dataset.section === name);
    });

    document.getElementById('panelTitle').textContent = sectionTitles[name] || name;
    openPanel();
    document.getElementById('panelBody').scrollTop = 0;
  }

  function openPanel() {
    panelOpen = true;
    document.getElementById('contentPanel').classList.add('open');
  }

  function closePanel() {
    panelOpen = false;
    document.getElementById('contentPanel').classList.remove('open');
    document.querySelectorAll('.side-nav-item').forEach(function(n) { n.classList.remove('active'); });
  }

  function bindNavEvents() {
    document.getElementById('sidebarNav').addEventListener('click', function(e) {
      var nav = e.target.closest('.side-nav-item');
      if (!nav) return;
      var section = nav.dataset.section;
      if (section === currentSection && panelOpen) {
        closePanel();
        return;
      }
      switchSection(section);
    });

    document.getElementById('panelClose').addEventListener('click', closePanel);

    document.addEventListener('click', function(e) {
      if (!panelOpen) return;
      if (window.innerWidth <= 540) return;
      if (e.target.closest('.sidebar') || e.target.closest('.content-panel')) return;
      if (e.target.closest('.modal-overlay:not(.hidden)')) return;
      closePanel();
    });
  }

  window.bindNavEvents = bindNavEvents;
})();
