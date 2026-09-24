# jieneng — 个人主页

Galgame · 动漫 OST · 视觉小说 / 纯静态 SPA · Supabase 后端 · GitHub Pages 部署

## 这是什么

一个以 Galgame / 动漫音乐 / 视觉小说为主题的个人主页。功能包括：

- **文章**：Markdown 长文，标签筛选 + 搜索，卡片/时间线双视图，投稿系统
- **资讯**：每日自动抓取二次元资讯（AniList + MyAnimeList + Bilibili），智能过滤，右侧滑出侧栏
- **壁纸 / BGM**：可切换壁纸（圆点懒加载），背景音乐播放器（缓冲提示 + 频谱可视化）
- **云盘**：Supabase Storage 文件上传/下载/删除，拖拽上传
- **留言**：游客可提交，管理员审核后展示，回复嵌套
- **管理后台**：文章 CRUD、资讯管理、壁纸/BGM 审核、文件管理，内联编辑器 + Markdown 实时预览

## 本地运行

```bash
git clone https://github.com/jieneng10/personal-site.git
cd personal-site
npm install
npm run dev        # → http://127.0.0.1:3000
```

## 命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 本地静态开发服务器（不自动刷新） |
| `npm run build` | 生产构建 → `dist/`（esbuild tree-shaking） |
| `npm run preview` | 预览生产构建 |
| `npm run lint` | 检查页面引用的资源和 CSP 许可来源 |
| `npm test` | 单元测试（vitest） |
| `npm run test:watch` | 测试监听模式 |

端到端测试需要先在另一个终端运行 `node scripts/dev-server.js 8000`，然后执行 `npx playwright test --config=test/e2e/playwright.config.js`。首次运行需安装 Chromium：`npx playwright install chromium`。测试默认访问 `http://127.0.0.1:8000`。

## 架构

```
index.html
├── classic defer scripts（IIFE 基础层，window.xxx 全局通信）
│   ├── shared.js       → 全局常量（唯一来源：Supabase URL/Key、DB_NAME、safeSetItem）
│   └── supabase.js     → Supabase 客户端 + 共享工具
│                         （_setLoginUI、_upsertArticle、_deleteUserFile、renderMarkdown、formatFileSize）
│
└── module scripts（ESM 业务层，import/export 显式依赖）
    ├── config.mjs       → 常量 re-export（从 window 读取）
    ├── event-bus.mjs    → 模块间事件总线（on/off/emit）
    ├── cache.mjs        → TTL 内存缓存（并发去重 + 强制刷新）
    ├── supabase.mjs     → 工具函数 re-export（从 window 读取）
    ├── i18n.js          → 国际化（t / tSync，插值支持）
    └── main.js（入口）→ sakura / anime-news / articles / wallpaper / bgm / cloud
                         / admin / settings / nav / comments
```

### 共享工具（supabase.js 导出）

| 函数 | 用途 | 调用方 |
|------|------|--------|
| `_setLoginUI(loggedIn)` | 更新登录状态对应的 UI；管理员入口另由角色检查决定 | main.js、supabase.js onAuthStateChange |
| `_upsertArticle(payload, editId)` | 插入或更新文章 | admin.js、articles.js |
| `_deleteUserFile(id)` | 删除 user_files 记录 + Storage 文件 | wallpaper.js、bgm.js、admin.js |
| `renderMarkdown(md)` | Markdown → 安全 HTML | articles.js、anime-news.js、admin.js |
| `formatFileSize(bytes)` | B/KB/MB 格式化 | cloud.js、admin.js |

## 数据流

```
用户 ──→ 浏览器（localStorage / IndexedDB）
           │
           └──→ Supabase（Auth + DB + Storage）
                  └──→ 降级: data/*.json（离线可用）

articles： Supabase 已发布 → JSON 兜底 → 去重排序（5 min 缓存）
BGM 壁纸： 默认文件 → 云端 → IndexedDB 本地（30s / 10min 缓存）
资讯：     createCache（1h TTL）→ Supabase → JSON（GitHub Actions 每日更新）
评论：     游客待审核 → 管理员面板通过 → 所有人可见
```

### Supabase Storage 上线核对

先在 Dashboard 建立公开的 `wallpapers`、`bgm`、`avatars` 桶和私有的 `files` 桶，设置各桶的文件大小与 MIME 类型限制，再核对并执行 [RLS_POLICIES.sql](./RLS_POLICIES.sql)。该文件含 `storage.objects` 的可执行策略；上线前先列出已有策略，清理与之冲突的宽松旧策略，因为多条允许策略会叠加。仓库改动不会自动更新线上 Supabase 策略。

策略脚本还会为头像的 `user_id` 添加唯一约束，确保重复上传更新原记录。若旧数据库已有同一用户的多条头像记录，脚本会报错并停止；先核对、合并这些记录，再重新执行，避免自动删除仍在使用的文件。

上线后分别用游客、普通登录用户、管理员账号验证：游客只能往 `guest/` 上传壁纸或 BGM，数据库记录保持待审核；普通用户只能操作自己的对象和私有网盘；管理员能拒绝游客投稿并删除其他用户的媒体。还要确认普通用户无法删除其他人的对象、游客无法读取私有网盘。若匿名上传返回 403，先查 Storage 日志和实际策略，不要直接放开匿名对象列表权限。

`wallpapers`、`bgm` 是公开桶：待审核文件虽然不会出现在站点列表中，知道文件 URL 的人仍能读取；它们不能存放保密内容。匿名上传也可能被反复滥用，需监控用量，必要时改用私有审核桶和受控上传接口。策略依据：[Storage 访问控制](https://supabase.com/docs/guides/storage/security/access-control)、[对象所有权](https://supabase.com/docs/guides/storage/security/ownership)、[公开桶行为](https://supabase.com/docs/guides/storage/buckets/fundamentals)、[文件限制](https://supabase.com/docs/guides/storage/uploads/file-limits)。

## 资讯系统

每日自动从 4 个数据源抓取二次元资讯，经多级过滤后输出到 `data/anime-news.json`。

### 数据源

| 源 | 类型 | 说明 |
|----|------|------|
| AniList Trending | GraphQL | 正在播出的高分动漫（Top 3） |
| AniList Upcoming | GraphQL | 即将开播的期待作（Top 2） |
| Jikan (MAL) | REST | MyAnimeList 热播榜（Top 3） |
| Bilibili 热门 | REST | 热门视频 50 条 → 过滤 + WBI 搜索补充 |

### 过滤流水线

每条 Bilibili 视频依次经过：

```
分区黑名单 → 标签黑名单 → 垃圾词 → 二游关键词 → 感叹号过多
→ 二游描述二次检查 → 允许分区 → 日系游戏关键词 → 动漫关键词
```

- **种子关键词**：`data/seed-keywords.json`（8 个种子数组），正则构建在 `scripts/fetch-news.js`
- **关键词学习**：每轮运行从通过/拒绝的条目自动学习，持久化到 `data/keyword-bank.json`
- **品质控制**：黏性词保护 + TTL 过期 + LRU 淘汰 + include/exclude 冲突解决
- **dry-run 模式**：`node scripts/fetch-news.js --dry-run` 试跑不写文件
- **反向审计**：`node scripts/fetch-news.js --audit` 检测排除词误杀
- **源健康监控**：4 源 7 天滑动均值告警，`data/source-health.json`

### 调度

GitHub Actions 每日北京时间 06:00（UTC 22:00）运行。也可手动触发：GitHub → Actions → "Daily Anime News" → Run workflow。

### 管理

管理员可在后台（`#admin`）手工创建/编辑/置顶/删除资讯条目。前台资讯侧边栏也有删除按钮（管理员可见）。

## 技术栈

原生 HTML/CSS/JS · Supabase SDK v2 · marked v18 · esbuild · vitest · Playwright

## 目录结构

```
├── index.html              # SPA 入口
├── admin.html              # 管理后台（重定向到 index.html#admin）
├── reset-password.html     # 密码重置页
├── 404.html                # 自定义 404
├── sw.js                   # Service Worker（离线缓存）
├── manifest.json           # PWA manifest
├── feed.xml                # RSS 订阅源
├── RLS_POLICIES.sql        # Supabase RLS 策略 + 建表语句
│
├── js/                     # JavaScript 源码
│   ├── shared.js           # IIFE：全局常量（唯一来源）
│   ├── supabase.js         # IIFE：Supabase 客户端 + 共享工具
│   ├── config.mjs          # ESM：常量 re-export
│   ├── event-bus.mjs       # ESM：事件总线
│   ├── cache.mjs           # ESM：TTL 缓存
│   ├── supabase.mjs        # ESM：工具函数 re-export
│   ├── i18n.js             # ESM：国际化
│   ├── main.js             # 入口：初始化 + 全局状态
│   ├── sakura.js           # Canvas 樱花飘落动画
│   ├── anime-news.js       # 二次元资讯侧边栏
│   ├── articles.js         # 文章列表 + 详情 + 投稿
│   ├── wallpaper.js        # 壁纸系统 + 头像
│   ├── bgm.js              # BGM 播放器
│   ├── cloud.js            # 云盘文件管理
│   ├── admin.js            # 管理后台面板
│   ├── settings.js         # 用户设置 + 认证
│   ├── nav.js              # 导航 + 面板管理
│   ├── comments.js         # 评论系统
│   └── marked.min.js       # marked v18（vendored）
│
├── css/                    # 样式表
│   ├── variables.css       # CSS 变量 + 重置
│   ├── layout.css          # 布局 + 导航 + 面板
│   ├── components.css      # 组件样式
│   ├── responsive.css      # 响应式适配
│   └── visual-refresh.css  # 当前视觉主题与细节覆盖层
│
├── data/                   # 静态数据
│   ├── articles.json       # 公开文章兜底数据（只含 public:true）
│   ├── anime-news.json     # 资讯兜底数据
│   ├── seed-keywords.json  # 种子关键词
│   ├── keyword-bank.json   # 学习关键词库
│   ├── admin-overrides.json# 管理删除标题列表
│   └── i18n/zh-CN.json     # 中文语言包
│
├── static/                 # 静态资源
│   ├── wallpapers/         # 6 张默认壁纸（webp）
│   ├── bgm/                # 3 首默认 BGM（mp3）
│   └── images/             # 默认头像
│
├── scripts/                # 构建/工具脚本
│   ├── build.js            # 生产构建
│   ├── dev-server.js       # 本地静态服务（限制可访问路径）
│   ├── fetch-news.js       # 资讯抓取
│   └── csp-audit.js        # CSP 审查
│
└── test/                   # 测试
    ├── sanitize.test.js    # HTML 消毒测试
    ├── articles-merge.test.js # 文章合并测试
    ├── setup.js            # 测试环境配置
    └── e2e/                # Playwright E2E
```

首页依次加载 `variables.css`、`layout.css`、`components.css`、`responsive.css`、`visual-refresh.css`。调整当前配色、导航或移动端界面时，先检查最后的视觉主题层，避免旧样式修改后被覆盖。

`data/articles.json` 会被公开提供，只能包含 `public:true` 的文章。私密草稿保存在本机忽略目录 `.private/articles.json`，并需单独备份；构建和单元测试会拒绝将未公开文章放回公开 JSON。项目开发服务器拒绝访问 `.private/` 和隐藏目录；不要改用可直接暴露整个项目根目录的通用静态服务器。已提交过的旧版本仍可能存在于 Git 历史中，当前文件移除不能抹去历史记录。

---

## 故障排查

详细信息见 [CLAUDE.md](./CLAUDE.md)。

### 页面空白 / JS 报错

1. `npm test` → 确认单元测试全部通过
2. 检查 Supabase 服务状态：https://status.supabase.com
3. 检查 CDN 可访问性（cdn.jsdelivr.net）
4. 确认 CSP 未拦截新资源

### Service Worker 缓存旧版本

构建会按静态文件内容为 `sw.js` 生成缓存名；文件改变后，新 Service Worker 会清理本站旧缓存。若浏览器仍显示旧版，可在 DevTools → Application → Service Workers 中 Unregister 后硬刷新 (Ctrl+Shift+R)。

### BGM 不播放 / 加载慢

浏览器自动播放策略：首次用户交互后才允许音频播放。大文件加载时曲名位置显示"加载中…"/"缓冲中…"。点击页面任意位置后自动触发播放。

### 壁纸切换异常

- 壁纸圆点懒加载：hover 圆点时按需下载全尺寸图片
- localStorage 配额满时 `safeSetItem()` 静默降级
- 桌面端使用交叉淡入淡出动画（bgLayer），移动端直接切换

### 评论不显示

Supabase 中需先建 `comments` 表并启用相应 RLS 策略。仓库中的建表和策略参考见 `RLS_POLICIES.sql`；数据库变更需在 Supabase SQL Editor 中单独执行和核验。

### 文章不显示 / 资讯不更新

Supabase 不可用时自动降级到本地 `data/articles.json` / `data/anime-news.json`。确认文件未损坏。资讯缓存 1 小时，可点击 ⟳ 手动刷新。

---

## 部署

推送 `master` → GitHub Pages 自动部署到 `jieneng10.github.io/personal-site/`。

```bash
# 回滚
git log --oneline -10
git revert <commit-hash>

# 或硬回滚
git reset --hard <commit-hash>
git push origin master --force-with-lease
```

## 相关链接

- 运维手册：[CLAUDE.md](./CLAUDE.md)
- Supabase 状态：https://status.supabase.com
- 资讯抓取脚本：`scripts/fetch-news.js`
- 数据库策略：`RLS_POLICIES.sql`
