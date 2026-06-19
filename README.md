# jieneng — 个人主页

Galgame · 动漫 OST · 视觉小说  /  纯静态 SPA · Supabase 后端 · GitHub Pages 部署

## 这是什么

一个以 Galgame / 动漫音乐 / 视觉小说为主题的个人主页。功能包括：

- **文章**：Markdown 长文，支持标签筛选和搜索
- **资讯**：每日自动抓取二次元资讯（AniList + MyAnimeList + Bilibili），智能过滤
- **壁纸 / BGM**：可切换壁纸，背景音乐播放器
- **云盘**：Supabase Storage 文件浏览
- **留言**：游客可提交，管理员审核后展示
- **管理后台**：文章/资讯/文件 CRUD，独立登录页

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
│   ├── shared.js       → 全局常量（已由 config.mjs 逐步取代）
│   ├── event-bus.js    → 模块间消息总线
│   ├── cache.js        → TTL 缓存工具
│   └── supabase.js     → Supabase 客户端 + 工具函数
│
└── module scripts（ESM 业务层，import/export 显式依赖）
    └── main.js（入口）→ anime-news / articles / wallpaper / bgm / cloud / admin / settings / nav / comments / sakura / i18n
```

## 数据流

```
用户 ──→ 浏览器（localStorage / IndexedDB）
           │
           └──→ Supabase（Auth + DB + Storage）
                  └──→ 降级: data/*.json（离线可用）

articles： Supabase 已发布 → JSON 兜底 → 去重排序
BGM 壁纸： 默认文件 → 云端 → IndexedDB 本地
资讯：     缓存（1h TTL）→ Supabase → JSON（GitHub Actions 每日更新）
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

- **种子关键词**：硬编码在 `scripts/fetch-news.js`（~400 个），覆盖动漫/视觉小说/日系游戏/二游/垃圾内容
- **关键词学习**：每轮运行从通过/拒绝的条目自动学习新关键词，持久化到 `data/keyword-bank.json`
- **品质控制**：黏性词保护 + TTL 过期 + LRU 淘汰 + include/exclude 冲突解决

### 调度

GitHub Actions 每日北京时间 06:00（UTC 22:00）运行。也可手动触发：GitHub → Actions → "Daily Anime News" → Run workflow。

### 管理

管理员可在后台（`admin.html`）手工创建/编辑/置顶资讯条目。带 `content` 或 `pinned` 的条目优先展示，不会被自动抓取覆盖。

## 技术栈

原生 HTML/CSS/JS · Supabase SDK v2 · marked v18 · esbuild · vitest · Playwright

## 项目统计

| 指标 | 数值 |
|------|------|
| JS 文件 | 17（14 ESM + 3 IIFE） |
| CSS | 4 文件 |
| 注释覆盖 | 1,461 行（18 个源文件） |
| 单元测试 | 31 条 |
| E2E 测试 | 5 条 |
| 构建产物 | 103 KB（tree-shaken ESM bundle） |
| i18n 文案 | 293 行 `zh-CN.json` |

---

## 故障排查

常见问题的快速诊断。详细运维步骤见 [CLAUDE.md](./CLAUDE.md)。

### 页面空白 / JS 报错

1. `npx vitest run` → 确认 31 条全部通过
2. 检查 Supabase 服务状态：https://status.supabase.com
3. 浏览器控制台检查 CSP 拦截
4. 确认 CDN（cdn.jsdelivr.net）可访问

### Service Worker 缓存旧版本

每次构建 `sw.js` 版本号自动递增。手动清除：DevTools → Application → Service Workers → Unregister → 硬刷新 (Ctrl+Shift+R)。

### BGM 不播放

浏览器自动播放策略：首次用户交互后才允许音频播放。点击页面任意位置后自动触发 `_onUserInteract()`。

### 壁纸切换异常

检查 localStorage 配额：DevTools → Application → Storage。配额满时 `safeSetItem()` 静默降级。

### 评论 / 文章不显示

Supabase 不可用时自动降级到本地 JSON。确认 `data/articles.json`、`data/anime-news.json` 未损坏。

---

## 已知隐患与改进方向

### 🟡 结构性

| # | 问题 | 影响 | 修复预估 |
|---|------|------|----------|
| 1 | `shared.js` 和 `config.mjs` 内容重复 | 改一处忘另一处 → 隐性不一致 | 30 分钟 |
| 2 | `escHtml` 在 3 个文件中重复实现 | XSS 规则更新不同步 | 20 分钟 |
| 3 | 4 个 IIFE 基础层未转 ESM | 全局命名空间污染，`.mjs` 包装层增加复杂度 | 2 小时 |

### 🟢 工程化

| # | 问题 | 影响 | 修复预估 |
|---|------|------|----------|
| 4 | TTL 缓存常量分散在 4 个模块 | 改全局缓存策略需搜 4 个文件 | 30 分钟 |
| 5 | Playwright 双入口（driver + E2E） | 版本不同步，依赖冲突 | 30 分钟 |
| 6 | `scripts/build.js` 含永不执行的降级分支 | 代码理解成本 | 5 分钟 |

### 🟢 测试

| # | 问题 | 修复预估 |
|---|------|----------|
| 7 | 单元测试仅覆盖 `sanitizeHtml` + 文章合并，其余模块无测试 | 2-3 小时 |
| 8 | E2E 验证 DOM 存在性，无视觉回归 | 1 小时 |

### 🟢 功能

| # | 问题 | 当前策略 |
|---|------|----------|
| 9 | i18n 文案仅在 nav.js 接入，其余模块硬编码中文 | 等有第二语言需求时逐模块接 `t()` |
| 10 | BGM 文件占用仓库 31 MB | 当前站点自包含优先；如需瘦身可迁至 Supabase Storage |

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
