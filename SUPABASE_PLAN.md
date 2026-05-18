# Supabase 后端集成方案（修订版）

## 一、架构变化

```
改造前:                                改造后:
┌─────────────────────┐                ┌─────────────────────┐
│  GitHub Pages       │                │  GitHub Pages       │
│  ┌───────────────┐  │                │  ┌───────────────┐  │
│  │ index.html    │  │                │  │ index.html    │  │
│  │ css/*.css     │  │                │  │ css/*.css     │  │
│  │ js/*.js       │  │                │  │ js/*.js       │  │
│  │               │  │                │  │ js/supabase.js│  │ ← 新增
│  │ IndexedDB     │  │  存储          │  │               │  │
│  │ localStorage  │  │  设置          │  └───────┬───────┘  │
│  │ 硬编码数组    │  │  文章          │          │ HTTP      │
│  └───────────────┘  │                │  ┌───────▼───────┐  │
│  密码 = 假锁        │  认证          │  │   Supabase    │  │
│  换设备 = 全丢      │  跨设备        │  │  ┌─────────┐  │  │
└─────────────────────┘                │  │  │ Auth    │  │  │
                                       │  │  │ Storage │  │  │
                                       │  │  │ Database│  │  │
                                       │  │  └─────────┘  │  │
                                       │  └───────────────┘  │
                                       │  免费额度:           │
                                       │  500MB DB + 1GB 文件 │
                                       │  5万 MAU            │
                                       └─────────────────────┘
```

---

## 二、准备工作（一次性）

### 2.1 注册 Supabase

1. 访问 https://supabase.com → Sign in with GitHub
2. New Project → 填入:
   - Name: `personal-site`
   - Database Password: 生成一个强密码并记下来
   - Region: `Northeast Asia (Tokyo)` — 离中国最近
3. 等待 2 分钟初始化完成

### 2.2 获取密钥

Project Dashboard → Settings → API:
```
Project URL: https://xxxxxxxxxxxx.supabase.co
anon public key: eyJhbGciOi...  (公开, 放前端)
service_role key: eyJhbGciOi... (私密, 绝不放前端!)
```

### 2.3 关闭邮箱验证（个人站不需要）

Dashboard → Authentication → Settings:
- **Disable email confirmations** → ON
- 注册后直接登录，不需要查收邮件

### 2.4 引入 SDK

在 `index.html` 的 `</body>` 前加入:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2" defer></script>
<script src="js/supabase.js" defer></script>
<!-- 原有 script 标签全部加 defer -->
<script src="js/db.js" defer></script>
...
```

---

## 三、数据库设计

在 Supabase Dashboard → SQL Editor 执行:

```sql
-- ==================== 扩展 ====================
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- 提供 gen_random_uuid()

-- ==================== 枚举 ====================
CREATE TYPE file_category AS ENUM ('wallpaper', 'bgm', 'cloud');

-- ==================== 管理员表 ====================
-- 替代直接查 auth.users（auth.users 不暴露给 anon key）
CREATE TABLE admins (
  user_id   uuid REFERENCES auth.users PRIMARY KEY
);
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read admins" ON admins FOR SELECT USING (true);

-- 部署后手动插入你的 user_id:
-- INSERT INTO admins VALUES ('your-user-id-after-registration');

-- ==================== 用户设置表 ====================
CREATE TABLE user_settings (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid REFERENCES auth.users NOT NULL UNIQUE,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz DEFAULT now()
);
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own settings"
  ON user_settings FOR ALL
  USING (auth.uid() = user_id);

-- ==================== 文章表 ====================
CREATE TABLE articles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text UNIQUE,                     -- URL 友好的标识符
  title       text NOT NULL,
  excerpt     text,
  content     text,
  tags        text[] DEFAULT '{}',
  published   boolean DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read published articles"
  ON articles FOR SELECT
  USING (published = true);

-- 用 admins 表判断权限，不直接查 auth.users
CREATE POLICY "Admins can manage articles"
  ON articles FOR ALL
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

-- ==================== 用户文件表（合并三表） ====================
-- 替代: cloud_files + bgm_tracks + custom_wallpapers 三个重复表
CREATE TABLE user_files (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid REFERENCES auth.users NOT NULL,
  category      file_category NOT NULL,
  name          text NOT NULL,
  size          bigint,
  mime_type     text,
  storage_path  text NOT NULL,
  created_at    timestamptz DEFAULT now()
);
ALTER TABLE user_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own files"
  ON user_files FOR ALL
  USING (auth.uid() = user_id);

-- ==================== 头像表 ====================
CREATE TABLE avatars (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid REFERENCES auth.users NOT NULL UNIQUE,
  storage_path  text NOT NULL,
  updated_at    timestamptz DEFAULT now()
);
ALTER TABLE avatars ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own avatar"
  ON avatars FOR ALL
  USING (auth.uid() = user_id);
```

### 3.2 Storage Bucket 创建

Dashboard → Storage → New Bucket:

| Bucket 名称 | 用途 | 公开访问 | 下载方式 |
|-------------|------|----------|----------|
| `wallpapers` | 自定义壁纸 | ✓ public | `getPublicUrl()` |
| `avatars` | 头像 | ✓ public | `getPublicUrl()` |
| `bgm` | BGM 音频 | ✓ public | `getPublicUrl()` |
| `files` | 网盘文件 | ✗ private | `createSignedUrl()` |

每个 bucket → Policies 标签:

```sql
-- wallpapers / avatars / bgm: 任何人可读
CREATE POLICY "Public read" ON storage.objects
  FOR SELECT USING (bucket_id IN ('wallpapers', 'avatars', 'bgm'));

-- 所有 bucket: 登录用户可上传
CREATE POLICY "Auth users can upload" ON storage.objects
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- 所有 bucket: 拥有者可删除
CREATE POLICY "Users can delete own files" ON storage.objects
  FOR DELETE USING (auth.uid() = owner);
```

---

## 四、代码迁移

### 4.1 新增 `js/supabase.js` — 统一入口

```javascript
// ==================== Supabase Client ====================
const SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOi...';

// 只有在 SDK 加载后才初始化（应对 CDN 加载失败）
if (typeof supabase !== 'undefined') {
  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
  console.warn('Supabase SDK 加载失败，使用离线模式');
  var sb = null;
}

// ---- Helper: 生成唯一存储路径 ----
function sbStoragePath(userId, category, fileName) {
  const ext = fileName.split('.').pop();
  const uuid = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  return `${userId}/${category}/${uuid}.${ext}`;
}

// ---- Helper: 上传文件到 Storage ----
async function sbUpload(bucket, file, path) {
  if (!sb) throw new Error('Supabase unavailable');
  const { data, error } = await sb.storage
    .from(bucket)
    .upload(path, file, { upsert: false });
  if (error) throw error;
  return data.path;
}

// ---- Helper: 获取公开 URL (public bucket) ----
function sbPublicUrl(bucket, path) {
  if (!sb) return null;
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

// ---- Helper: 获取签名 URL (private bucket, 60秒有效) ----
async function sbSignedUrl(bucket, path, expiresIn = 60) {
  if (!sb) return null;
  const { data } = await sb.storage.from(bucket).createSignedUrl(path, expiresIn);
  return data?.signedUrl;
}

// ---- Helper: 删除文件 ----
async function sbDelete(bucket, paths) {
  if (!sb) throw new Error('Supabase unavailable');
  if (!paths || paths.length === 0) return;
  const { error } = await sb.storage.from(bucket).remove([].concat(paths));
  if (error) throw error;
}

// ---- Auth 状态监听 ----
if (sb) {
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') {
      document.getElementById('lockOverlay').classList.add('hidden');
      syncSettingsFromCloud();
    }
    if (event === 'SIGNED_OUT') {
      document.getElementById('lockOverlay').classList.remove('hidden');
    }
  });
}

// ---- Loading toast ----
let _loadingToast = null;
function showLoading(msg) {
  if (!_loadingToast) {
    _loadingToast = document.createElement('div');
    _loadingToast.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999;'
      + 'background:var(--dialog-bg);border:1px solid var(--dialog-border);border-radius:20px;'
      + 'padding:10px 24px;color:var(--accent);font-size:13px;backdrop-filter:blur(12px);';
    document.body.appendChild(_loadingToast);
  }
  _loadingToast.textContent = msg;
  _loadingToast.style.display = '';
}
function hideLoading() {
  if (_loadingToast) _loadingToast.style.display = 'none';
}
```

### 4.2 改造 `js/settings.js` — 密码 → 真登录

```javascript
// ---- 删除的函数 ----
// hashPassword(), showLock()
// defaultSettings 中删除 lockPassword 字段

// ---- 新增/替换的函数 ----

async function sbLogin(email, password) {
  if (!sb) { alert('服务不可用'); return false; }
  showLoading('登录中...');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  hideLoading();
  if (error) {
    document.getElementById('lockError').textContent =
      error.message === 'Invalid login credentials' ? '邮箱或密码错误' : error.message;
    return false;
  }
  return true;
}

async function sbRegister(email, password) {
  if (!sb) { alert('服务不可用'); return false; }
  showLoading('注册中...');
  const { error } = await sb.auth.signUp({ email, password });
  hideLoading();
  if (error) {
    document.getElementById('lockError').textContent = error.message;
    return false;
  }
  alert('注册成功！已自动登录。');
  return true;
}

async function sbLogout() {
  if (!sb) return;
  await sb.auth.signOut();
}

// 设置云同步 —— 每次设置变更时自动调用
async function syncSettingsToCloud() {
  if (!sb) return;
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const s = loadSettings();
    await sb.from('user_settings').upsert({
      user_id: user.id,
      settings: s,
      updated_at: new Date(),
    });
  } catch (e) { /* 静默失败，本地设置不受影响 */ }
}

async function syncSettingsFromCloud() {
  if (!sb) return;
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb.from('user_settings')
      .select('settings')
      .eq('user_id', user.id)
      .single();
    if (data?.settings) {
      saveSettings(data.settings);
      applyAllSettings();
    }
  } catch (e) { /* 保持本地设置 */ }
}

// applyAllSettings 末尾加入自动同步
function applyAllSettings() {
  const s = loadSettings();

  // Sakura
  sakuraEnabled = s.sakuraEnabled !== undefined ? s.sakuraEnabled : true;
  const toggleSakura = document.getElementById('toggleSakura');
  if (toggleSakura) toggleSakura.classList.toggle('on', sakuraEnabled);
  if (sakuraCanvas) sakuraCanvas.style.display = sakuraEnabled ? '' : 'none';
  if (sakuraEnabled && !sakuraAnimId) tickSakura();

  // Cloud nav
  const cloudVis = s.cloudVisible !== undefined ? s.cloudVisible : true;
  const toggleCloud = document.getElementById('toggleCloud');
  if (toggleCloud) toggleCloud.classList.toggle('on', cloudVis);
  const cloudNav = document.querySelector('.side-nav-item[data-section="cloud"]');
  if (cloudNav) cloudNav.style.display = cloudVis ? '' : 'none';

  // Articles nav
  const artVis = s.articlesVisible !== undefined ? s.articlesVisible : true;
  const toggleArticles = document.getElementById('toggleArticles');
  if (toggleArticles) toggleArticles.classList.toggle('on', artVis);
  const artNav = document.querySelector('.side-nav-item[data-section="articles"]');
  if (artNav) artNav.style.display = artVis ? '' : 'none';

  // Profile
  document.getElementById('displayName').textContent = s.nickname || defaultSettings.nickname;
  const nickInput = document.getElementById('settingNickname');
  if (nickInput) nickInput.value = s.nickname || defaultSettings.nickname;
  const sigInput = document.getElementById('settingSignature');
  if (sigInput) sigInput.value = s.signature || defaultSettings.signature;
  const sigEl = document.querySelector('.signature');
  if (sigEl) sigEl.textContent = s.signature || defaultSettings.signature;
  const introInput = document.getElementById('settingIntro');
  if (introInput) introInput.value = s.intro || defaultSettings.intro;
  const rawIntro = s.intro || defaultSettings.intro;
  const escaped = rawIntro.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  document.getElementById('introText').innerHTML = escaped.replace(/\n/g, '<br>');

  // Social inputs
  ['GitHub', 'QQ', 'Bilibili', 'Email'].forEach(platform => {
    const input = document.getElementById('settingSocial' + platform);
    if (input) input.value = s['social' + platform] || '';
  });

  renderSocialLinks();

  // ★ 每次设置变更自动推送到云端
  syncSettingsToCloud();
}

// 登出/登录 toggle 按钮逻辑
async function handleLockBtnClick() {
  if (!sb) return;
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    if (confirm('确定要登出吗？')) {
      await sbLogout();
      lockDismissedThisSession = false;
      settingsUnlocked = false;
      location.reload();
    }
  } else {
    lockDismissedThisSession = false;
    document.getElementById('lockOverlay').classList.remove('hidden');
    document.getElementById('lockInput')?.focus();
  }
}
```

**lock overlay HTML 改为登录表单:**

```html
<div class="lock-overlay" id="lockOverlay">
  <div class="lock-box">
    <h2 id="lockTitle">✦ 登录 ✦</h2>
    <p id="lockSubtitle">登录后解锁云同步和文件上传</p>
    <input type="email" class="lock-input" id="loginEmail"
           placeholder="邮箱" style="margin-bottom:8px; width:220px;">
    <input type="password" class="lock-input" id="loginPassword"
           placeholder="密码" style="margin-bottom:8px; width:220px;">
    <div class="lock-error" id="lockError"></div>
    <div style="margin-top:12px; display:flex; gap:8px; justify-content:center;">
      <button id="btnLogin" style="padding:8px 24px; border-radius:10px;
        background:var(--accent); color:#fff; border:none; cursor:pointer;">登录</button>
      <button id="btnRegister" style="padding:8px 24px; border-radius:10px;
        background:transparent; color:var(--text-dim); border:1px solid var(--card-border);
        cursor:pointer;">注册</button>
    </div>
  </div>
</div>
```

**登录/注册按钮的 event binding 在 `bindSettingsEvents` 中:**

```javascript
function bindSettingsEvents() {
  document.getElementById('btnLogin').addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) {
      document.getElementById('lockError').textContent = '请填写邮箱和密码';
      return;
    }
    await sbLogin(email, password);
  });

  document.getElementById('btnRegister').addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
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

  // 回车登录
  document.getElementById('loginPassword').addEventListener('keydown', async function(e) {
    if (e.key === 'Enter') {
      document.getElementById('btnLogin').click();
    }
  });

  // ... 其他 setting input 绑定保持不变
}
```

### 4.3 改造 `js/wallpaper.js` — IndexedDB → Storage

```javascript
// ---- 删除的函数 ----
// loadCustomWallpapers, saveCustomWallpaper, deleteCustomWallpaper
// loadAvatar, saveAvatar (旧版)

// ---- 壁纸查询（修复: 未登录早返回）----
const _wallpaperCache = { ts: 0, items: null };

async function getAllWallpapers() {
  const defaults = DEFAULT_WALLPAPERS.map((d, i) => ({
    id: 'default_' + i,
    name: d.name,
    value: `url(${d.path})`,
    isDefault: true,
  }));

  if (!sb) return defaults;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return defaults;  // ★ 未登录不查数据库

  // 30 秒缓存，避免 init() 中重复请求
  if (_wallpaperCache.items && Date.now() - _wallpaperCache.ts < 30000) {
    return _wallpaperCache.items;
  }

  const { data: customs } = await sb
    .from('user_files')
    .select('*')
    .eq('user_id', user.id)
    .eq('category', 'wallpaper')
    .order('created_at');

  const customItems = (customs || []).map(c => ({
    id: c.id,
    name: c.name,
    value: `url(${sbPublicUrl('wallpapers', c.storage_path)})`,
  }));

  _wallpaperCache.items = [...defaults, ...customItems];
  _wallpaperCache.ts = Date.now();
  return _wallpaperCache.items;
}

// ---- 上传壁纸（修复: 计数 + UUID 路径）----
async function addCustomWallpapers(fileList) {
  if (!sb) return;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  const items = await getAllWallpapers();
  let uploaded = 0;

  showLoading('上传壁纸中...');
  try {
    for (const file of fileList) {
      if (!file.type.startsWith('image/')) continue;
      const path = sbStoragePath(user.id, 'wallpaper', file.name);
      await sbUpload('wallpapers', file, path);
      await sb.from('user_files').insert({
        user_id: user.id,
        category: 'wallpaper',
        name: file.name,
        size: file.size,
        mime_type: file.type,
        storage_path: path,
      });
      uploaded++;
    }
  } finally {
    hideLoading();
  }

  if (uploaded > 0) {
    _wallpaperCache.items = null;  // 刷新缓存
    currentWallpaper = items.length + uploaded - 1;
    localStorage.setItem('wallpaperIdx', currentWallpaper);
    applyWallpaper(currentWallpaper);
  }
}

// ---- 删除壁纸 ----
async function removeCustomWallpaper(id) {
  if (!sb) return;
  const { data } = await sb.from('user_files')
    .select('storage_path').eq('id', id).single();
  if (data) {
    await sbDelete('wallpapers', data.storage_path);
    await sb.from('user_files').delete().eq('id', id);
  }
  _wallpaperCache.items = null;
  // index adjustment logic unchanged
  const items = await getAllWallpapers();
  const idx = items.findIndex(w => w.id === id);
  if (idx === currentWallpaper) {
    currentWallpaper = Math.max(0, idx - 1);
  } else if (idx < currentWallpaper) {
    currentWallpaper--;
  }
  localStorage.setItem('wallpaperIdx', currentWallpaper);
  applyWallpaper(currentWallpaper);
}

// ---- 头像（修复: 未登录早返回）----
async function applyAvatar() {
  const avatarEl = document.getElementById('avatarDisplay');
  if (!sb) {
    avatarEl.style.backgroundImage = 'url(images/default-avatar.png)';
    avatarEl.textContent = '';
    return;
  }

  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    avatarEl.style.backgroundImage = 'url(images/default-avatar.png)';
    avatarEl.textContent = '';
    return;
  }

  const { data } = await sb.from('avatars')
    .select('storage_path').eq('user_id', user.id).single();
  if (data) {
    avatarEl.style.backgroundImage = `url(${sbPublicUrl('avatars', data.storage_path)})`;
  } else {
    avatarEl.style.backgroundImage = 'url(images/default-avatar.png)';
  }
  avatarEl.textContent = '';
}

// 头像上传
async function saveAvatar(file) {
  if (!sb) return;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  showLoading('上传头像中...');
  try {
    const path = sbStoragePath(user.id, 'avatar', file.name);
    await sbUpload('avatars', file, path);
    await sb.from('avatars').upsert({
      user_id: user.id,
      storage_path: path,
      updated_at: new Date(),
    });
  } finally {
    hideLoading();
  }
  applyAvatar();
}
```

### 4.4 改造 `js/bgm.js`

```javascript
// ---- 删除的函数 ----
// getAllTracks (旧版), handleBGMFiles (IndexedDB部分), deleteBGMById (旧版)

const _trackCache = { ts: 0, items: null };

async function getAllTracks() {
  const defaults = [{
    id: 'default_bgm',
    name: DEFAULT_BGM.name,
    path: DEFAULT_BGM.path,
    url: DEFAULT_BGM.path,
    isDefault: true,
  }];

  if (!sb) return defaults;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return defaults;  // ★

  if (_trackCache.items && Date.now() - _trackCache.ts < 30000) {
    return _trackCache.items;
  }

  const { data } = await sb
    .from('user_files')
    .select('*')
    .eq('user_id', user.id)
    .eq('category', 'bgm')
    .order('created_at');

  _trackCache.items = [...defaults, ...(data || []).map(t => ({
    id: t.id,
    name: t.name,
    url: sbPublicUrl('bgm', t.storage_path),
  }))];
  _trackCache.ts = Date.now();
  return _trackCache.items;
}

async function handleBGMFiles(fileList) {
  if (!sb) return;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  showLoading('上传音乐中...');
  try {
    for (const file of fileList) {
      if (!file.type.startsWith('audio/') && !file.name.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i)) continue;
      const path = sbStoragePath(user.id, 'bgm', file.name);
      await sbUpload('bgm', file, path);
      await sb.from('user_files').insert({
        user_id: user.id,
        category: 'bgm',
        name: file.name,
        size: file.size,
        mime_type: file.type,
        storage_path: path,
      });
    }
  } finally {
    hideLoading();
  }

  _trackCache.items = null;
  renderBGMPlaylist();
  const tracks = await getAllTracks();
  currentTrackIdx = tracks.length - 1;
  localStorage.setItem('bgmTrackIdx', currentTrackIdx);
  playCurrentTrack();
}

async function deleteBGMById(id) {
  if (!sb) return;
  const tracks = await getAllTracks();
  const idx = tracks.findIndex(t => t.id === id);
  if (idx < 0 || tracks[idx].isDefault) return;

  const { data } = await sb.from('user_files')
    .select('storage_path').eq('id', id).single();
  if (data) {
    await sbDelete('bgm', data.storage_path);
    await sb.from('user_files').delete().eq('id', id);
  }
  _trackCache.items = null;

  if (tracks.length === 2) {
    currentTrackIdx = 0;
    playCurrentTrack();
  } else if (idx === currentTrackIdx) {
    currentTrackIdx = Math.max(0, idx - 1);
    playCurrentTrack();
  } else if (idx < currentTrackIdx) {
    currentTrackIdx--;
    localStorage.setItem('bgmTrackIdx', currentTrackIdx);
  }
  renderBGMPlaylist();
}

// playCurrentTrack — 直接用 URL
async function playCurrentTrack() {
  const tracks = await getAllTracks();
  if (tracks.length === 0 || currentTrackIdx < 0) return;
  const track = tracks[currentTrackIdx];
  if (bgmAudio.src) URL.revokeObjectURL(bgmAudio.src);
  bgmAudio.src = track.url || track.path;
  bgmAudio.play().catch(() => {});
  document.getElementById('bgmPlay').textContent = '⏸';
  document.getElementById('bgmPlay').classList.add('playing');
  document.getElementById('bgmTrackName').textContent = track.name;
  renderBGMPlaylist();
}
```

### 4.5 改造 `js/cloud.js`

```javascript
// ---- 所有 IndexedDB 操作 → Supabase Storage + user_files 表 ----

async function renderFileList() {
  if (!sb) return;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;  // ★

  const { data: files } = await sb
    .from('user_files')
    .select('*')
    .eq('user_id', user.id)
    .eq('category', 'cloud')
    .order('created_at', { ascending: false });

  const list = document.getElementById('fileList');
  if (!files || files.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>还没有文件，上传一些吧~</div></div>';
  } else {
    list.innerHTML = files.map(f => `
      <div class="file-item">
        <div class="file-info">
          <span class="file-icon">${getFileIcon(f.name)}</span>
          <span class="file-name" title="${f.name}">${f.name}</span>
        </div>
        <div class="file-meta" style="margin-right:14px;">${formatSize(f.size || 0)} · ${(f.created_at || '').slice(0, 10)}</div>
        <div class="file-actions">
          <button class="file-btn" onclick="downloadFile(${f.id})" title="下载">⬇</button>
          <button class="file-btn danger" onclick="removeFile(${f.id})" title="删除">✕</button>
        </div>
      </div>
    `).join('');
  }
  updateStorageInfo();
}

async function updateStorageInfo() {
  if (!sb) return;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  const { data: files } = await sb
    .from('user_files')
    .select('size')
    .eq('user_id', user.id)
    .eq('category', 'cloud');

  const total = (files || []).reduce((s, f) => s + (f.size || 0), 0);
  const maxSize = 100 * 1048576;
  const pct = Math.min(100, (total / maxSize) * 100);
  document.getElementById('storageText').textContent = `已使用 ${formatSize(total)}`;
  document.getElementById('storageBar').style.width = pct + '%';
}

async function handleFiles(fileList) {
  if (!sb) return;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  showLoading('上传文件中...');
  try {
    for (const file of fileList) {
      const path = sbStoragePath(user.id, 'cloud', file.name);
      await sbUpload('files', file, path);
      await sb.from('user_files').insert({
        user_id: user.id,
        category: 'cloud',
        name: file.name,
        size: file.size,
        mime_type: file.type,
        storage_path: path,
      });
    }
  } finally {
    hideLoading();
  }
  renderFileList();
}

// ★ 修复: private bucket 使用签名 URL
async function downloadFile(id) {
  if (!sb) return;
  const { data } = await sb.from('user_files')
    .select('storage_path, name').eq('id', id).single();
  if (!data) return;

  showLoading('准备下载...');
  try {
    // files bucket 是 private → 必须用 signed URL
    const signedUrl = await sbSignedUrl('files', data.storage_path, 60);
    if (!signedUrl) { alert('下载链接生成失败'); return; }
    const a = document.createElement('a');
    a.href = signedUrl;
    a.download = data.name;
    a.click();
  } finally {
    hideLoading();
  }
}

async function removeFile(id) {
  if (!sb) return;
  const { data } = await sb.from('user_files')
    .select('storage_path').eq('id', id).single();
  if (data) {
    await sbDelete('files', data.storage_path);
    await sb.from('user_files').delete().eq('id', id);
  }
  renderFileList();
}

async function clearCloudData() {
  if (!sb) return;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  if (!confirm('确定要清空所有网盘文件吗？此操作不可撤销！')) return;

  showLoading('清除中...');
  try {
    const { data: files } = await sb
      .from('user_files')
      .select('storage_path')
      .eq('user_id', user.id)
      .eq('category', 'cloud');
    if (files?.length) {
      await sbDelete('files', files.map(f => f.storage_path));
    }
    await sb.from('user_files')
      .delete()
      .eq('user_id', user.id)
      .eq('category', 'cloud');
  } finally {
    hideLoading();
  }
  renderFileList();
}
```

### 4.6 改造 `js/articles.js` — JSON → Database

```javascript
async function loadArticles() {
  if (sb) {
    try {
      const { data, error } = await sb
        .from('articles')
        .select('id, slug, title, excerpt, tags, created_at')
        .eq('published', true)
        .order('created_at', { ascending: false });

      if (!error && data?.length) {
        articles = data.map(a => ({
          id: a.id,
          title: a.title,
          date: a.created_at.slice(0, 10),
          excerpt: a.excerpt,
          tags: a.tags,
        }));
        allTags = ['全部', ...new Set(articles.flatMap(a => a.tags))];
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
    const res = await fetch('data/articles.json');
    articles = await res.json();
  } catch {
    articles = [];  // 最终降级: 空列表
  }
  allTags = ['全部', ...new Set(articles.flatMap(a => a.tags))];
  renderFilters();
  renderArticles();
}
```

### 4.7 改造 `js/main.js` — init 流程

```javascript
// ★ 防止重复初始化
let _inited = false;

function bindGlobalEvents() {
  document.getElementById('btnFullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });

  // 锁定按钮 → 登出/登录 toggle
  document.getElementById('btnLock').addEventListener('click', handleLockBtnClick);
}

async function init() {
  if (_inited) return;
  _inited = true;

  bindWallpaperEvents();
  bindBGMEvents();
  bindCloudEvents();
  bindSettingsEvents();
  bindNavEvents();
  bindGlobalEvents();

  // 检查登录状态
  if (sb) {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      document.getElementById('lockOverlay').classList.add('hidden');
      await syncSettingsFromCloud();
    } else {
      document.getElementById('lockOverlay').classList.remove('hidden');
    }
  }

  await applyAvatar();
  renderFileList();
  renderBGMPlaylist();
  initSakura();
  applyAllSettings();
  renderWallpaperDots();
  loadArticles();

  // Restore wallpaper
  const items = await getAllWallpapers();
  if (items.length === 0) {
    document.body.style.backgroundImage = 'none';
  } else {
    if (currentWallpaper >= items.length) currentWallpaper = 0;
    applyWallpaper(currentWallpaper);
  }

  // Restore BGM
  const tracks = await getAllTracks();
  const savedIdx = parseInt(localStorage.getItem('bgmTrackIdx') || '0');
  currentTrackIdx = Math.min(savedIdx, tracks.length - 1);
  bgmAudio.volume = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
  playCurrentTrack();
}

// Save BGM state on unload
window.addEventListener('beforeunload', () => {
  if (currentTrackIdx >= 0) localStorage.setItem('bgmTrackIdx', currentTrackIdx);
  localStorage.setItem('bgmVolume', bgmAudio.volume);
});

// Boot
init();
```

### 4.8 可移除的文件和函数

| 操作 | 文件/函数 |
|------|-----------|
| 删除文件 | `js/db.js` |
| 删除文件 | `data/articles.json`（保留作为降级） |
| 删除函数 | `settings.js`: `hashPassword()`, `showLock()` |
| 删除字段 | `defaultSettings.lockPassword` |
| 删除变量 | `lockDismissedThisSession`, `settingsUnlocked`（改为用 `sb.auth.getSession()` 判断） |

---

## 五、文章管理后台

### 5.1 `admin.html` — 完整 CRUD + Markdown 预览

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>文章管理 — jieneng</title>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    :root { --bg: #1a1a2e; --card: #16213e; --accent: #7c3aed; --text: #eee; --dim: #888; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Microsoft YaHei', sans-serif; max-width: 900px; margin: 0 auto; padding: 24px 16px;
           background: var(--bg); color: var(--text); min-height: 100vh; }
    h1 { margin-bottom: 8px; }
    .logout { float: right; padding: 8px 16px; border-radius: 8px; background: transparent;
              border: 1px solid #555; color: var(--dim); cursor: pointer; }
    .logout:hover { color: #ff6060; border-color: #ff6060; }
    input, textarea, select { width: 100%; padding: 10px 12px; margin: 6px 0 12px; border-radius: 8px;
      background: var(--card); color: var(--text); border: 1px solid #333; font-size: 14px; }
    input:focus, textarea:focus { border-color: var(--accent); outline: none; }
    textarea { resize: vertical; font-family: monospace; }
    button { padding: 10px 24px; border-radius: 8px; background: var(--accent); color: #fff;
             border: none; cursor: pointer; font-size: 14px; transition: opacity 0.2s; }
    button:hover { opacity: 0.85; }
    button.cancel { background: transparent; border: 1px solid #555; color: var(--dim); }
    button.danger { background: transparent; border: 1px solid #5a2020; color: #ff6060; }
    button.danger:hover { background: rgba(255,60,60,0.1); }
    .row { display: flex; gap: 12px; }
    .row > * { flex: 1; }
    .article-item { display: flex; justify-content: space-between; align-items: center;
      padding: 12px 16px; background: var(--card); border-radius: 8px; margin-bottom: 8px;
      border: 1px solid transparent; transition: border-color 0.2s; }
    .article-item:hover { border-color: #333; }
    .article-item .title { font-weight: bold; }
    .article-item .meta { color: var(--dim); font-size: 13px; }
    .article-item .actions { display: flex; gap: 8px; flex-shrink: 0; }
    .article-item .actions button { padding: 6px 14px; font-size: 13px; border-radius: 6px; }
    .empty { text-align: center; color: var(--dim); padding: 60px 0; }
    .preview { background: var(--card); border: 1px solid #333; border-radius: 8px;
               padding: 16px; margin: 6px 0 12px; min-height: 60px; line-height: 1.7; }
    .preview h1,.preview h2,.preview h3 { margin: 12px 0 6px; color: #c4b5fd; }
    .preview p { margin: 6px 0; }
    .preview code { background: #2d2d3f; padding: 2px 6px; border-radius: 4px; }
    .preview pre { background: #2d2d3f; padding: 12px; border-radius: 8px; overflow-x: auto; }
    .toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
             padding: 10px 24px; border-radius: 20px; background: var(--accent); color: #fff;
             font-size: 14px; z-index: 99; display: none; }
  </style>
</head>
<body>
  <button class="logout" onclick="logout()">登出</button>
  <h1>📝 文章管理</h1>
  <p style="color:var(--dim);margin-bottom:20px;">发布、编辑和管理你的文章</p>

  <div id="loginBox">
    <input type="email" id="email" placeholder="邮箱" style="max-width:400px;">
    <input type="password" id="password" placeholder="密码" style="max-width:400px;">
    <button onclick="login()">登录</button>
  </div>

  <div id="editor" style="display:none;">
    <h3 id="editorTitle">新建文章</h3>
    <div class="row">
      <input type="text" id="title" placeholder="标题 *">
      <input type="text" id="slug" placeholder="slug (URL标识符，留空自动生成)">
    </div>
    <input type="text" id="tags" placeholder="标签 (逗号分隔)">
    <textarea id="excerpt" rows="2" placeholder="摘要"></textarea>
    <textarea id="content" rows="14" placeholder="正文 (Markdown) *"></textarea>
    <div class="preview" id="preview"></div>
    <div style="margin:12px 0; display:flex; gap:12px; align-items:center;">
      <button id="btnSave" onclick="saveArticle()">发布</button>
      <button class="cancel" id="btnCancel" onclick="cancelEdit()" style="display:none;">取消编辑</button>
      <label style="color:var(--dim);font-size:13px;cursor:pointer;">
        <input type="checkbox" id="published" checked> 发布（公开可见）
      </label>
    </div>

    <hr style="border-color:#222; margin:24px 0;">
    <h3>已有文章</h3>
    <div id="articleList"></div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const sb = supabase.createClient('YOUR_URL', 'YOUR_KEY');
    let editingId = null;

    // ---- Toast ----
    function toast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg; el.style.display = '';
      clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', 2000);
    }

    // ---- Auth ----
    async function login() {
      const { error } = await sb.auth.signInWithPassword({
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
      });
      if (error) return toast('登录失败: ' + error.message);
      document.getElementById('loginBox').style.display = 'none';
      document.getElementById('editor').style.display = 'block';
      const { data: { user } } = await sb.auth.getUser();
      // 检查是否为 admin
      const { data: admin } = await sb.from('admins')
        .select('user_id').eq('user_id', user.id).single();
      if (!admin) {
        toast('你不是管理员！请在 Supabase SQL Editor 中执行: INSERT INTO admins VALUES (\'' + user.id + '\');');
        await sb.auth.signOut();
        document.getElementById('loginBox').style.display = '';
        document.getElementById('editor').style.display = 'none';
        return;
      }
      loadArticles();
    }

    async function logout() {
      await sb.auth.signOut();
      location.reload();
    }

    // ---- Articles CRUD ----
    async function loadArticles() {
      const { data } = await sb.from('articles')
        .select('*').order('created_at', { ascending: false });
      const list = document.getElementById('articleList');
      if (!data?.length) {
        list.innerHTML = '<div class="empty">还没有文章，写第一篇吧 ✦</div>';
        return;
      }
      list.innerHTML = data.map(a => `
        <div class="article-item">
          <div>
            <div class="title">${a.title} ${a.published ? '' : '<span style="color:#ff6060;">[草稿]</span>'}</div>
            <div class="meta">${(a.created_at||'').slice(0,10)} · ${(a.tags||[]).join(', ')}</div>
          </div>
          <div class="actions">
            <button onclick="editArticle(${a.id})" style="background:transparent;border:1px solid #555;color:var(--dim);">编辑</button>
            <button class="danger" onclick="deleteArticle(${a.id})">删除</button>
          </div>
        </div>
      `).join('');
    }

    function editArticle(a) {
      // 直接传 ID 不够，需要先查到数据。改用 fetch + ID
      sb.from('articles').select('*').eq('id', a).single().then(({ data }) => {
        if (!data) return;
        document.getElementById('editorTitle').textContent = '编辑文章';
        document.getElementById('title').value = data.title;
        document.getElementById('slug').value = data.slug || '';
        document.getElementById('tags').value = (data.tags || []).join(', ');
        document.getElementById('excerpt').value = data.excerpt || '';
        document.getElementById('content').value = data.content || '';
        document.getElementById('published').checked = data.published;
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
      document.getElementById('excerpt').value = '';
      document.getElementById('content').value = '';
      document.getElementById('published').checked = true;
      document.getElementById('btnSave').textContent = '发布';
      document.getElementById('btnCancel').style.display = 'none';
      document.getElementById('preview').innerHTML = '';
    }

    async function saveArticle() {
      const title = document.getElementById('title').value.trim();
      const content = document.getElementById('content').value.trim();
      if (!title) return toast('标题不能为空');
      if (!content) return toast('正文不能为空');

      const tags = document.getElementById('tags').value.split(',')
        .map(t => t.trim()).filter(Boolean);
      const slug = document.getElementById('slug').value.trim()
        || title.toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '').slice(0, 50);
      const published = document.getElementById('published').checked;

      const payload = { title, slug, excerpt: document.getElementById('excerpt').value.trim(),
        content, tags, published, updated_at: new Date() };

      if (editingId) {
        const { error } = await sb.from('articles').update(payload).eq('id', editingId);
        if (error) return toast('保存失败: ' + error.message);
        toast('文章已更新！');
      } else {
        const { error } = await sb.from('articles').insert(payload);
        if (error) return toast('发布失败: ' + error.message);
        toast('发布成功！');
      }
      cancelEdit();
      loadArticles();
    }

    async function deleteArticle(id) {
      if (!confirm('确定删除这篇文章？')) return;
      const { error } = await sb.from('articles').delete().eq('id', id);
      if (error) return toast('删除失败');
      toast('已删除');
      loadArticles();
    }

    // ---- Markdown 预览 ----
    document.getElementById('content').addEventListener('input', renderPreview);
    function renderPreview() {
      const md = document.getElementById('content').value;
      document.getElementById('preview').innerHTML = md
        ? marked.parse(md)
        : '<span style="color:var(--dim);">预览区域...</span>';
    }

    // 回车登录
    document.getElementById('password').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') login();
    });

    // 检查已有 session
    (async () => {
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        document.getElementById('loginBox').style.display = 'none';
        document.getElementById('editor').style.display = 'block';
        loadArticles();
      }
    })();
  </script>
</body>
</html>
```

---

## 六、IndexedDB → Supabase 迁移

部署后用户浏览器中旧的 IndexedDB 数据仍在，但不再读取。提供一次性迁移：

```javascript
// 放在 settings 面板的"数据管理"区域
async function migrateLocalToCloud() {
  if (!sb) { alert('服务不可用'); return; }
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { alert('请先登录'); return; }

  // 打开旧的 IndexedDB
  const oldDB = await new Promise((resolve, reject) => {
    const req = indexedDB.open('PersonalSiteDB', 1);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });

  showLoading('迁移数据中...');
  let migrated = { wallpapers: 0, files: 0, tracks: 0, avatar: false };

  try {
    // 迁移壁纸
    const wallpapers = await dbGetAllFrom(oldDB, 'wallpapers');
    for (const w of wallpapers) {
      const blob = dataUrlToBlob(w.dataUrl);
      const file = new File([blob], w.name, { type: 'image/png' });
      const path = sbStoragePath(user.id, 'wallpaper', w.name);
      await sbUpload('wallpapers', file, path);
      await sb.from('user_files').insert({
        user_id: user.id, category: 'wallpaper',
        name: w.name, size: blob.size, mime_type: 'image/png', storage_path: path,
      });
      migrated.wallpapers++;
    }

    // 迁移网盘文件
    const files = await dbGetAllFrom(oldDB, 'files');
    for (const f of files) {
      const blob = new Blob([f.data]);
      const file = new File([blob], f.name, { type: 'application/octet-stream' });
      const path = sbStoragePath(user.id, 'cloud', f.name);
      await sbUpload('files', file, path);
      await sb.from('user_files').insert({
        user_id: user.id, category: 'cloud',
        name: f.name, size: f.size, storage_path: path,
      });
      migrated.files++;
    }

    // 迁移 BGM 曲目
    const tracks = await dbGetAllFrom(oldDB, 'tracks');
    for (const t of tracks) {
      const blob = new Blob([t.data]);
      const file = new File([blob], t.name, { type: 'audio/mpeg' });
      const path = sbStoragePath(user.id, 'bgm', t.name);
      await sbUpload('bgm', file, path);
      await sb.from('user_files').insert({
        user_id: user.id, category: 'bgm',
        name: t.name, size: blob.size, storage_path: path,
      });
      migrated.tracks++;
    }

    // 迁移头像
    const avatar = await dbGetAllFrom(oldDB, 'avatar');
    if (avatar?.dataUrl) {
      const blob = dataUrlToBlob(avatar.dataUrl);
      const file = new File([blob], 'avatar.png', { type: 'image/png' });
      const path = sbStoragePath(user.id, 'avatar', 'avatar.png');
      await sbUpload('avatars', file, path);
      await sb.from('avatars').upsert({ user_id: user.id, storage_path: path, updated_at: new Date() });
      migrated.avatar = true;
    }

    alert(`迁移完成！壁纸 ${migrated.wallpapers} 张, 文件 ${migrated.files} 个, BGM ${migrated.tracks} 首${migrated.avatar ? ', 头像 1 个' : ''}`);
  } catch (e) {
    alert('迁移失败: ' + e.message);
  } finally {
    hideLoading();
    oldDB.close();
  }
}

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/:(.*?);/)[1];
  const bytes = atob(parts[1]);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function dbGetAllFrom(db, storeName) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch { resolve([]); }
  });
}
```

在设置面板加迁移按钮:
```html
<div class="settings-group">
  <div class="settings-group-title">☁ 云端迁移</div>
  <p style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">
    将浏览器本地数据（壁纸、文件、BGM、头像）迁移到云端。迁移后可在任何设备访问。
  </p>
  <button onclick="migrateLocalToCloud()"
    style="padding:10px 24px; border-radius:12px; background:var(--accent); color:#fff; border:none; cursor:pointer;">
    迁移本地数据到云端
  </button>
</div>
```

---

## 七、部署检查清单

```
□ 1.  Supabase 项目创建完成, API key 已获取
□ 2.  Authentication → Disable email confirmations
□ 3.  SQL 建表语句全部执行成功（含 admins + 合并 user_files 表）
□ 4.  4 个 Storage bucket 创建 + Policy 配置（注意 files 是 private）
□ 5.  注册账号后，在 SQL Editor 执行:
     INSERT INTO admins VALUES ('your-user-id-from-auth-users-table');
□ 6.  js/supabase.js 填入正确的 URL + anon key
□ 7.  index.html SDK 脚本加载方式改为 defer
□ 8.  各模块改造完成 (settings, wallpaper, bgm, cloud, articles, main)
□ 9.  lock overlay UI 改为登录/注册表单 + 按钮事件绑定
□ 10. admin.html 部署到 GitHub Pages
□ 11. 迁移按钮加入设置面板
□ 12. GitHub Pages 部署
□ 13. 验证: 未登录 → 默认壁纸/BGM 正常, 公开文章可见
□ 14. 验证: 登录 → 上传壁纸/文件/BGM
□ 15. 验证: 换浏览器 → 登录 → 数据同步
□ 16. 验证: 网盘文件下载（signed URL）
□ 17. 验证: admin.html 登录 → 新建/编辑/删除文章
```

---

## 八、降级策略

所有 Supabase 调用包裹 try/catch，失败时回退:

| 模块 | Supabase 失败时的行为 |
|------|----------------------|
| 文章 | 降级到 `data/articles.json`（建议保留该文件） |
| 壁纸 | 只显示 3 张默认壁纸，隐藏自定义壁纸 |
| BGM | 只播放 `bgm/desir.mp3`，隐藏用户曲目 |
| 网盘 | 显示空状态 |
| 设置 | 只读写 localStorage，不触发云同步 |
| 认证 | 登录/注册按钮弹出"服务不可用" |
