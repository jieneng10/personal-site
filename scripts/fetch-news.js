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
 * Bilibili 热门 API — 抓取 50 条后按分区+关键词筛选。
 * 仅保留原教旨二次元：Galgame、视觉小说、动画、同人手书、GMV、ACG 音乐。
 * 排除一切抽卡/运营手游（原神/崩铁/绝区零/鸣潮/明日方舟等）。
 * 热门不足 6 条时用 WBI 搜索补量。
 *
 * 热度算法：
 *   Bilibili base = 68..78，确保与 Jikan(67-73) / AniList(58-66) 竞争，
 *   每次保证 5-6 条进入 top 16。
 */

// 搜索补充关键词（仅 popular 不足时使用）
var SEARCH_KWS = ['Galgame', 'anime'];

async function fetchBilibiliPopular() {
  var raw = await httpGet('https://api.bilibili.com/x/web-interface/popular?ps=50', {
    headers: { 'Referer': 'https://www.bilibili.com/' }
  });
  var json = JSON.parse(raw);
  var list = (json && json.data && json.data.list) || [];

  // ---- 仅保留游戏/同人/GMV 分区（排除手机游戏 tid=172）----
  var ALLOWED_TIDS = new Set([47, 121]); // 同人·手书 | GMV（自动通过）
  // tid=17(单机游戏) 需要额外验证—必须命中日系/二次元关键词
  var GAME_JP_KW = /日系|日本|anime|Anime|アニメ|Galgame|galgame|视觉小说|二次元|番|动漫|RPG|JRPG|Persona|女神|ペルソナ|Final Fantasy|ファイナルファンタジー|Dragon Quest|ドラクエ|Tales of|テイルズ|Atelier|アトリエ|無双|DMC|デビル|バイオハザード|RE:ZERO|モンハン|MH\b|かまいたち|うたわれる|ダンガンロンパ|シュタインズ|カオスヘッド|ロボティクス|ノーツ|CLANNAD|Angel Beats|Rewrite|Key\b|HIKARI|Nekonyan|Frontwing|TYPE-MOON|Nitroplus|Laplacian|MAGES|ゆず|ぱれっと|Lump|minori|CIRCUS|Navel|Palette|SAGA|八月|BALDR|グリザイア|Grisaia|9-nine|金色|白昼夢|アメイジング|グレイス|終わりの惑星|アマカノ|サノバ|千恋|RIDDLE JOKER|喫茶ステラ|Making.*Lovers|Sugar.*Style/i;
  // 额外的 anime/OST 关键词（对非标准 tid 也放行）
  var ANIME_KW = /Galgame|galgame|gal\b|GAL\b|视觉小说|アニメ|anime|Anime|动漫|番剧|二次元|OST\b|ACG|声优|新番|MAGES|Key社|柚子社|HIKARI|Nekonyan|Frontwing|八月社|minori|CIRCUS|Navel|Palette|SAGA|Nitroplus|TYPE-MOON|Laplacian|ゆず|ぱれっと|魔法少女|異世界|転生|鬼滅|呪術|SPY|チェンソーマン|葬送|フリーレン|Gundam|ガンダム|EVA|エヴァ|化物語|まどか|Steins;Gate|Fate\/stay|Fate\/hollow|Fate\/Zero|空の境界|ひぐらし|うみねこ|Rewrite|CLANNAD|AIR\b|Kanon|リトルバスターズ|planetarian|Harmonia|Summer Pockets|Angel Beats|Charlotte|リトバス|グリザイア|Grisaia|千恋万花|サノバウィッチ|RIDDLE JOKER|喫茶ステラ|アオナツライン|アマカノ|Making\*Lovers|Sugar\*Style|タマユラ|白昼夢|アメイジング|グレイス|終わりの惑星/i;
  // ---- 排除抽卡/运营手游 ----
  var GACHA_BLOCK = /原神|星穹铁道|绝区零|鸣潮|明日方舟|终末地|崩坏|Fate\/Grand|FGO|グラブル|プリコネ|ウマ娘|アズレン|ブルアカ|崩壊|スタレ|ゼンレス|鳴潮|アークナイツ|原神|ドルフロ|NIKKE|勝利の女神|学園アイドルマスター|プロセカ|ヘブバン|リバース|1999|重返未来/i;
  // ---- 泛用垃圾 ----
  var JUNK = /震惊|卧槽|不看后悔|速看|千万别|哭死|怒赞|刷爆|逆天|网暴|塌房|全网|必看|燃爆|贼爽|爽爆|夯爆|最狠|年度最佳|神作|封神|盘点|切片|合集|录播|迷你世界|蛋仔派对|我的世界|东北雨姐|蔡徐坤|抽象|猎奇|孤岛小夫|流放之路|流放2|PoE\b|DNF|地下城|吃鸡|王者荣耀|LOL\b|英雄联盟|CS:GO|瓦洛兰/i;
  var BLOCK_TAG = /国产动画|国创|动态漫画|手机游戏|電子競技|电竞|电子竞技/i;

  var filtered = list.filter(function (v) {
    if (!v || !v.title || v.title.length < 4) return false;
    var tid = v.tid || 0;
    var tname = v.tname || '';
    var title = v.title;

    // 排除垃圾标签
    if (BLOCK_TAG.test(tname)) return false;
    // 排除垃圾关键词
    if (JUNK.test(title)) return false;
    // 排除抽卡/运营手游
    if (GACHA_BLOCK.test(title)) return false;
    // 排除感叹号营销
    var exclaimCount = (title.match(/！/g) || []).length;
    if (title.length >= 12 && exclaimCount >= 2) return false;

    // 允许的分区：同人·手书/GMV 直接通过
    if (ALLOWED_TIDS.has(tid)) return true;
    // tid=17(单机游戏)：必须命中日系二次元关键词
    if (tid === 17 && GAME_JP_KW.test(title)) return true;
    // 标题命中核心二次元关键词（任何 tid）
    if (ANIME_KW.test(title)) return true;

    return false;
  });

  // ---- 按播放量排序（stat.view），确保高质量内容在前 ----
  filtered.sort(function (a, b) {
    var va = (a.stat && a.stat.view) || 0;
    var vb = (b.stat && b.stat.view) || 0;
    return vb - va;
  });

  var popItems = filtered.map(function (v, i) {
    var stat = v.stat || {};
    var view = parseInt(stat.view, 10) || 0;
    var like = parseInt(stat.like, 10) || 0;
    var heat = 68 + Math.floor(Math.min(10, Math.log10(Math.max(1, view + like * 2)) * 0.8));
    return {
      title: v.title,
      summary: (v.desc || '').replace(/\n/g, ' ').slice(0, 180),
      url: 'https://www.bilibili.com/video/' + (v.bvid || ''),
      date: todayStr(),
      source: 'Bilibili',
      heat: heat,
    };
  });

  // ---- WBI 搜索补充：popular API 二次元内容偏少，搜索补量 ----
  if (popItems.length < 6) {
    await new Promise(function (r) { setTimeout(r, 2000); }); // 延时防限流
    for (var ki = 0; ki < SEARCH_KWS.length && popItems.length < 8; ki++) {
      try {
        var kw = SEARCH_KWS[ki];
        var sUrl = 'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword='
          + encodeURIComponent(kw) + '&order=pubdate&page=1';
        var sRaw = await httpGet(sUrl, {
          headers: { 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com' }
        });
        var sJson = JSON.parse(sRaw);
        var sList = (sJson.code === 0 && sJson.data && sJson.data.result) ? sJson.data.result : [];
        var sFiltered = sList.filter(function (sv) {
          var t = (sv.title || '').replace(/<[^>]+>/g, '');
          if (!t || t.length < 4) return false;
          if (JUNK.test(t) || GACHA_BLOCK.test(t)) return false;
          if (BLOCK_TAG.test(sv.tag || '')) return false;
          return ANIME_KW.test(t) || GAME_JP_KW.test(t);
        });
        var seen = new Set(popItems.map(function (p) { return (p.title || '').slice(0, 50); }));
        sFiltered = sFiltered.filter(function (sv) {
          var k = (sv.title || '').replace(/<[^>]+>/g, '').slice(0, 50);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        var extra = sFiltered.slice(0, 3).map(function (sv) {
          var play = sv.play || 0;
          return {
            title: (sv.title || '').replace(/<[^>]+>/g, ''),
            summary: (sv.description || '').replace(/\n/g, ' ').slice(0, 180),
            url: 'https://www.bilibili.com/video/' + (sv.bvid || ''),
            date: todayStr(),
            source: 'Bilibili',
            heat: 68 + Math.floor(Math.min(10, Math.log10(Math.max(1, play)) * 0.5)),
          };
        });
        popItems = popItems.concat(extra);
        if (extra.length > 0) console.log('  [Bilibili search] \"' + kw + '\" → ' + extra.length + ' supplement items');
      } catch (e) { /* search fails silently — popular API already has the core */ }
    }
  }

  return popItems;
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
