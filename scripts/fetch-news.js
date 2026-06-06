/**
 * 每日二次元资讯抓取脚本
 * 从 RSS 源获取最新动漫/视觉小说新闻，输出 anime-news.json
 *
 * 用法: node scripts/fetch-news.js
 * 由 GitHub Action 每日 22:00 UTC（北京时间 6:00）触发
 *
 * 数据源：
 *   1. Anime News Network (ANN) — 英文
 *   2. ANN Interest — 文化/社区
 *   3. Crunchyroll News — 流媒体
 * 失败时保留已有文件不变。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'data', 'anime-news.json');
const MAX_ITEMS = 12;
const REQUEST_TIMEOUT = 15000;

// ---- 资讯源列表 ----
const FEEDS = [
  { name: 'ANN', url: 'https://www.animenewsnetwork.com/news/rss.xml' },
  { name: 'ANN Interest', url: 'https://www.animenewsnetwork.com/interest/rss.xml' },
  { name: 'Crunchyroll', url: 'https://www.crunchyroll.com/news/rss' },
];

// ---- HTTP GET 封装 ----
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: REQUEST_TIMEOUT }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---- 简易 XML RSS 解析（不依赖第三方库）----
function parseRSS(xml) {
  const items = [];
  // 匹配 <item>...</item> 块
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const description = extractTag(block, 'description');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    // CR 用 media:group
    const thumbnail = extractMediaThumbnail(block);

    if (!title) continue;

    // 清理 HTML 标签
    const summary = (description || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

    items.push({
      title: decodeEntities(title.trim()),
      summary: decodeEntities(summary),
      url: link ? link.trim() : '',
      date: pubDate ? normalizeDate(pubDate) : todayStr(),
      source: extractSource(block)
    });
  }
  return items;
}

function extractTag(block, tag) {
  // 支持 <tag>...</tag> 和 <tag attr="...">...</tag>
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  return m[1].trim();
}

function extractMediaThumbnail(block) {
  const re = /<media:thumbnail[^>]*url="([^"]+)"/i;
  const m = block.match(re);
  return m ? m[1] : null;
}

function extractSource(block) {
  // 尝试从 source/@url 获取
  const re = /<source[^>]*url="([^"]+)"[^>]*>([^<]*)<\/source>/i;
  const m = block.match(re);
  if (m) return m[2].trim();
  return '';
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function normalizeDate(str) {
  try {
    const d = new Date(str);
    if (isNaN(d.getTime())) return todayStr();
    return d.toISOString().slice(0, 10);
  } catch (e) { return todayStr(); }
}

function todayStr() {
  // 北京时间
  const now = new Date();
  const cn = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
  return cn.toISOString().slice(0, 10);
}

// ---- 主流程 ----
(async () => {
  let allItems = [];

  for (const feed of FEEDS) {
    try {
      console.log(`Fetching ${feed.name}...`);
      const xml = await httpGet(feed.url);
      const items = parseRSS(xml);
      console.log(`  → got ${items.length} items`);
      // 标记来源
      items.forEach((item) => { item.source = item.source || feed.name; });
      allItems = allItems.concat(items);
    } catch (e) {
      console.warn(`  ✗ ${feed.name} failed: ${e.message}`);
    }
  }

  if (!allItems.length) {
    console.log('No items fetched — keeping existing file');
    process.exit(0);
  }

  // 去重 by title（取最新）
  const seen = new Set();
  allItems = allItems.filter((item) => {
    const key = item.title.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 按日期降序，截取
  allItems.sort((a, b) => b.date.localeCompare(a.date));
  allItems = allItems.slice(0, MAX_ITEMS);

  console.log(`Writing ${allItems.length} items to ${OUT_FILE}`);

  // 保留已有 content 字段（管理员手写内容）
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8')); } catch (e) {}

  allItems.forEach((item) => {
    const old = existing.find((e) => e.title === item.title);
    if (old && old.content) item.content = old.content;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(allItems, null, 2), 'utf-8');
  console.log('Done.');
})();
