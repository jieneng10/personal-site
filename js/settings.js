// ==================== Settings ====================
const defaultSettings = {
  sakuraEnabled: true,
  cloudVisible: true,
  articlesVisible: true,
  nickname: 'jieneng',
  signature: '这里是jieneng的个人小站，推 galgame、听动漫 OST。\n信奉「优雅的文字即诗」，也相信每一部视觉小说都是一个世界。',
  intro: '这里是jieneng的个人小站。喜欢在深夜推 galgame、听动漫 OST。\n信奉「优雅的文字即诗」，也相信每一部视觉小说都是一个世界。\n欢迎来到我的秘密基地 ✦',
  socialGitHub: '',
  socialQQ: '',
  socialBilibili: '',
  socialEmail: '',
};

function loadSettings() {
  try { return JSON.parse(localStorage.getItem('siteSettings')) || {}; }
  catch { return {}; }
}

function saveSettings(s) { localStorage.setItem('siteSettings', JSON.stringify(s)); }

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
  if (!sb) { alert('服务不可用'); return false; }
  showLoading('登录中...');
  var result = await sb.auth.signInWithPassword({ email: email, password: password });
  hideLoading();
  if (result.error) {
    var msg = result.error.message === 'Invalid login credentials' ? '邮箱或密码错误' : result.error.message;
    document.getElementById('lockError').textContent = msg;
    return false;
  }
  return true;
}

async function sbRegister(email, password) {
  if (!sb) { alert('服务不可用'); return false; }
  showLoading('注册中...');
  var result = await sb.auth.signUp({ email: email, password: password });
  hideLoading();
  if (result.error) {
    document.getElementById('lockError').textContent = result.error.message;
    return false;
  }
  alert('注册成功！已自动登录。');
  return true;
}

async function sbLogout() {
  if (!sb) return;
  await sb.auth.signOut();
}

// ---- 设置云同步 ----
async function syncSettingsToCloud() {
  if (!sb || !_isLoggedIn) return;
  try {
    var userResult = await sb.auth.getUser();
    var user = userResult.data.user;
    if (!user) return;
    var s = loadSettings();
    await sb.from('user_settings').upsert({
      user_id: user.id,
      settings: s,
      updated_at: new Date(),
    });
  } catch (e) { /* 静默失败 */ }
}

async function syncSettingsFromCloud() {
  if (!sb) return;
  try {
    var userResult = await sb.auth.getUser();
    var user = userResult.data.user;
    if (!user) return;
    var result = await sb.from('user_settings')
      .select('settings')
      .eq('user_id', user.id)
      .single();
    if (result.data && result.data.settings) {
      saveSettings(result.data.settings);
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
    .filter(function(l) { return (s[l.key] || '').trim(); })
    .map(function(l) { return '<a href="' + s[l.key] + '" target="_blank" rel="noopener" title="' + l.label + '">' + l.icon + '</a>'; })
    .join('');
}

function applyAllSettings() {
  var s = loadSettings();

  // Sakura
  sakuraEnabled = s.sakuraEnabled !== undefined ? s.sakuraEnabled : true;
  var toggleSakura = document.getElementById('toggleSakura');
  if (toggleSakura) toggleSakura.classList.toggle('on', sakuraEnabled);
  if (sakuraCanvas) sakuraCanvas.style.display = sakuraEnabled ? '' : 'none';
  if (sakuraEnabled && !sakuraAnimId) tickSakura();

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

  // 每次设置变更自动推送到云端
  syncSettingsToCloud();
}

function resetAllSettings() {
  if (confirm('确定要重置所有设置为默认值吗？')) {
    localStorage.removeItem('siteSettings');
    localStorage.removeItem('wallpaperIdx');
    applyAllSettings();
    if (typeof applyWallpaper === 'function') applyWallpaper(0);
    if (typeof renderFileList === 'function') renderFileList();
    alert('已重置所有设置！');
  }
}

// ---- 侧边栏锁按钮 → 登出/登录 toggle ----
async function handleLockBtnClick() {
  if (!sb) return;
  var sessionResult = await sb.auth.getSession();
  if (sessionResult.data.session) {
    if (confirm('确定要登出吗？')) {
      await sbLogout();
      location.reload();
    }
  } else {
    document.getElementById('lockOverlay').classList.remove('hidden');
    var emailInput = document.getElementById('loginEmail');
    if (emailInput) emailInput.focus();
  }
}

// ---- Event bindings ----
function bindSettingsEvents() {
  // 登录按钮
  var btnLogin = document.getElementById('btnLogin');
  if (btnLogin) {
    btnLogin.addEventListener('click', async function() {
      var email = document.getElementById('loginEmail').value.trim();
      var password = document.getElementById('loginPassword').value;
      if (!email || !password) {
        document.getElementById('lockError').textContent = '请填写邮箱和密码';
        return;
      }
      await sbLogin(email, password);
    });
  }

  // 注册按钮
  var btnRegister = document.getElementById('btnRegister');
  if (btnRegister) {
    btnRegister.addEventListener('click', async function() {
      var email = document.getElementById('loginEmail').value.trim();
      var password = document.getElementById('loginPassword').value;
      if (!email || !password) {
        document.getElementById('lockError').textContent = '请填写邮箱和密码';
        return;
      }
      if (password.length < 6) {
        document.getElementById('lockError').textContent = '密码至少 6 位';
        return;
      }
      await sbRegister(email, password);
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

  // 密码修改
  var btnChangePwd = document.getElementById('btnChangePassword');
  if (btnChangePwd) {
    btnChangePwd.addEventListener('click', async function() {
      var input = document.getElementById('settingChangePassword');
      var newPwd = input.value;
      if (!newPwd || newPwd.length < 6) {
        alert('密码至少 6 位');
        return;
      }
      if (!sb) { alert('服务不可用'); return; }
      showLoading('更新密码中...');
      var result = await sb.auth.updateUser({ password: newPwd });
      hideLoading();
      if (result.error) {
        alert('修改失败: ' + result.error.message);
      } else {
        input.value = '';
        alert('密码已更新！');
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
}
