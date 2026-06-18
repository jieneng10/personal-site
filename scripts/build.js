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
// 2. JS 打包 — 分层策略
// ============================================================
// ① IIFE 基础层（classic scripts，通过 window.xxx 通信）
//    直接复制，在 HTML 中以 <script defer> 加载
// ② ESM 业务层（import/export，入口 js/main.js）
//    esbuild 从入口解析 import 图 → tree-shaking → bundle → 单个 .min.js
//    在 HTML 中以 <script type="module"> 加载

console.log('Building JS...');

const outDir = path.join(DIST, 'js');
fs.mkdirSync(outDir, { recursive: true });

// ─── ① IIFE foundation files（不参与 ESM bundle）───────────
const IIFE_FILES = ['shared.js', 'event-bus.js', 'cache.js', 'supabase.js', 'marked.min.js'];
for (const f of IIFE_FILES) {
  const src = path.join(ROOT, 'js', f);
  const dst = path.join(outDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
}
console.log('  ✓ IIFE foundation: ' + IIFE_FILES.join(', '));

// ─── ② ESM bundle（entry: js/main.js）──────────────────────
try {
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'js', 'main.js')],
    bundle: true,
    outfile: path.join(outDir, 'bundle.min.js'),
    minify: true,
    target: 'es2020',
    format: 'esm',
    // 这些由 IIFE classic scripts 提供，不打包进 ESM bundle
    external: IIFE_FILES.map(f => './' + f),
  });
  console.log('  ✓ ESM bundle.min.js (esbuild tree-shaking)');
} catch (e) {
  console.warn('  ⚠ esbuild 打包失败:', e.message);
  // 降级：复制所有 ESM 源文件
  const ESM_FILES = ['sakura.js','anime-news.js','articles.js','wallpaper.js','bgm.js',
                      'cloud.js','admin.js','settings.js','nav.js','main.js',
                      'config.mjs','event-bus.mjs','cache.mjs','supabase.mjs','comments.js','i18n.js'];
  for (const f of ESM_FILES) {
    const src = path.join(ROOT, 'js', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, f));
  }
  console.log('  ⚠ 降级：复制全部 ESM 源文件');
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
// 4. 更新 index.html：替换为打包后的脚本引用
// ============================================================
console.log('Updating index.html...');

let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf-8');

// 移除所有本地 JS 脚本标签（保留 CDN supabase SDK + marked）
html = html.replace(/<script src="js\/[^"]*" defer><\/script>\s*/g, '');
html = html.replace(/<script type="module" src="js\/[^"]*"><\/script>\s*/g, '');

// 构建新的脚本加载顺序
const cdnScript = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js" defer></script>';
const iifeScripts = IIFE_FILES
  .filter(f => f !== 'marked.min.js') // marked 单独处理
  .map(f => `<script src="js/${f}" defer></script>`)
  .join('\n');
const markedScript = '<script src="js/marked.min.js" defer></script>';
const esmBundle = '<script type="module" src="js/bundle.min.js"></script>';

const replacement = [cdnScript, iifeScripts, markedScript, esmBundle].join('\n');

// 替换整个脚本区块：从 CDN supabase 到 </body> 之前
html = html.replace(
  /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\/dist\/umd\/supabase\.js" defer><\/script>[\s\S]*?<\/body>/,
  replacement + '\n</body>'
);

fs.writeFileSync(path.join(DIST, 'index.html'), html);
console.log('  ✓ index.html（已替换打包引用）');

// ============================================================
// 完成
// ============================================================
console.log(`\n✨ 构建完成 → ${DIST}`);
console.log(`   启动预览: npx serve dist`);

})();
