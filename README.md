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
npm run dev        # → http://localhost:3000
```

## 命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 开发服务器（源码热重载） |
| `npm run build` | 生产构建 → `dist/`（esbuild tree-shaking） |
| `npm run preview` | 预览生产构建 |
| `npm test` | 31 条单元测试（vitest） |
| `npm run test:watch` | 测试监听模式 |

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
| `_setLoginUI(showAdmin)` | 统一登录/登出 UI 切换 | main.js、supabase.js onAuthStateChange |
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

管理员可在后台（`#sec-admin`）手工创建/编辑/置顶/删除资讯条目。前台资讯侧边栏也有删除按钮（管理员可见）。

## 技术栈

原生 HTML/CSS/JS · Supabase SDK v2 · marked v18 · esbuild · vitest · Playwright

## 项目统计

| 指标 | 数值 |
|------|------|
| JS 文件 | 15（2 IIFE 基础 + 13 ESM 业务） |
| CSS | 4 文件 |
| 单元测试 | 31 条 |
| E2E 测试 | 5 条 |
| 构建产物 | ~100 KB（tree-shaken ESM bundle） |
| i18n 文案 | 297 条 `zh-CN.json`，覆盖 7 个业务模块 |

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
│   └── responsive.css      # 响应式适配
│
├── data/                   # 静态数据
│   ├── articles.json       # 文章兜底数据
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
│   ├── fetch-news.js       # 资讯抓取
│   └── csp-audit.js        # CSP 审查
│
└── test/                   # 测试
    ├── sanitize.test.js    # HTML 消毒测试
    ├── articles-merge.test.js # 文章合并测试
    ├── setup.js            # 测试环境配置
    └── e2e/                # Playwright E2E
```

---

## 故障排查

详细信息见 [CLAUDE.md](./CLAUDE.md)。

### 页面空白 / JS 报错

1. `npx vitest run` → 确认 31 条全部通过
2. 检查 Supabase 服务状态：https://status.supabase.com
3. 检查 CDN 可访问性（cdn.jsdelivr.net）
4. 确认 CSP 未拦截新资源

### Service Worker 缓存旧版本

每次构建 `sw.js` 版本号自动递增。手动清除：DevTools → Application → Service Workers → Unregister → 硬刷新 (Ctrl+Shift+R)。

### BGM 不播放 / 加载慢

浏览器自动播放策略：首次用户交互后才允许音频播放。大文件加载时曲名位置显示"加载中…"/"缓冲中…"。点击页面任意位置后自动触发播放。

### 壁纸切换异常

- 壁纸圆点懒加载：hover 圆点时按需下载全尺寸图片
- localStorage 配额满时 `safeSetItem()` 静默降级
- 桌面端使用交叉淡入淡出动画（bgLayer），移动端直接切换

### 评论不显示

Supabase 中需先建 `comments` 表。建表语句在 `RLS_POLICIES.sql` 第 246-256 行，需在 Supabase SQL Editor 中手动执行。

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
