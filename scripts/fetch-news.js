/**
 * 每日二次元资讯抓取脚本 v2
 * 从多个 RSS / JSON API 源获取最新动漫/视觉小说新闻，输出 anime-news.json
 *
 * 用法: node scripts/fetch-news.js
 * 由 GitHub Action 每日 22:00 UTC（北京时间 6:00）触发
 *
 * v2 改进:
 *   - 所有 HTTP 请求使用浏览器 UA，避免 403 屏蔽
 *   - 超时统一延长到 25s（RSSHub 需要更长时间）
 *   - 优先使用 RSSHub 路由（从 GitHub Actions 美国机房稳定访问）
 *   - 安全闸：现有被置顶/有正文内容的条目不会被默认覆盖
 *   - 结果数过少时（<2）不覆盖已有数据，避免丢失手工策划内容
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'data', 'anime-news.json');
const MAX_ITEMS = 16;
const REQUEST_TIMEOUT = 25000; // 25s — RSSHub 有时需要更久

// 浏览器 User-Agent（避免被当作机器人拦截）
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 热度计算关键词
const HOT_WORDS = [
  '重磅', '独家', '发表', '発表', '新作', '正式', '定档', '发售', '上线',
  'breaking', 'exclusive', 'reveal', 'announce', 'PV', 'trailer',
  '突破', '达成', '里程碑', '百万', '十万',
  '联动', 'コラボ', 'collab',
];

// ============================================================
// 数据源定义
// ============================================================

/**
 * 混合数据源 — GitHub Actions 跑在美国机房，直连海外源比 RSSHub 更稳定。
 * 优先直连，无法直连的用 RSSHub 路由。
 */
const RSS_FEEDS = [
  // ---- 英文/国际（直连 — 美国机房可通）----
  { name: 'ANN',            url: 'https://www.animenewsnetwork.com/news/rss.xml' },
  { name: 'ANN Interest',   url: 'https://www.animenewsnetwork.com/interest/rss.xml' },
  { name: 'Crunchyroll',    url: 'https://www.crunchyroll.com/news/rss' },

  // ---- 日文（直连）----
  { name: 'ファミ通',        url: 'https://www.famitsu.com/feed/' },
  { name: '4Gamer',         url: 'https://www.4gamer.net/rss/' },
  { name: 'Moca News',      url: 'https://moca-news.net/article/feed.xml' },

  // ---- 中文（RSSHub 备用）----
  { name: 'Bilibili番剧',    url: 'https://rsshub.app/bilibili/bangumi/calendar' },
];

/**
 * JSON API 源（不需要 RSSHub）。
 */
const JSON_FEEDS = [
  {
    name: 'Bilibili热门',
    url: 'https://api.bilibili.com/x/web-interface/popular?ps=30',
    parse: function (json) {
      const list = (json && json.data && json.data.list) || [];
      // 只保留动画/游戏/音乐/番剧相关分区
      const ANIME_TIDS = [1, 3, 4, 13, 24, 25, 30, 31, 32, 47, 51, 54, 136, 146, 147, 157, 158, 159, 164, 168, 170];
      const filtered = list.filter(function (v) {
        if (!v || !v.tid) return false;
        if (ANIME_TIDS.indexOf(v.tid) === -1) return false;
        // 过滤低质量标题
        if (!v.title || v.title.length < 6) return false;
        var title = v.title.toLowerCase();
        var junk = /迷你世界|营销号|震惊|卧槽|不看后悔|速看/i;
        return !junk.test(title);
      });
      return filtered.map(function (v) {
        var playCount = v.stat ? (v.stat.view || 0) : 0;
        var likeCount = v.stat ? (v.stat.like || 0) : 0;
        var engagement = playCount + likeCount * 3;
        var heat = Math.min(100, Math.floor(Math.log10(engagement + 1) * 10));
        return {
          title: v.title,
          summary: (v.desc || '').replace(/\n/g, ' ').slice(0, 180),
          url: 'https://www.bilibili.com/video/' + (v.bvid || ''),
          date: todayStr(),
          source: 'Bilibili',
          heat: heat,
        };
      });
    },
  },
];

// ============================================================
// HTTP 请求
// ============================================================

/**
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
function httpGet(url, opts) {
  return new Promise(function (resolve, reject) {
    var reqUrl;
    try { reqUrl = new URL(url); } catch (e) { return reject(new Error('Invalid URL: ' + url)); }

    var protocol = reqUrl.protocol === 'https:' ? https : http;
    var options = {
      hostname: reqUrl.hostname,
      path: reqUrl.pathname + reqUrl.search,
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
      headers: Object.assign({
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json, application/rss+xml, application/atom+xml, text/xml, text/html, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
      }, (opts && opts.headers) || {}),
    };

    var req = protocol.request(options, function (res) {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, opts).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        // 消耗响应体以释放连接
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf-8')); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ============================================================
// RSS / XML 解析
// ============================================================

function parseRSS(xml, sourceName) {
  var items = [];
  var isAtom = xml.indexOf('<feed') !== -1 && xml.indexOf('xmlns="http://www.w3.org/2005/Atom"') !== -1;

  if (isAtom) {
    items = parseAtom(xml);
  } else {
    items = parseRSS2(xml);
  }

  items.forEach(function (item) { item.source = item.source || sourceName; });
  return items;
}

function parseRSS2(xml) {
  var items = [];
  var itemRe = /<item>([\s\S]*?)<\/item>/gi;
  var match;
  while ((match = itemRe.exec(xml)) !== null) {
    var block = match[1];
    var title = xmlTag(block, 'title');
    if (!title) continue;
    var desc = (xmlTag(block, 'description') || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    items.push(buildItem(
      decode(title.trim()),
      decode(desc),
      xmlTag(block, 'link') || '',
      xmlTag(block, 'pubDate') || xmlTag(block, 'dc:date') || '',
      xmlTag(block, 'author') || ''
    ));
  }
  return items;
}

function parseAtom(xml) {
  var items = [];
  var entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  var match;
  while ((match = entryRe.exec(xml)) !== null) {
    var block = match[1];
    var title = xmlTag(block, 'title');
    if (!title) continue;
    var desc = (xmlTag(block, 'summary') || xmlTag(block, 'content') || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    items.push(buildItem(
      decode(title.trim()),
      decode(desc),
      atomLink(block) || xmlTag(block, 'id') || '',
      xmlTag(block, 'updated') || xmlTag(block, 'published') || '',
      xmlTag(block, 'author') || ''
    ));
  }
  return items;
}

// ---- 统一定义条目 + 热度计算 ----
function buildItem(title, summary, url, dateStr, source) {
  var heat = Math.min(20, Math.floor(summary.length / 20));
  var kwBoost = 0;
  var text = (title + ' ' + summary).toLowerCase();
  HOT_WORDS.forEach(function (w) {
    if (text.indexOf(w.toLowerCase()) !== -1) kwBoost += 3;
  });
  heat += Math.min(30, kwBoost);
  heat += Math.min(10, Math.floor(title.length / 4));
  heat = Math.max(1, Math.min(90, heat));
  return {
    title: title,
    summary: summary,
    url: url,
    date: parseDate(dateStr),
    source: source || '',
    heat: heat,
  };
}

function xmlTag(block, tag) {
  var escaped = tag.replace(/:/g, '\\:');
  var re = new RegExp('<' + escaped + '[^>]*>([\\s\\S]*?)<\\/' + escaped + '>', 'i');
  var m = block.match(re);
  return m ? m[1].trim() : '';
}

function atomLink(block) {
  var re = /<link[^>]*href="([^"]+)"[^>]*\/?>/i;
  var m = block.match(re);
  if (m) return m[1];
  return xmlTag(block, 'link');
}

function decode(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
}

function parseDate(str) {
  if (!str) return todayStr();
  try { var d = new Date(str); return isNaN(d.getTime()) ? todayStr() : d.toISOString().slice(0, 10); }
  catch (e) { return todayStr(); }
}

function todayStr() {
  var now = new Date();
  var cn = new Date(now.getTime() - now.getTimezoneOffset() * 60000 + 8 * 3600000);
  return cn.toISOString().slice(0, 10);
}

// ============================================================
// JSON API 解析
// ============================================================

async function fetchJSONFeed(feedDef) {
  var raw = await httpGet(feedDef.url, { headers: { 'Referer': 'https://www.bilibili.com/' } });
  var json = JSON.parse(raw);
  return feedDef.parse(json);
}

// ============================================================
// 主流程
// ============================================================

(async function () {
  var allItems = [];

  // 1. RSS 源（每个源独立 try/catch，失败静默跳过）
  for (var i = 0; i < RSS_FEEDS.length; i++) {
    var feed = RSS_FEEDS[i];
    try {
      console.log('[RSS] ' + feed.name + '...');
      var xml = await httpGet(feed.url);
      var items = parseRSS(xml, feed.name);
      console.log('  → ' + items.length + ' items');
      allItems = allItems.concat(items);
    } catch (e) {
      console.warn('  ✗ ' + feed.name + ': ' + e.message);
    }
  }

  // 2. JSON API 源
  for (var j = 0; j < JSON_FEEDS.length; j++) {
    var jf = JSON_FEEDS[j];
    try {
      console.log('[JSON] ' + jf.name + '...');
      var jitems = await fetchJSONFeed(jf);
      console.log('  → ' + jitems.length + ' items');
      allItems = allItems.concat(jitems);
    } catch (e) {
      console.warn('  ✗ ' + jf.name + ': ' + e.message);
    }
  }

  // ---- 安全闸 1: 没有抓到任何内容 → 保留现有文件 ----
  if (!allItems.length) {
    console.log('No items fetched — keeping existing file unchanged');
    process.exit(0);
  }

  // ---- 读取旧文件 ----
  var existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8')); } catch (e) { /* first run */ }

  // 旧文件中的置顶条目
  var pinnedItems = existing.filter(function (e) { return e.pinned; });
  // 保留管理员手写正文
  pinnedItems.forEach(function (p) {
    var match = existing.find(function (e) { return e.title === p.title; });
    if (match && match.content) p.content = match.content;
  });

  // ---- 去重 (首 80 字符) ----
  var seen = new Set();
  allItems = allItems.filter(function (item) {
    var key = (item.title || '').slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ---- 过滤垃圾 ----
  var skipWords = /^(广告|推广|优惠|促销|红包|福利|签到|抽奖)/;
  allItems = allItems.filter(function (item) {
    return item.title && item.title.length >= 4 && !skipWords.test(item.title);
  });

  // ---- 保留已有的 content / pinned 字段 ----
  allItems.forEach(function (item) {
    var old = existing.find(function (e) { return e.title === item.title; });
    if (old && old.content) item.content = old.content;
    if (old && old.pinned) item.pinned = true;
  });

  // ---- 热度排序 ----
  allItems.sort(function (a, b) {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    if ((a.heat || 0) !== (b.heat || 0)) return (b.heat || 0) - (a.heat || 0);
    return (b.date || '').localeCompare(a.date || '');
  });

  // ---- 截断: MAX_ITEMS 条，置顶不占配额 ----
  var result = [];
  var nonPinnedCount = 0;
  var nonPinnedMax = MAX_ITEMS - pinnedItems.length;
  for (var i = 0; i < allItems.length; i++) {
    if (allItems[i].pinned) {
      result.push(allItems[i]);
    } else if (nonPinnedCount < nonPinnedMax) {
      result.push(allItems[i]);
      nonPinnedCount++;
    }
  }

  // ---- 安全闸 2: 抓取结果太少（<2）且有现有数据 → 不覆盖 ----
  // 防止 Bilibili 单个垃圾条目覆盖手工策划的精美数据
  if (nonPinnedCount < 2 && existing.length > 1) {
    console.log('Only ' + nonPinnedCount + ' non-pinned items fetched — keeping existing file ('
      + existing.length + ' items) to avoid data regression');
    process.exit(0);
  }

  console.log(
    'Writing ' + result.length + ' items (' + pinnedItems.length +
    ' pinned, ' + nonPinnedCount + ' ranked) to ' + OUT_FILE
  );

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
  console.log('Done.');
})();
