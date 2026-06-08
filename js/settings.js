// ==================== Settings ====================
(function() {
  var defaultSettings = {
    sakuraEnabled: true,
    cloudVisible: true,
    articlesVisible: true,
    nickname: 'jieneng',
    signature: '这并非对我的束缚，而是我对她的礼仪',
    intro: '这里是jieneng的个人小站。喜欢在深夜推 galgame、听动漫 OST。\n信奉「优雅的文字即诗」，也相信每一部视觉小说都是一个世界。\n欢迎来到我的秘密基地 ✦',
    socialGitHub: '',
    socialQQ: '',
    socialBilibili: '',
    socialEmail: '',
  };

  // Settings cache to reduce localStorage reads
  var _settingsCache = null;
  var _cacheTs = 0;

  function loadSettings() {
    if (_settingsCache && Date.now() - _cacheTs < 5000) return _settingsCache;
    try {
      _settingsCache = JSON.parse(localStorage.getItem('siteSettings')) || {};
      _cacheTs = Date.now();
      return _settingsCache;
    } catch (e) { return {}; }
  }

  function saveSettings(s) {
    _settingsCache = s;
    _cacheTs = Date.now();
    localStorage.setItem('siteSettings', JSON.stringify(s));
  }

  function getSetting(key) {
    var s = loadSettings();
    return s[key] !== undefined ? s[key] : defaultSettings[key];
  }

  function toggleSetting(key) {
    var s = loadSettings();
    s[key] = !getSetting(key);
    saveSettings(s);
    applyAllSettings();
  }

  // ---- Supabase Auth ----
  async function sbLogin(email, password) {
    if (!window.sb) { showToast('服务不可用', 'warn'); return false; }
    showLoading('登录中...');
    var result = await window.sb.auth.signInWithPassword({ email: email, password: password });
    hideLoading();
    if (result.error) {
      var msg = result.error.message === 'Invalid login credentials' ? '邮箱或密码错误' : result.error.message;
      var errEl = document.getElementById('loginError');
      if (errEl) errEl.textContent = msg;
      document.getElementById('loginPassword').value = '';
      return false;
    }
    document.getElementById('loginError').textContent = '';
    document.getElementById('loginPassword').value = '';
    window._isLoggedIn = true;
    showToast('登录成功！', 'success');
    if (typeof window.switchSection === 'function') window.switchSection('home');
    return true;
  }

  async function sbRegister(email, password) {
    if (!window.sb) { showToast('服务不可用', 'warn'); return false; }
    showLoading('注册中...');
    var result = await window.sb.auth.signUp({ email: email, password: password });
    hideLoading();
    if (result.error) {
      var errEl = document.getElementById('loginError');
      if (errEl) errEl.textContent = result.error.message;
      return false;
    }
    showToast('注册成功！已自动登录。', 'success');
    return true;
  }

  async function sbLogout() {
    if (!window.sb) return;
    await window.sb.auth.signOut();
  }

  // ---- 设置云同步 ----
  async function syncSettingsToCloud() {
    if (!window.sb || !window._isLoggedIn) return;
    try {
      var user = await getCachedUser();
      if (!user) return;
      var s = loadSettings();
      await window.sb.from('user_settings').upsert({
        user_id: user.id,
        settings: s,
        updated_at: new Date(),
      }, { onConflict: 'user_id' });
    } catch (e) { /* 静默失败 */ }
  }

  async function syncSettingsFromCloud() {
    if (!window.sb || !window._isLoggedIn) return;
    try {
      var user = await getCachedUser();
      if (!user) return;
      var result = await window.sb.from('user_settings')
        .select('settings')
        .eq('user_id', user.id)
        .limit(1);
      if (result.data && result.data.length > 0 && result.data[0].settings) {
        saveSettings(result.data[0].settings);
        applyAllSettings();
      }
    } catch (e) { /* 保持本地设置 */ }
  }

  function renderSocialLinks() {
    var s = loadSettings();
    var links = [
      { key: 'socialGitHub', icon: '⌨', label: 'GitHub' },
      { key: 'socialQQ', icon: '💬', label: 'QQ' },
      { key: 'socialBilibili', icon: '📺', label: 'Bilibili' },
      { key: 'socialEmail', icon: '✉', label: 'Email' },
    ];
    var container = document.getElementById('socialLinks');
    if (!container) return;
    container.innerHTML = links
      .filter(function(l) {
        var v = (s[l.key] || '').trim();
        return v && !/^\s*(javascript|data|vbscript)\s*:/i.test(v);
      })
      .map(function(l) { return '<a href="' + escHtml(s[l.key]) + '" target="_blank" rel="noopener noreferrer" title="' + l.label + '">' + l.icon + '</a>'; })
      .join('');
  }

  function applyAllSettings() {
    var s = loadSettings();

    // Sakura
    var sakuraEnabledVal = s.sakuraEnabled !== undefined ? s.sakuraEnabled : true;
    window.sakuraEnabled = sakuraEnabledVal;
    var toggleSakura = document.getElementById('toggleSakura');
    if (toggleSakura) toggleSakura.classList.toggle('on', sakuraEnabledVal);
    var c = window._sakuraCanvas;
    if (c) c.style.display = sakuraEnabledVal ? '' : 'none';
    if (sakuraEnabledVal && !window.sakuraAnimId) window.tickSakura();

    // Cloud nav
    var cloudVis = s.cloudVisible !== undefined ? s.cloudVisible : true;
    var toggleCloud = document.getElementById('toggleCloud');
    if (toggleCloud) toggleCloud.classList.toggle('on', cloudVis);
    var cloudNav = document.querySelector('.side-nav-item[data-section="cloud"]');
    if (cloudNav) cloudNav.style.display = cloudVis ? '' : 'none';

    // Articles nav
    var artVis = s.articlesVisible !== undefined ? s.articlesVisible : true;
    var toggleArticles = document.getElementById('toggleArticles');
    if (toggleArticles) toggleArticles.classList.toggle('on', artVis);
    var artNav = document.querySelector('.side-nav-item[data-section="articles"]');
    if (artNav) artNav.style.display = artVis ? '' : 'none';

    // Profile
    document.getElementById('displayName').textContent = s.nickname || defaultSettings.nickname;
    var nickInput = document.getElementById('settingNickname');
    if (nickInput) nickInput.value = s.nickname || defaultSettings.nickname;
    var sigInput = document.getElementById('settingSignature');
    if (sigInput) sigInput.value = s.signature || defaultSettings.signature;
    var sigEl = document.querySelector('.signature');
    if (sigEl) sigEl.textContent = s.signature || defaultSettings.signature;
    var introInput = document.getElementById('settingIntro');
    if (introInput) introInput.value = s.intro || defaultSettings.intro;
    var rawIntro = s.intro || defaultSettings.intro;
    var escaped = rawIntro.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    document.getElementById('introText').innerHTML = escaped.replace(/\n/g, '<br>');

    // Social inputs
    ['GitHub', 'QQ', 'Bilibili', 'Email'].forEach(function(platform) {
      var input = document.getElementById('settingSocial' + platform);
      if (input) input.value = s['social' + platform] || '';
    });

    renderSocialLinks();

    syncSettingsToCloud();
  }

  function resetAllSettings() {
    if (confirm('确定要重置所有设置为默认值吗？')) {
      localStorage.removeItem('siteSettings');
      localStorage.removeItem('wallpaperIdx');
      _settingsCache = null;
      applyAllSettings();
      if (typeof window.applyWallpaper === 'function') window.applyWallpaper(0);
      if (typeof window.renderFileList === 'function') window.renderFileList();
      showToast('已重置所有设置！', 'success');
    }
  }

  // ---- 侧边栏锁按钮 → 登出/登录 toggle ----
  async function handleLockBtnClick() {
    if (!window.sb) return;
    var sessionResult = await window.sb.auth.getSession();
    if (sessionResult.data.session) {
      if (confirm('确定要登出吗？')) {
        await sbLogout();
        location.reload();
      }
    } else {
      if (typeof window.switchSection === 'function') {
        window.switchSection('auth');
      }
    }
  }

  function bindSettingsEvents() {
    // 登录按钮
    var btnLogin = document.getElementById('btnLogin');
    if (btnLogin) {
      btnLogin.addEventListener('click', async function() {
        var email = document.getElementById('loginEmail').value.trim();
        var password = document.getElementById('loginPassword').value;
        if (!email || !password) {
          var errEl = document.getElementById('loginError');
          if (errEl) errEl.textContent = '请填写邮箱和密码';
          return;
        }
        await sbLogin(email, password);
      });
    }

    // 回车登录
    var loginPassword = document.getElementById('loginPassword');
    if (loginPassword) {
      loginPassword.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          var btn = document.getElementById('btnLogin');
          if (btn) btn.click();
        }
      });
    }

    // 密码修改 — 需验证旧密码
    var btnChangePwd = document.getElementById('btnChangePassword');
    if (btnChangePwd) {
      btnChangePwd.addEventListener('click', async function() {
        var oldPwd = document.getElementById('settingOldPassword').value;
        var newPwd = document.getElementById('settingChangePassword').value;
        if (!oldPwd) {
          showToast('请输入旧密码', 'warn');
          return;
        }
        if (!newPwd || newPwd.length < 6) {
          showToast('新密码至少 6 位', 'warn');
          return;
        }
        if (!window.sb) { showToast('服务不可用', 'warn'); return; }
        showLoading('验证旧密码...');
        var userResult = await window.sb.auth.getUser();
        if (!userResult.data.user) {
          hideLoading();
          showToast('请先登录', 'warn');
          return;
        }
        var signInResult = await window.sb.auth.signInWithPassword({
          email: userResult.data.user.email,
          password: oldPwd,
        });
        if (signInResult.error) {
          hideLoading();
          showToast('旧密码不正确', 'error');
          return;
        }
        showLoading('更新密码中...');
        var result = await window.sb.auth.updateUser({ password: newPwd });
        hideLoading();
        if (result.error) {
          showToast('修改失败: ' + result.error.message, 'error');
        } else {
          document.getElementById('settingOldPassword').value = '';
          document.getElementById('settingChangePassword').value = '';
          showToast('密码已更新！', 'success');
        }
      });
    }

    // Profile input bindings
    var nickInput = document.getElementById('settingNickname');
    if (nickInput) {
      nickInput.addEventListener('change', function() {
        var s = loadSettings();
        s.nickname = this.value || defaultSettings.nickname;
        saveSettings(s);
        applyAllSettings();
      });
    }

    var sigInput = document.getElementById('settingSignature');
    if (sigInput) {
      sigInput.addEventListener('change', function() {
        var s = loadSettings();
        s.signature = this.value || defaultSettings.signature;
        saveSettings(s);
        applyAllSettings();
      });
    }

    var introInput = document.getElementById('settingIntro');
    if (introInput) {
      introInput.addEventListener('change', function() {
        var s = loadSettings();
        s.intro = this.value || defaultSettings.intro;
        saveSettings(s);
        applyAllSettings();
      });
    }

    // Social link bindings
    ['settingSocialGitHub', 'settingSocialQQ', 'settingSocialBilibili', 'settingSocialEmail'].forEach(function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function() {
        var s = loadSettings();
        var key = id.replace('settingSocial', 'social');
        s[key] = this.value.trim();
        saveSettings(s);
        renderSocialLinks();
      });
    });

    // Settings toggle buttons (delegated from data-action="toggle")
    var settingsContainer = document.getElementById('sec-settings');
    if (settingsContainer) {
      settingsContainer.addEventListener('click', function(e) {
        var toggle = e.target.closest('[data-action="toggle"]');
        if (toggle) {
          toggleSetting(toggle.getAttribute('data-key'));
        }
      });
    }

    // 云端迁移按钮
    var btnMigrate = document.getElementById('btnMigrateToCloud');
    if (btnMigrate) {
      btnMigrate.addEventListener('click', function() {
        if (typeof window.migrateLocalToCloud === 'function') window.migrateLocalToCloud();
      });
    }

    // 清空网盘文件按钮
    var btnClear = document.getElementById('btnClearCloudData');
    if (btnClear) {
      btnClear.addEventListener('click', function() {
        if (typeof window.clearCloudData === 'function') window.clearCloudData();
      });
    }

    // 重置所有设置按钮
    var btnReset = document.getElementById('btnResetAllSettings');
    if (btnReset) {
      btnReset.addEventListener('click', function() {
        if (typeof window.resetAllSettings === 'function') window.resetAllSettings();
      });
    }
  }

  window.defaultSettings = defaultSettings;
  window.loadSettings = loadSettings;
  window.saveSettings = saveSettings;
  window.getSetting = getSetting;
  window.toggleSetting = toggleSetting;
  window.applyAllSettings = applyAllSettings;
  window.resetAllSettings = resetAllSettings;
  window.bindSettingsEvents = bindSettingsEvents;
  window.handleLockBtnClick = handleLockBtnClick;
  window.syncSettingsFromCloud = syncSettingsFromCloud;
})();
