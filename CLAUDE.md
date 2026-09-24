# personal-site — 运维手册

## 项目概览

jieneng 的个人主页 — 纯静态 SPA，Supabase 后端，GitHub Pages 部署。

## 本地开发

```bash
npm run dev        # 启动本地静态服务 → http://127.0.0.1:3000（不自动刷新）
npm run build      # 生产构建 → dist/
npm run preview    # 预览生产构建
npm run lint       # 检查页面资源引用与 CSP 许可来源
npm test           # 单元测试
npm run test:watch # 监听模式
```

端到端测试需另开终端运行 `node scripts/dev-server.js 8000`，再运行 `npx playwright test --config=test/e2e/playwright.config.js`。首次运行先执行 `npx playwright install chromium`。Playwright 配置不会自动启动服务。

## 部署流程

1. `git push origin master` → GitHub Pages 自动部署
2. GitHub Actions 每日 06:00 (北京时间) 抓取资讯 → 自动推送 `data/anime-news.json`
3. CI (`ci.yml`) 在推送、PR 和手动触发时执行 CSP/资源检查、单元测试、构建与浏览器烟雾测试

### 手动触发资讯抓取
GitHub → Actions → "Daily Anime News" → "Run workflow"

## 架构

```
index.html  ──→  classic scripts (IIFE)     ← window.xxx 全局通信
             ├──  shared.js  (常量)
             └──  supabase.js (客户端 + 工具函数)
             ──→  ESM 业务模块                ← import/export 显式依赖
                  event-bus.mjs / cache.mjs / main.js 等
                  生产构建入口: main.js → bundle.min.js
```

- **经典脚本**：`shared.js`、`supabase.js` 通过 `window.xxx` 暴露 API；`marked.min.js` 为本地 vendored 依赖
- **ESM 模块**：开发时由 `index.html` 直接加载，生产构建由 esbuild 从 `main.js` 打包
- **数据**：文章和资讯以 Supabase 为主、公开 JSON 为降级来源；媒体和设置另有本地缓存
- **样式**：`css/visual-refresh.css` 最后加载，修改主题时需检查它是否覆盖基础样式

## Supabase 表

| 表 | 用途 | RLS |
|----|------|-----|
| articles | 文章 | 任何人读已发布；管理员增删改 |
| user_files | 壁纸/BGM/云盘文件 | 分层策略见 RLS_POLICIES.sql |
| user_settings | 用户设置 (JSON) | 每人读写自己的 |
| avatars | 头像路径 | 每人读写自己的 |
| admins | 管理员白名单 | 已登录用户可查询自己的角色记录 |
| anime_news | 二次元资讯 | 任何人读；管理员改 |
| comments | 留言板 | 任何人读已审核；游客提交待审 |

## 环境变量

无需环境变量。Supabase anon key 位于 `js/shared.js`，属于公开客户端凭据；数据保护依赖线上数据库和 Storage 的 RLS 策略，不能依赖前端隐藏按钮。`RLS_POLICIES.sql` 是仓库内的策略参考，线上是否已应用仍需在 Supabase 核验。

`data/articles.json` 是可公开访问的降级数据，只允许 `public:true`。私密草稿保存在 Git 忽略的 `.private/articles.json`，需要单独备份，不能复制进 `data/` 或 `dist/`。项目的 `scripts/dev-server.js` 拒绝访问 `.private/` 和隐藏目录；不要用通用静态服务器直接共享项目根目录。旧提交中曾出现的正文还需单独处理 Git 历史。

## 常见故障排查

### 页面空白 / JS 报错
1. 检查 Supabase 服务状态：https://status.supabase.com
2. 检查 CSP (Content-Security-Policy)：`script-src` 是否包含所有 CDN 域名
3. `npm run lint`、`npm test`、`npm run build` → 检查资源、单元测试与产物

### Service Worker 缓存旧版本
1. 构建时 `scripts/build.js` 按静态文件内容生成缓存名，并更新 `dist/sw.js` 的预缓存清单；源码 `sw.js` 中的 `v14` 只是模板值
2. 手动清除：DevTools → Application → Service Workers → Unregister
3. 然后硬刷新 (Ctrl+Shift+R)

### BGM 不播放
- 浏览器自动播放策略要求首次用户交互后才能播放
- 首次点击页面任意位置后，_onUserInteract() 触发加载

### 壁纸不切换
- 检查 localStorage 配额是否满 (DevTools → Application → Storage)
- safeSetItem() 在配额满时静默失败

### 评论不显示
- 检查线上 `comments` 表及 RLS 策略是否已配置；仓库的 `RLS_POLICIES.sql` 不会自动部署
- 游客评论需管理员在管理面板审核

## 回滚步骤

```bash
# 1. 查看提交历史
git log --oneline -10

# 2. 回滚到指定提交（保留工作区）
git revert <commit-hash>

# 3. 或硬回滚（丢弃后续提交）
git reset --hard <commit-hash>
git push origin master --force-with-lease
```

## 关键依赖

- `marked` v18: Markdown 渲染 (CDN + vendored)
- `supabase-js` v2: 后端 SDK (CDN)
- `esbuild`: 构建打包
- `vitest`: 测试
- `playwright`: E2E 测试
