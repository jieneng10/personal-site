/**
 * 每日二次元资讯抓取脚本
 * 从多个 RSS / JSON API 源获取最新动漫/视觉小说新闻，输出 anime-news.json
 *
 * 用法: node scripts/fetch-news.js
 * 由 GitHub Action 每日 22:00 UTC（北京时间 6:00）触发
 *
 * 数据源（共 15 个）：
 *   【英文/国际】
 *     Anime News Network (ANN) — 新闻
 *     ANN Interest        — 文化/社区
 *     Crunchyroll News    — 流媒体
 *   【日文/日本官号】
 *     ファミ通.com (Famitsu)     — 游戏/动漫综合
 *     電撃オンライン (Dengeki)   — 游戏/动漫/轻小说
 *     Moca News                  — 动漫新闻速报
 *     4Gamer                     — 游戏/ACGN
 *   【中文 RSSHub 聚合】
 *     Bilibili 热门 (via RSSHub) — B站全站热门中的动漫相关内容
 *     Bilibili 番剧 (via RSSHub) — B站新番导视
 *     Bilibili 动画区 (via RSSHub) — 动画区精选
 *     Tieba 动漫吧 (via RSSHub)  — 百度贴吧动漫吧
 *     ACG17 站 (via RSSHub)      — 动漫资讯聚合
 *   【直接 API】
 *     Bilibili 热门 API (JSON)   — 筛选动画/游戏标签
 *
 * 每个源独立抓取，失败静默跳过，不中断整体流程。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'data', 'anime-news.json');
const MAX_ITEMS = 16;
const REQUEST_TIMEOUT = 12000;

// ============================================================
// 数据源定义
// ============================================================

// RSS / XML 源（用 parseRSS 解析）
const RSS_FEEDS = [
  // ---- 英文/国际 ----
  { name: 'ANN',          url: 'https://www.animenewsnetwork.com/news/rss.xml'          },
  { name: 'ANN Interest', url: 'https://www.animenewsnetwork.com/interest/rss.xml'       },
  { name: 'Crunchyroll',  url: 'https://www.crunchyroll.com/news/rss'                    },

  // ---- 日文官号 ----
  { name: 'ファミ通',      url: 'https://www.famitsu.com/rss.xml'                         },
  { name: '電撃オンライン', url: 'https://dengekionline.com/feed/'                        },
  { name: 'Moca News',    url: 'https://moca-news.net/atom.xml'                          },
  { name: '4Gamer',       url: 'https://www.4gamer.net/rss/'                             },

  // ---- RSSHub 聚合（中文）----
  { name: 'Bilibili热门',  url: 'https://rsshub.app/bilibili/popular/all'                },
  { name: 'Bilibili番剧',  url: 'https://rsshub.app/bilibili/bangumi/calendar'           },
  { name: 'Bilibili动画区', url: 'https://rsshub.app/bilibili/vranking/1/0/3'           },  // 动画 MAD AMV 分区
  { name: 'ACG17动漫资讯',  url: 'https://rsshub.app/acg17/post'                         },
];

// JSON API 源（用 parseJSONFeed 解析）
const JSON_FEEDS = [
  {
    name: 'Bilibili API',
    url: 'https://api.bilibili.com/x/web-interface/popular?ps=30',
    opts: {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com/',
      },
    },
    parse: function (json) {
      const list = (json && json.data && json.data.list) || [];
      // 只取动画/游戏/音乐/影视相关，去生活娱乐
      const ANIME_TIDS = [1, 3, 4, 13, 24, 25, 30, 31, 32, 47, 51, 54, 136, 146, 147, 157, 158, 159, 164, 168, 170];
      const filtered = list.filter(function (v) {
        return v.tid && ANIME_TIDS.indexOf(v.tid) !== -1;
      });
      return filtered.map(function (v) {
        return {
          title: v.title || '',
          summary: (v.desc || '').slice(0, 180),
          url: 'https://www.bilibili.com/video/' + (v.bvid || ''),
          date: v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : todayStr(),
          source: 'Bilibili',
        };
      });
    },
  },
];

// ============================================================
// HTTP 请求
// ============================================================

function httpGet(url, opts) {
  return new Promise(function (resolve, reject) {
    var reqUrl = new URL(url);
    var options = {
      hostname: reqUrl.hostname,
      path: reqUrl.pathname + reqUrl.search,
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (compatible; anime-news-fetcher/1.0)',
        'Accept': 'application/json, application/rss+xml, application/atom+xml, text/xml, */*',
      }, (opts && opts.headers) || {}),
    };

    var req = https.request(options, function (res) {
      // 重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, opts).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf-8')); });
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
  // 支持 <item> 和 <entry> 两种格式
  var isAtom = /<feed[^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/i.test(xml)
    || xml.indexOf('<entry>') !== -1;

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
    items.push({
      title: decode(title.trim()),
      summary: decode(desc),
      url: xmlTag(block, 'link') || '',
      date: parseDate(xmlTag(block, 'pubDate') || xmlTag(block, 'dc:date')),
      source: xmlTag(block, 'author') || '',
    });
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
    items.push({
      title: decode(title.trim()),
      summary: decode(desc),
      url: atomLink(block) || xmlTag(block, 'id') || '',
      date: parseDate(xmlTag(block, 'updated') || xmlTag(block, 'published')),
      source: xmlTag(block, 'author') || '',
    });
  }
  return items;
}

function xmlTag(block, tag) {
  // 支持属性: <tag attr="...">...</tag> 或 <namespace:tag>...</namespace:tag>
  var re = new RegExp('<' + tag.replace(/:/g, '\\:') + '[^>]*>([\\s\\S]*?)<\\/' + tag.replace(/:/g, '\\:') + '>', 'i');
  var m = block.match(re);
  return m ? m[1].trim() : '';
}

function atomLink(block) {
  var re = /<link[^>]*href="([^"]+)"[^>]*\/?>/i;
  var m = block.match(re);
  if (m) return m[1];
  // RSSHub 格式: <link>url</link>
  return xmlTag(block, 'link');
}

// ============================================================
// JSON API 解析
// ============================================================

async function fetchJSONFeed(feedDef) {
  var raw = await httpGet(feedDef.url, feedDef.opts);
  var json = JSON.parse(raw);
  return feedDef.parse(json);
}

// ============================================================
// 工具函数
// ============================================================

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
  var cn = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
  return cn.toISOString().slice(0, 10);
}

// ============================================================
// 主流程
// ============================================================

(async function () {
  var allItems = [];

  // 1. RSS 源
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

  if (!allItems.length) {
    console.log('No items fetched — keeping existing file');
    process.exit(0);
  }

  // 去重 (首 80 字符匹配)
  var seen = new Set();
  allItems = allItems.filter(function (item) {
    var key = (item.title || '').slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 过滤无意义标题
  var skipWords = /^(广告|推广|优惠|促销|红包|福利领取|今日签到|抽奖)/;
  allItems = allItems.filter(function (item) {
    return item.title && item.title.length >= 4 && !skipWords.test(item.title);
  });

  // 按日期降序取最多条
  allItems.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  allItems = allItems.slice(0, MAX_ITEMS);

  console.log('Writing ' + allItems.length + ' items to ' + OUT_FILE);

  // 保留已有的 content 字段（管理员手写内容）
  var existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8')); } catch (e) { /* first run */ }

  allItems.forEach(function (item) {
    var old = existing.find(function (e) { return e.title === item.title; });
    if (old && old.content) item.content = old.content;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(allItems, null, 2), 'utf-8');
  console.log('Done.');
})();
