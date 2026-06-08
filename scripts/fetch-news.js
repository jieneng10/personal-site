/**
 * 每日二次元资讯抓取脚本 v3
 * 从多个全球可达的 API 获取动漫/视觉小说新闻，输出 anime-news.json
 *
 * 用法: node scripts/fetch-news.js
 * 由 GitHub Action 每日 22:00 UTC（北京时间 6:00）触发
 *
 * v3 策略:
 *   - 放弃 RSS 抓取（全部被 Cloudflare 拦截，RSSHub 也从 GHA 超时）
 *   - 改用全球可达的 JSON API：AniList GraphQL + Jikan v4 + Bilibili
 *   - 安全闸：抓取 < 2 条时不覆盖已有数据
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'data', 'anime-news.json');
const MAX_ITEMS = 16;
const REQUEST_TIMEOUT = 15000;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ============================================================
// HTTP helpers
// ============================================================

/**
 * GET a URL and return the body as string.
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
function httpGet(url, opts) {
  return new Promise(function (resolve, reject) {
    var reqUrl;
    try { reqUrl = new URL(url); } catch (e) { return reject(new Error('Invalid URL')); }

    var protocol = reqUrl.protocol === 'https:' ? https : http;
    var options = {
      hostname: reqUrl.hostname,
      path: reqUrl.pathname + reqUrl.search,
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
      headers: Object.assign({
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json, text/plain, */*',
      }, (opts && opts.headers) || {}),
    };

    var req = protocol.request(options, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpGet(res.headers.location, opts).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf-8')); });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * POST JSON to a URL and return the body as string.
 */
function httpPost(url, body, opts) {
  return new Promise(function (resolve, reject) {
    var reqUrl;
    try { reqUrl = new URL(url); } catch (e) { return reject(new Error('Invalid URL')); }

    var protocol = reqUrl.protocol === 'https:' ? https : http;
    var postData = JSON.stringify(body);
    var options = {
      hostname: reqUrl.hostname,
      path: reqUrl.pathname + reqUrl.search,
      method: 'POST',
      timeout: REQUEST_TIMEOUT,
      headers: Object.assign({
        'User-Agent': BROWSER_UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      }, (opts && opts.headers) || {}),
    };

    var req = protocol.request(options, function (res) {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf-8')); });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

// ============================================================
// Data sources (all JSON APIs — no RSS parsing needed)
// ============================================================

/**
 * AniList GraphQL — trending anime (current season).
 * https://anilist.gitbook.io/anilist-apiv2-docs
 * Globally accessible, no API key needed.
 */
async function fetchAniListTrending() {
  var query = {
    query: `query {
      Page(page:1, perPage:8) {
        media(sort:TRENDING_DESC, type:ANIME, status:RELEASING, isAdult:false) {
          title { romaji english native }
          description
          siteUrl
          startDate { year month day }
          genres
          averageScore
        }
      }
    }`
  };

  var raw = await httpPost('https://graphql.anilist.co', query);
  var data = JSON.parse(raw);
  var media = ((data.data || {}).Page || {}).media || [];

  return media.map(function (m) {
    // Prefer English title, fall back to romaji, then native
    var title = m.title.english || m.title.romaji || m.title.native || '';
    // If using English/romaji, note the native title in summary
    var nativeNote = (m.title.native && m.title.native !== title && m.title.english)
      ? ' / ' + m.title.native : '';
    var desc = (m.description || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    var genres = (m.genres || []).slice(0, 3).join(' · ');
    var score = m.averageScore ? ' ⭐' + m.averageScore + '%' : '';
    var summary = nativeNote + ' | ' + genres + ' | ' + desc;
    var date = [m.startDate.year, String(m.startDate.month || 1).padStart(2,'0'), String(m.startDate.day || 1).padStart(2,'0')].join('-');

    return {
      title: title + score,
      summary: summary,
      url: m.siteUrl || 'https://anilist.co',
      date: date,
      source: 'AniList',
      // 用 AniList 平均评分计算热度，范围 ~45-75，与 Jikan 可比
      heat: Math.floor((m.averageScore || 60) * 0.75),
    };
  });
}

/**
 * AniList GraphQL — upcoming & highly anticipated.
 */
async function fetchAniListUpcoming() {
  var query = {
    query: `query {
      Page(page:1, perPage:5) {
        media(sort:POPULARITY_DESC, type:ANIME, status:NOT_YET_RELEASED, isAdult:false) {
          title { romaji english native }
          description
          siteUrl
          startDate { year month day }
          genres
        }
      }
    }`
  };

  var raw = await httpPost('https://graphql.anilist.co', query);
  var data = JSON.parse(raw);
  var media = ((data.data || {}).Page || {}).media || [];

  return media.map(function (m) {
    var title = m.title.english || m.title.romaji || m.title.native || '';
    var nativeNote = (m.title.native && m.title.native !== title && m.title.english)
      ? ' / ' + m.title.native : '';
    var desc = (m.description || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    var genres = (m.genres || []).slice(0, 3).join(' · ');
    var date = [m.startDate.year, String(m.startDate.month || 1).padStart(2,'0'), String(m.startDate.day || 1).padStart(2,'0')].join('-');

    return {
      title: '即将开播：' + title,
      summary: nativeNote + ' | ' + genres + ' | ' + desc,
      url: m.siteUrl || 'https://anilist.co',
      date: date,
      source: 'AniList',
      // 未开播无评分，用描述丰富度 + 题材数估算热度，范围 30–55
      heat: Math.max(30, Math.min(55, 30 + (m.genres || []).length * 5 + Math.floor(desc.length / 20))),
    };
  });
}

/**
 * Jikan API v4 — top anime (MAL data).
 * https://docs.api.jikan.moe
 * Only includes anime from 2024+ to avoid listing classics like One Piece (1999).
 */
async function fetchJikanTop() {
  var raw = await httpGet('https://api.jikan.moe/v4/top/anime?limit=10&filter=airing');
  var data = JSON.parse(raw);
  var list = (data.data || []);

  // Filter out anime that started before 2024
  var currentYear = new Date().getFullYear();
  var minYear = currentYear - 2; // 2024+
  list = list.filter(function (a) {
    var fromYear = a.aired && a.aired.from ? parseInt((a.aired.from || '').slice(0, 4)) : 0;
    return fromYear >= minYear;
  });

  return list.slice(0, 6).map(function (a) {
    var genres = (a.genres || []).map(function (g) { return g.name; }).slice(0, 3).join(' · ');
    var title = a.title_english || a.title || '';
    var summary = 'MAL 评分 ' + (a.score || '?') + ' | ' + genres + ' | ' + (a.synopsis || '').replace(/\[.*?\]/g, '').slice(0, 150);
    return {
      title: title,
      summary: summary,
      url: a.url || 'https://myanimelist.net',
      date: (a.aired || {}).from ? (a.aired.from || '').slice(0, 10) : todayStr(),
      source: 'MyAnimeList',
      heat: Math.min(90, Math.floor((a.score || 6) * 8)),
    };
  });
}

/**
 * Bilibili 搜索 API — 按日文二次元关键词抓取。
 * 排行榜 API 已全面要求 WBI 签名（-352），故换用搜索 API。
 * 关键词选 Galgame / anime / 二次元OST 避免国产动漫污染。
 */
async function fetchBilibiliSearch(keyword, sourceLabel, maxItems) {
  // 普通搜索 API 已全线 412，改用 WBI 搜索端点（无需签名即可用）
  var url = 'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword='
    + encodeURIComponent(keyword) + '&order=pubdate&page=1';
  var raw = await httpGet(url, {
    headers: { 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com' }
  });
  var json = JSON.parse(raw);
  if (json.code !== 0) throw new Error('Bilibili search API returned code ' + json.code);
  var list = (json.data && json.data.result) || [];

  // ---- 质量过滤 ----
  var junk = /震惊|卧槽|不看后悔|速看|千万别|哭死|怒赞|刷爆|逆天|网暴|塌房|全网|必看|燃爆|贼爽|爽爆|夯爆|最狠|年度最佳|神作|封神/i;
  var blockTag = /国产动画|国创|国产|动态漫画|东北雨姐|蔡徐坤|科比|抽象|猎奇|迷你世界|蛋仔派对|我的世界/i;
  var blockTitle = /盘点|切片|合集|录播/i;

  var filtered = list.filter(function (v) {
    if (!v.title || v.title.length < 4) return false;
    var t = v.title.replace(/<[^>]+>/g, '');
    var tag = v.tag || '';
    // 排除垃圾标签
    if (blockTag.test(tag)) return false;
    // 排除录播/切片
    if (blockTitle.test(t)) return false;
    // 排除营销号
    var exclaimCount = (t.match(/！/g) || []).length;
    if (t.length >= 12 && exclaimCount >= 2) return false;
    if (junk.test(t)) return false;
    return true;
  });

  return filtered.slice(0, maxItems).map(function (v) {
    var play = v.play || 0;
    var danmaku = v.danmaku || 0;
    var pubdate = v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : todayStr();
    return {
      title: v.title.replace(/<[^>]+>/g, ''),
      summary: (v.description || '').replace(/\n/g, ' ').slice(0, 180),
      url: 'https://www.bilibili.com/video/' + (v.bvid || ''),
      date: pubdate,
      source: sourceLabel,
      heat: Math.min(85, Math.floor(Math.log10(Math.max(1, play + danmaku)) * 10)),
    };
  });
}

/**
 * Bilibili — 搜索 Galgame + anime 两个关键词聚合。
 */
async function fetchBilibiliPopular() {
  var results = [];

  var queries = [
    { kw: 'Galgame',      label: 'Bilibili', max: 2 },
    { kw: 'anime',        label: 'Bilibili', max: 3 },
  ];

  for (var i = 0; i < queries.length; i++) {
    try {
      var items = await fetchBilibiliSearch(queries[i].kw, queries[i].label, queries[i].max);
      results = results.concat(items);
    } catch (e) {
      console.warn('  ✗ Bilibili search \"' + queries[i].kw + '\": ' + e.message);
    }
    // 搜索 API 两次连续请求会触发 412，间隔 1.5s
    if (i < queries.length - 1) await new Promise(function (r) { setTimeout(r, 1500); });
  }

  return results;
}

// ============================================================
// Utility
// ============================================================

function todayStr() {
  var now = new Date();
  var cn = new Date(now.getTime() + 8 * 3600000);
  return cn.toISOString().slice(0, 10);
}

function parseDate(str) {
  if (!str) return todayStr();
  var d = new Date(str);
  return isNaN(d.getTime()) ? todayStr() : d.toISOString().slice(0, 10);
}

// ============================================================
// Main
// ============================================================

(async function () {
  var allItems = [];

  // ---- Fetch all sources in parallel (each fails independently) ----
  var fetchers = [
    { name: 'AniList Trending', fn: fetchAniListTrending },
    { name: 'AniList Upcoming', fn: fetchAniListUpcoming },
    { name: 'Jikan Top',        fn: fetchJikanTop },
    { name: 'Bilibili热门',      fn: fetchBilibiliPopular },
  ];

  for (var i = 0; i < fetchers.length; i++) {
    try {
      console.log('[' + fetchers[i].name + '] fetching...');
      var items = await fetchers[i].fn();
      console.log('  → ' + items.length + ' items');
      allItems = allItems.concat(items);
    } catch (e) {
      console.warn('  ✗ ' + fetchers[i].name + ': ' + e.message);
    }
  }

  // ---- Safety gate: 0 items → keep existing file ----
  if (!allItems.length) {
    console.log('No items fetched — keeping existing file unchanged');
    process.exit(0);
  }

  // ---- Load existing file ----
  var existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8')); } catch (e) {}

  // 管理员手写条目（有 content 或 pinned）始终保留
  var curatedItems = existing.filter(function (e) { return e.content || e.pinned; });
  // 保留其完整字段（content, pinned 等）
  var otherExisting = existing.filter(function (e) { return !e.content && !e.pinned; });

  // ---- Dedup by title (first 60 chars) ----
  // 标准化标题：去评分后缀 + 转小写，避免 AniList/Jikan 同名不同源重复
  function dedupKey(title) {
    return (title || '').replace(/ ⭐\d+%/, '').trim().toLowerCase().slice(0, 60);
  }
  var seen = new Set();
  curatedItems.forEach(function (item) {
    seen.add(dedupKey(item.title));
  });
  allItems = allItems.filter(function (item) {
    var key = dedupKey(item.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ---- Filter garbage ----
  var skipRe = /^(广告|推广|优惠|促销|红包|福利|签到|抽奖)/;
  allItems = allItems.filter(function (item) {
    return item.title && item.title.length >= 3 && !skipRe.test(item.title);
  });

  // ---- Preserve existing content/pinned fields ----
  allItems.forEach(function (item) {
    var old = existing.find(function (e) { return e.title === item.title; });
    if (old && old.content) item.content = old.content;
    if (old && old.pinned) item.pinned = true;
  });

  // ---- Normalise dates ----
  allItems.forEach(function (item) {
    item.date = parseDate(item.date);
  });

  // ---- Sort: heat descending (pinned/curated handled separately) ----
  allItems.sort(function (a, b) {
    if ((a.heat || 0) !== (b.heat || 0)) return (b.heat || 0) - (a.heat || 0);
    return (b.date || '').localeCompare(a.date || '');
  });

  // ---- Assembly: curated → new items ----
  // Curated items (admin-written content or pinned) always come first,
  // followed by new API-sourced items.
  var result = curatedItems.concat(allItems);
  // Cap at MAX_ITEMS (keep all curated even if it exceeds)
  if (result.length > MAX_ITEMS) {
    var curatedCount = curatedItems.length;
    // Trim non-curated tail
    result = result.slice(0, Math.max(MAX_ITEMS, curatedCount));
  }

  // ---- Safety gate: too few new items + existing data → don't overwrite ----
  var newItemCount = result.length - curatedItems.length;
  if (newItemCount < 1 && existing.length > 1 && curatedItems.length === existing.length) {
    console.log(
      'No new items fetched — keeping existing file (' +
      existing.length + ' items) unchanged'
    );
    process.exit(0);
  }

  console.log(
    'Writing ' + result.length + ' items (' + curatedItems.length +
    ' curated, ' + newItemCount + ' new) to ' + OUT_FILE
  );

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
  console.log('Done.');
})();
