# jieneng — 个人主页

Galgame · 动漫OST · 视觉小说  /  纯静态 SPA · Supabase 后端 · GitHub Pages 部署

## 本地运行

```bash
git clone https://github.com/jieneng10/personal-site.git
cd personal-site
npm install
npm run dev        # → http://localhost:3000
```

## 命令清单

| 命令 | 作用 |
|------|------|
| `npm run dev` | 开发服务器（源码热重载） |
| `npm run build` | 生产构建 → `dist/`（esbuild tree-shaking）|
| `npm run preview` | 预览生产构建 |
| `npm test` | 31 条单元测试（vitest） |
| `npm run test:watch` | 测试监听模式 |

## 架构

```
index.html
├── classic defer scripts（IIFE 基础层，window.xxx 通信）
│   ├── shared.js       → 全局常量（已由 config.mjs 取代）
│   ├── event-bus.js    → 模块间消息总线
│   ├── cache.js        → TTL 缓存工具
│   └── supabase.js     → 后端客户端 + 工具函数
│
└── module scripts（ESM 业务层，import/export 显式依赖）
    └── main.js （入口）→

## 数据流

  用户 ──→ 浏览器（localStorage / IndexedDB）
             │
             └──→ Supabase（Auth + DB + Storage）
                    └──→ 降级: data/*.json（离线可用）

  articles： Supabase 已发布 → JSON 兜底 → 去重排序
  BGM 壁纸： 默认文件 → 云端 → IndexedDB 本地
  资讯：     缓存（1h TTL）→ Supabase → JSON（GitHub Actions 每日更新）
  评论：     游客待审核 → 管理员面板通过 → 所有人可见
```

## 技术栈

原生 HTML/CSS/JS · Supabase SDK v2 · marked v18 · esbuild · vitest · Playwright

## 项目统计

| 指标 | 数值 |
|------|------|
| JS 文件 | 17（14 ESM + 3 IIFE）|
| CSS | 4 文件 |
| 注释覆盖 | 1,461 行（18 个源文件）|
| 单元测试 | 31 条 |
| E2E 测试 | 5 条 |
| 构建产物 | 103 KB（tree-shaken ESM bundle）|
| i18n 文案 | 293 行 `zh-CN.json` |

---

# 故障排查

### 页面空白 / JS 报错

1. `npx vitest run` → 确认 31 条全部通过
2. 检查 Supabase 服务：https://status.supabase.com
3. 检查浏览器控制台是否有 CSP 拦截
4. 确认 CDN（cdn.jsdelivr.net）可访问

### Service Worker 缓存旧版本

每次构建 `sw.js` 版本号自动递增。若仍加载旧版：DevTools → Application → Service Workers → Unregister → 硬刷新 (Ctrl+Shift+R)。

### BGM 不播放

浏览器自动播放策略要求首次交互后才能播放音频。首次点击页面任意位置后自动触发。

### 评论 / 文章不显示

Supabase 不可用时自动降级到本地 JSON。若本地数据也不可用，确认 `data/articles.json`、`data/anime-news.json` 未损坏。

### 壁纸切换异常

检查 localStorage 配额：DevTools → Application → Storage。配额满时 `safeSetItem()` 静默降级。

---

# 已知隐患与改进方向

## 🟡 结构性（改一处但另一处忘了）

### 1. `shared.js` 和 `config.mjs` 内容重复

**现状**：Supabase URL/Key/DB 常量在两处重复定义。`shared.js` 挂 window，`config.mjs` export。

**风险**：改一个忘记另一个 → 两处不一致 → 隐性 bug。

**修复**（30 分钟）：删除 `shared.js`，`<script type="module" src="js/config.mjs">` 同时设 `window.SUPABASE_URL`。从此只有一处真相源。

### 2. `escHtml` 在三个文件中重复实现

**现状**：`supabase.js`、`cloud.js`、`anime-news.js` 各有一份 `escHtml`。后两者已有 `import { escHtml }`，但因为历史原因保留了自己内部 wrapper。

**风险**：若 XSS 转义规则要加（如新增一个危险字符），只改了主版本，wrapper 版本没改 → XSS 口子。

**修复**（20 分钟）：删掉 `cloud.js` 和 `anime-news.js` 中的本地 `escHtml` 函数，import 的版本直接使用。

### 3. 4 个 IIFE 基础层未转 ESM

**现状**：`shared.js`、`event-bus.js`、`cache.js`、`supabase.js` 仍是 IIFE，走 `window.xxx` 通信。`.mjs` 包装层提供 ESM re-export。

**为什么现在没做**：这 4 个文件作为 `defer` 先执行，`type="module"` 的 ESM 后执行。如果转 ESM，CDN supabase SDK 的加载时序可能被破坏。`.mjs` 包装已足够。

**修复**（2 小时，需谨慎）：逐文件转 ESM，每次转完运行 `npm run build && npm test && node driver.mjs` 验证。按风险从低到高：`cache.js` → `event-bus.js` → `shared.js` → `supabase.js`。

## 🟢 工程化

### 4. TTL 缓存常量分散

**现状**：4 个模块各自硬编码缓存时长。

| 文件 | TTL | 常量名 |
|------|-----|--------|
| `wallpaper.js` | 600,000（10 分钟）| `createCache(fn, 600000)` |
| `articles.js` | 300,000（5 分钟）| `createCache(fn, 300000)` |
| `bgm.js` | 30,000（30 秒）| `createCache(fn, 30000)` |
| `anime-news.js` | 3,600,000（1 小时）| `var CACHE_TTL_MS = 3600000` |

**风险**：想改全局缓存策略（如"所有缓存 10 分钟"）需搜 4 个文件。

**修复**（30 分钟）：`config.mjs` 新增 `export const CACHE_TTL = { … }`，各模块 `import { CACHE_TTL } from './config.mjs'`。

### 5. Playwright 双入口

**现状**：driver（`.claude/skills/run-personal-site/driver.mjs`）用 `playwright` 包，E2E（`test/e2e/`）用 `@playwright/test` 包。两个不同的 launcher。

**风险**：版本不同步、Chromium 路径冲突（本次工程中反复出现）。

**修复**（30 分钟）：driver 改用 `@playwright/test` 的 `chromium.launch()`。从 `package.json` 删 `playwright` 依赖。

### 6. 构建脚本中的冗余降级逻辑

**现状**：`scripts/build.js` 在 esbuild 成功后从不执行降级分支（复制源文件），但代码仍保留。

**修复**（5 分钟）：删除或加注释标记为 emergency-only。

## 🟢 测试

### 7. 单元测试覆盖不足

**现状**：31 条测试覆盖了 `sanitizeHtml`（16 条）和文章合并（10 条），其余模块无测试。

**缺失的关键测试**：
- `escHtml()` 输入输出验证
- `safeSetItem()` 配额满场景
- `createCache()` 并发去重
- `getTodayKey()` 6:00 前算前一天的边界

**补充**：在 `test/` 下新增 `utils.test.js`、`cache.test.js`，每份 10-15 条。

### 8. E2E 无视觉回归测试

**现状**：5 条 E2E 验证 DOM 状态（元素存在/数量），不验证视觉正确性（z-index 层叠、颜色、布局）。

**补充**：Playwright `toHaveScreenshot()` 对首页做视觉回归。

## 🟢 功能

### 9. i18n 文案仅在 1/5 模块接入

**现状**：`data/i18n/zh-CN.json` 有 293 行文案，`js/i18n.js` 有 `t()`/`tSync()`，但只有 `nav.js` 的 `sectionTitles` 实际调用。其余模块仍硬编码中文。

**为什么现在不做**：纯中文站点，把硬编码改成 `tSync()` → 输出相同中文，用户感知零差异。i18n 的价值在**加第二语言时**。

**等有第二语言需求时**：逐模块接 `t()`：
1. `settings.js`（设置标签/描述）
2. `cloud.js`（空状态/toast 消息）
3. `comments.js`（表单占位符/提示）
4. `articles.js`（骨架文字/筛选标签）

### 10. BGM 文件占用仓库 31MB

**现状**：3 首 `.mp3` 在 `bgm/` 目录，提交在 Git 中。

**为什么没移走**：当前站点完全自包含——Supabase 离线时 BGM 仍可播放。移到云端会新增故障点。对个人站点，31MB 不是实质问题。

**如果要移**：上传到 Supabase Storage `bgm` bucket → `DEFAULT_BGMS` 数组改 URL → `.gitignore` 加 `bgm/` → `git rm -r bgm/`。

---

# 提交历史

```
66da02a feat: 频谱可视化 + i18n nav接入 + 运维文档
ef76c79 fix: 构建脚本升级 ESM tree-shaking
f0d72a4 refactor: 3a-3e IIFE→ESM + CI + SW分层
c24e7f6 feat: 2b-2e 搜索结果+BGM懒加载+SEO+i18n
adc286d feat: 2a 评论系统 + 安全加固
4b569e7 docs: 业务层全部注释
a8ed7df docs: foundation层全部注释
2a75db8 refactor: 阶段1 ESM基础层+类型声明
d617b2f fix: 阶段B 18个bug修复
f0038ff build: 阶段0 开发环境+构建+测试
```

---

# 部署

推送 `master` → GitHub Pages 自动部署到 `jieneng10.github.io/personal-site/`。

GitHub Actions 北京时间每日 06:00 自动抓取二次元资讯并更新 `data/anime-news.json`。
