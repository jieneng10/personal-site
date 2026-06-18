# personal-site — 运维手册

## 项目概览

jieneng 的个人主页 — 纯静态 SPA，Supabase 后端，GitHub Pages 部署。

## 本地开发

```bash
npm run dev        # 启动开发服务器 → http://localhost:3000
npm run build      # 生产构建 → dist/
npm run preview    # 预览生产构建
npm test           # 单元测试 (31 条)
npm run test:watch # 监听模式
```

## 部署流程

1. `git push origin master` → GitHub Pages 自动部署
2. GitHub Actions 每日 06:00 (北京时间) 抓取资讯 → 自动推送 `data/anime-news.json`
3. CI (`ci.yml`) 每次 push 运行测试 + 构建验证

### 手动触发资讯抓取
GitHub → Actions → "Daily Anime News" → "Run workflow"

## 架构

```
index.html  ──→  classic scripts (IIFE)     ← window.xxx 全局通信
             ├──  shared.js  (常量)
             ├──  event-bus.js (消息总线)
             ├──  cache.js   (TTL 缓存)
             └──  supabase.js (客户端 + 工具函数)
             ──→  ESM bundle (tree-shaken)   ← import/export 显式依赖
                  entry: main.js
```

- **经典脚本**：IIFE 基础层，通过 `window.xxx` 暴露 API
- **ESM bundle**：esbuild 从 `main.js` 入口 tree-shake 打包
- **数据**：Supabase (articles/user_files/comments) → localStorage 缓存 → JSON 兜底

## Supabase 表

| 表 | 用途 | RLS |
|----|------|-----|
| articles | 文章 | 任何人读已发布；管理员增删改 |
| user_files | 壁纸/BGM/云盘文件 | 分层策略见 RLS_POLICIES.sql |
| user_settings | 用户设置 (JSON) | 每人读写自己的 |
| avatars | 头像路径 | 每人读写自己的 |
| admins | 管理员白名单 | 仅管理员可查 |
| anime_news | 二次元资讯 | 任何人读；管理员改 |
| comments | 留言板 | 任何人读已审核；游客提交待审 |

## 环境变量

无需环境变量。Supabase anon key 硬编码在 `js/shared.js` 中（公开，安全）。

## 常见故障排查

### 页面空白 / JS 报错
1. 检查 Supabase 服务状态：https://status.supabase.com
2. 检查 CSP (Content-Security-Policy)：`script-src` 是否包含所有 CDN 域名
3. `npx vitest run` → 确认单元测试全部通过

### Service Worker 缓存旧版本
1. `sw.js` 版本号每次构建自动递增
2. 手动清除：DevTools → Application → Service Workers → Unregister
3. 然后硬刷新 (Ctrl+Shift+R)

### BGM 不播放
- 浏览器自动播放策略要求首次用户交互后才能播放
- 首次点击页面任意位置后，_onUserInteract() 触发加载

### 壁纸不切换
- 检查 localStorage 配额是否满 (DevTools → Application → Storage)
- safeSetItem() 在配额满时静默失败

### 评论不显示
- Supabase 不可用时会显示"请登录后查看留言"
- 游客评论需管理员在 admin 面板审核

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

## 项目统计

- 17 个 JS 文件 (14 ESM + 3 IIFE 基础)
- 4 个 CSS 文件
- 31 项单元测试
- 5 条 E2E 测试
- 101.9 KB tree-shaken bundle
- 293 行 i18n 文案
