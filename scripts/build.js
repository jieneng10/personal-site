/**
 * personal-site 构建脚本
 *
 * 职责：
 *   1. 用 esbuild 打包所有 JS 模块（IIFE → 单文件 bundle）
 *   2. 扫描 dist/ 目录，自动生成 sw.js 的 ASSETS 列表
 *   3. 复制静态文件（HTML / CSS / 图片 / 音频 / 数据）
 *
 * 用法: node scripts/build.js
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

(async function() {

// ============================================================
// 0. 清理 + 建目录
// ============================================================
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });

// ============================================================
// 1. 复制静态文件（不参与打包的）
// ============================================================
const STATIC_FILES = [
  'index.html',
  'admin.html',
  'reset-password.html',
  '404.html',
  'manifest.json',
  'feed.xml',
  'data/articles.json',
  'data/anime-news.json',
  // ESM wrappers (stage 1)
  'js/config.mjs',
  'js/event-bus.mjs',
  'js/cache.mjs',
  'js/supabase.mjs',
];

const STATIC_DIRS = [
  { src: 'css',        dest: 'css' },
  { src: 'wallpapers', dest: 'wallpapers' },
  { src: 'bgm',        dest: 'bgm' },
  { src: 'images',     dest: 'images' },
];

// 复制文件
for (const file of STATIC_FILES) {
  const src = path.join(ROOT, file);
  const dest = path.join(DIST, file);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 复制目录
for (const { src, dest } of STATIC_DIRS) {
  const srcDir = path.join(ROOT, src);
  const destDir = path.join(DIST, dest);
  if (fs.existsSync(srcDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true });
  }
}

// ============================================================
// 2. JS 打包（esbuild）
// ============================================================
// 保持 IIFE 风格不分拆，入口是 main.js（它依赖其他模块的 window 导出）
// 策略：把所有 JS 文件 concat 风格打包（不解析 import/export），
//       保持原有的 IIFE + <script> 加载顺序。
//       后续阶段 1 迁移到 ES Module 后，这里改为真正的 tree-shaking bundle。

console.log('Building JS bundle...');

const JS_FILES = [
  'js/shared.js',
  'js/event-bus.js',
  'js/cache.js',
  'js/supabase.js',
  'js/marked.min.js',
  'js/sakura.js',
  'js/anime-news.js',
  'js/articles.js',
  'js/wallpaper.js',
  'js/bgm.js',
  'js/cloud.js',
  'js/admin.js',
  'js/settings.js',
  'js/nav.js',
  'js/main.js',
];

// 简单拼接（阶段 0 — 不改模块化方式，只聚合以减少请求数）
let bundle = '';
for (const file of JS_FILES) {
  const src = path.join(ROOT, file);
  if (fs.existsSync(src)) {
    let content = fs.readFileSync(src, 'utf-8');
    // 去掉 'use strict' 重复声明（每个 IIFE 顶部都有）
    content = content.replace(/^'use strict';\s*/gm, '');
    bundle += `\n// ====== ${file} ======\n` + content + '\n';
  } else {
    console.warn(`  ⚠ 跳过缺失文件: ${file}`);
  }
}

fs.mkdirSync(path.join(DIST, 'js'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'js', 'bundle.js'), bundle);
console.log(`  ✓ bundle.js (${(bundle.length / 1024).toFixed(1)} KB)`);

// 压缩版
try {
  const minResult = await esbuild.transform(bundle, {
    minify: true,
    target: 'es2020',
  });
  fs.writeFileSync(path.join(DIST, 'js', 'bundle.min.js'), minResult.code);
  console.log(`  ✓ bundle.min.js (${(minResult.code.length / 1024).toFixed(1)} KB)`);
} catch (e) {
  console.warn('  ⚠ 压缩失败（跳过）:', e.message);
}

// ============================================================
// 3. 自动生成 Service Worker ASSETS 列表
// ============================================================
console.log('Generating SW manifest...');

function scanDist(dir, base) {
  const entries = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    const full = path.join(dir, item.name);
    const rel = (base ? base + '/' : '') + item.name;
    if (item.isDirectory()) {
      entries.push(...scanDist(full, rel));
    } else {
      entries.push(rel.replace(/\\/g, '/'));
    }
  }
  return entries;
}

const allAssets = scanDist(DIST, '');
// 仅保留 bundle.min.js（构建产物），排除 bundle.js（开发调试用）
const assetList = allAssets
  .filter(function(f) { return f !== 'js/bundle.js'; })
  .map(function(f) { return `  '/personal-site/${f}'`; })
  .join(',\n');

// 读取 sw.js 模板
const swSrc = path.join(ROOT, 'sw.js');
let swContent = fs.readFileSync(swSrc, 'utf-8');

// 替换 ASSETS 数组
const assetsRegex = /var ASSETS = \[[\s\S]*?\];/;
const newAssets = `var ASSETS = [\n${assetList}\n];`;

if (assetsRegex.test(swContent)) {
  swContent = swContent.replace(assetsRegex, newAssets);
} else {
  console.warn('  ⚠ 未找到 ASSETS 数组，请手动检查 sw.js');
}

// 自增核心缓存和媒体缓存的版本号
swContent = swContent.replace(
  /var CACHE_CORE = 'ps-core-v(\d+)'/,
  (_, ver) => `var CACHE_CORE = 'ps-core-v${parseInt(ver) + 1}'`
);
swContent = swContent.replace(
  /var CACHE_MEDIA = 'ps-media-v(\d+)'/,
  (_, ver) => `var CACHE_MEDIA = 'ps-media-v${parseInt(ver) + 1}'`
);

fs.writeFileSync(path.join(DIST, 'sw.js'), swContent);
console.log(`  ✓ sw.js (版本号已递增)`);

// ============================================================
// 4. 更新 index.html：将 <script> 标签替换为打包引用
// ============================================================
console.log('Updating index.html...');

let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf-8');

// 移除所有本地 JS <script> 标签（保留 CDN supabase SDK）
html = html.replace(
  /<script src="js\/(?!marked\.min\.js)[^"]*" defer><\/script>\s*/g,
  ''
);
// 替换 marked.min.js 引用
html = html.replace(
  /<script src="js\/marked\.min\.js" defer><\/script>/,
  ''
);

// 在 supabase CDN 之后插入 bundle
const insertAfter = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js" defer></script>';
html = html.replace(
  insertAfter,
  insertAfter + '\n<script src="js/bundle.min.js" defer></script>'
);

fs.writeFileSync(path.join(DIST, 'index.html'), html);
console.log('  ✓ index.html（已替换为 bundle 引用）');

// ============================================================
// 完成
// ============================================================
console.log(`\n✨ 构建完成 → ${DIST}`);
console.log(`   启动预览: npx serve dist`);

})();
