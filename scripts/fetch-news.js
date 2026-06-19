/**
 * 每日二次元资讯抓取脚本 v8
 * 从多个全球可达的 API 获取动漫/视觉小说新闻，输出 anime-news.json
 *
 * 用法:
 *   node scripts/fetch-news.js           正常抓取 + 写文件
 *   node scripts/fetch-news.js --dry-run 试跑：分类日志 + 盲区输出，不写文件
 * 由 GitHub Action 每日 22:00 UTC（北京时间 6:00）触发
 *
 * v7 新增：
 *   - 种子关键词 JSON 化（data/seed-keywords.json）
 *   - --dry-run 模式 + 盲区日志（data/no-match-log.json）
 *   - 源健康监控（data/source-health.json）
 *
 * v8 新增（P1）：
 *   - 种子词命中率追踪（data/seed-stats.json）— dead keywords + top blockers
 *   - 关键词试用期（watch_exclude → 7d 观察 → 自动升级/移除）
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'data', 'anime-news.json');
const BANK_FILE = path.join(__dirname, '..', 'data', 'keyword-bank.json');
const MAX_ITEMS = 16;
const REQUEST_TIMEOUT = 15000;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ============================================================
// v8: v7 所有功能 + P1 种子词命中追踪 + 试用期
// ============================================================

var SEED_FILE = path.join(__dirname, '..', 'data', 'seed-keywords.json');
var HEALTH_FILE = path.join(__dirname, '..', 'data', 'source-health.json');
var NOMATCH_FILE = path.join(__dirname, '..', 'data', 'no-match-log.json');
var STATS_FILE = path.join(__dirname, '..', 'data', 'seed-stats.json');
var WATCH_FILE = path.join(__dirname, '..', 'data', 'watch-log.json');
var DRY_RUN = process.argv.includes('--dry-run');

var S;  // seed data shorthand
try {
  S = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
} catch (e) {
  console.error('FATAL: Cannot load ' + SEED_FILE + ': ' + e.message);
  process.exit(1);
}

// 模块级种子变量（替代原来的函数内硬编码）
var SEARCH_KWS = S.SEARCH_KWS;
var SEED_ALLOWED_TIDS = new Set(S.SEED_ALLOWED_TIDS);
var SEED_BLOCK_TIDS = new Set(S.SEED_BLOCK_TIDS);
var _GAME_JP = S.SEED_GAME_JP;
var _ANIME = S.SEED_ANIME;
var _GACHA = S.SEED_GACHA;
var _JUNK = S.SEED_JUNK;
var _BLOCK_TAG = S.SEED_BLOCK_TAG;
// v8 P1: 试用期关键词
var _WATCH = S.watch_exclude || [];
var _WATCH_SAFE = new Set(S.watch_safe || []);

// 盲区收集器
var noMatchTitles = [];
// 源健康：本轮各源产出
var sourceCounts = {};
// v8 P1: 种子词命中 + 试用期追踪
var bilibiliTitles = [];
var seedHitCounts = {};
var watchMatches = [];

if (DRY_RUN) console.log('[dry-run] 试跑模式 — 不写入文件，输出分类日志\n');

// ============================================================
// HTTP helpers
// ============================================================

function httpGet(url, opts) {
  return new Promise(function (resolve, reject) {
    var reqUrl;
    try { reqUrl = new URL(url); } catch (e) { return reject(new Error('Invalid URL')); }
    var protocol = reqUrl.protocol === 'https:' ? https : http;
    var options = {
      hostname: reqUrl.hostname, path: reqUrl.pathname + reqUrl.search,
      method: 'GET', timeout: REQUEST_TIMEOUT,
      headers: Object.assign({
        'User-Agent': BROWSER_UA, 'Accept': 'application/json, text/plain, */*',
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

function httpPost(url, body, opts) {
  return new Promise(function (resolve, reject) {
    var reqUrl;
    try { reqUrl = new URL(url); } catch (e) { return reject(new Error('Invalid URL')); }
    var protocol = reqUrl.protocol === 'https:' ? https : http;
    var postData = JSON.stringify(body);
    var options = {
      hostname: reqUrl.hostname, path: reqUrl.pathname + reqUrl.search,
      method: 'POST', timeout: REQUEST_TIMEOUT,
      headers: Object.assign({
        'User-Agent': BROWSER_UA, 'Content-Type': 'application/json',
        'Accept': 'application/json', 'Content-Length': Buffer.byteLength(postData),
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
// Keyword Bank — 自动学习反馈系统（含失控防护）
// ============================================================

/** @const {number} 硬上限 — 超过时 LRU 淘汰最旧的关键词 */
var BANK_MAX_INCLUDE = 150;
var BANK_MAX_EXCLUDE = 100;
/** @const {number} 首次发现后的存活天数（未被再次提名则淘汰） */
var BANK_TTL_INCLUDE_DAYS = 60;
/** @const {number} 排除词 TTL — 比 include 短，因为垃圾词变化更快 */
var BANK_TTL_EXCLUDE_DAYS = 30;
/** @const {number} 被重新提名的次数 ≥ 此值时变黏性 — 不再因 TTL 淘汰 */
var BANK_STICKY_THRESHOLD = 3;

/**
 * 加载关键词库。
 * v3 格式: { include: [{w, ts, n}], exclude: [{w, ts, n}] }
 *   w = keyword, ts = YYYY-MM-DD, n = nomination count（每次重提名+1）
 * v2 兼容: {w, ts} → 自动加 n=0
 * v1 兼容: [str] → 自动迁移
 */
function loadKeywordBank() {
  var bank = { include: [], exclude: [] };
  try { bank = JSON.parse(fs.readFileSync(BANK_FILE, 'utf-8')); } catch (e) {}
  bank.include = bank.include || [];
  bank.exclude = bank.exclude || [];

  // v1 兼容 → v3
  if (bank.include.length > 0 && typeof bank.include[0] === 'string') {
    bank.include = bank.include.map(function (w) { return { w: w, ts: todayStr(), n: 0 }; });
  }
  if (bank.exclude.length > 0 && typeof bank.exclude[0] === 'string') {
    bank.exclude = bank.exclude.map(function (w) { return { w: w, ts: todayStr(), n: 0 }; });
  }

  // v2 兼容 → v3（补 n 字段）
  bank.include.forEach(function (e) { if (e.n === undefined) e.n = 0; });
  bank.exclude.forEach(function (e) { if (e.n === undefined) e.n = 0; });

  // TTL 淘汰：黏性词(n≥STICKY)永不因时间淘汰，非黏性词按 TTL 分别处理
  var incCutoff = daysAgo(BANK_TTL_INCLUDE_DAYS);
  var excCutoff = daysAgo(BANK_TTL_EXCLUDE_DAYS);
  bank.include = bank.include.filter(function (e) {
    return e.n >= BANK_STICKY_THRESHOLD || e.ts >= incCutoff;
  });
  bank.exclude = bank.exclude.filter(function (e) {
    return e.n >= BANK_STICKY_THRESHOLD || e.ts >= excCutoff;
  });

  return bank;
}

/** 提取纯关键词列表（w 字段） */
function bankWords(entries) {
  return entries.map(function (e) { return e.w; });
}

/** 从通过的条目标签中找出已在 bank 中但被重新观察到的词 — 用于刷新 ts+n */
function discoverReobserved(entries, passedItems) {
  var wordSet = new Set(entries.map(function (e) { return e.w.toLowerCase(); }));
  var reobserved = new Set();
  passedItems.forEach(function (item) {
    extractTags(item._rawTag || '').forEach(function (t) {
      var lc = t.toLowerCase();
      if (wordSet.has(lc)) reobserved.add(t);
    });
  });
  return Array.from(reobserved);
}

/** 追加单词（刷新已有词的 ts+n，新词添加到尾部 n=0） */
function bankUpsert(entries, newWords) {
  var today = todayStr();
  var map = {};
  entries.forEach(function (e, i) { map[e.w.toLowerCase()] = i; });
  newWords.forEach(function (w) {
    var lc = w.toLowerCase();
    if (map[lc] !== undefined) {
      var idx = map[lc];
      entries[idx].ts = today;
      entries[idx].n = (entries[idx].n || 0) + 1;  // 再提名计数 +1
    } else {
      entries.push({ w: w, ts: today, n: 0 });
    }
  });
}

/** 保存关键词库 — 排序 + 淘汰超量 + 清理冲突 */
function saveKeywordBank(bank) {
  if (DRY_RUN) return;  // dry-run 不写任何文件

  var today = todayStr();

  // 去重 + 合并 n（保留最大的 n，保留最新的 ts）
  function mergeDupEntry(a, b) {
    return { w: a.w, ts: a.ts > b.ts ? a.ts : b.ts, n: Math.max(a.n || 0, b.n || 0) };
  }
  var incMap = {};
  bank.include.forEach(function (e) {
    var lc = e.w.toLowerCase();
    incMap[lc] = incMap[lc] ? mergeDupEntry(incMap[lc], e) : e;
  });
  bank.include = Object.values(incMap).sort(function (a, b) { return b.ts.localeCompare(a.ts); });

  var excMap = {};
  bank.exclude.forEach(function (e) {
    var lc = e.w.toLowerCase();
    excMap[lc] = excMap[lc] ? mergeDupEntry(excMap[lc], e) : e;
  });
  bank.exclude = Object.values(excMap).sort(function (a, b) { return b.ts.localeCompare(a.ts); });

  // include 优先于 exclude（同时在两边的从 exclude 移除）
  var incSet = new Set(bank.include.map(function (e) { return e.w.toLowerCase(); }));
  bank.exclude = bank.exclude.filter(function (e) { return !incSet.has(e.w.toLowerCase()); });

  // 硬上限淘汰：优先淘汰非黏性 + 最旧的词（LRU with sticky protection）
  function lruEvict(list, max) {
    if (list.length <= max) return list;
    // 排序：非黏性优先淘汰，同条件下最旧优先
    var sorted = list.map(function (e, i) { return { e: e, i: i }; });
    sorted.sort(function (a, b) {
      var aSticky = (a.e.n || 0) >= BANK_STICKY_THRESHOLD ? 1 : 0;
      var bSticky = (b.e.n || 0) >= BANK_STICKY_THRESHOLD ? 1 : 0;
      if (aSticky !== bSticky) return aSticky - bSticky; // 非黏性排前面（先淘汰）
      return a.e.ts.localeCompare(b.e.ts); // 同优先级比时间，旧的排前面
    });
    var toRemove = sorted.slice(0, list.length - max);
    var kept = sorted.slice(list.length - max);
    var removed = toRemove.map(function (x) { return x.e; });
    // 按原始顺序重建
    var keptSet = new Set(kept.map(function (x) { return x.i; }));
    var newList = [];
    list.forEach(function (e, i) { if (keptSet.has(i)) newList.push(e); });
    // 报告
    console.log('  [bank] LRU evicted ' + removed.length + ' (non-sticky=' +
      removed.filter(function (e) { return (e.n || 0) < BANK_STICKY_THRESHOLD; }).length +
      ', sticky=' + removed.filter(function (e) { return (e.n || 0) >= BANK_STICKY_THRESHOLD; }).length + '): ' +
      removed.map(function (e) { return e.w + '(n=' + (e.n || 0) + ')'; }).join(', '));
    return newList;
  }
  bank.include = lruEvict(bank.include, BANK_MAX_INCLUDE);
  bank.exclude = lruEvict(bank.exclude, BANK_MAX_EXCLUDE);

  // TTL 过期（黏性词豁免）
  var incCutoff = daysAgo(BANK_TTL_INCLUDE_DAYS);
  var excCutoff = daysAgo(BANK_TTL_EXCLUDE_DAYS);
  bank.include = bank.include.filter(function (e) {
    return (e.n || 0) >= BANK_STICKY_THRESHOLD || e.ts >= incCutoff;
  });
  bank.exclude = bank.exclude.filter(function (e) {
    return (e.n || 0) >= BANK_STICKY_THRESHOLD || e.ts >= excCutoff;
  });

  fs.writeFileSync(BANK_FILE, JSON.stringify(bank, null, 2), 'utf-8');
}

/** 关键词数组 → 正则 alternation（仅用于学习词，种子词单独构造） */
function kwToRegex(list) {
  if (!list.length) return null;
  var escaped = list.map(function (w) {
    return String(w).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  });
  return new RegExp(escaped.join('|'), 'i');
}

/** 种子关键词 → 正则（短 ASCII 词自动加边界防误匹配） */
function seedsToRegex(list) {
  if (!list.length) return null;
  var B = '(?:^|[\\s\\W])';  // 词前边界（字符串开头 / 空白 / 非单词字符）
  var E = '(?:$|[\\s\\W])';  // 词后边界
  var escaped = list.map(function (w) {
    var s = String(w).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    // 短 ASCII 词 ≤3 字符加边界，避免 "Key" 匹配 "keyboard"（JS \b 对中文无效）
    if (s.length <= 3 && /^[a-zA-Z0-9]+$/.test(s)) s = B + s + E;
    return s;
  });
  return new RegExp(escaped.join('|'), 'i');
}

/** 合并多个 regex（返回 null 或复合正则） */
function joinRegex(regexes) {
  var parts = [];
  regexes.forEach(function (r) {
    if (r) parts.push(r.source);
  });
  if (!parts.length) return null;
  return new RegExp(parts.join('|'), 'i');
}

/** 从 Bilibili 逗号分隔标签中提取候选词 */
function extractTags(tagStr) {
  if (!tagStr) return [];
  return tagStr.split(/,|，/).map(function (t) { return t.trim(); }).filter(function (t) {
    if (t.length < 2) return false;
    if (/^\d+$/.test(t)) return false;
    if (/^(原创|剧情|游戏|推荐|日常|搞笑|可爱|热门|最新|高清|完整|全集|实况|解说|攻略)$/i.test(t)) return false;
    return true;
  });
}

function looksJapanese(word) {
  return /[぀-ゟ゠-ヿ]/.test(word) || /[一-鿿]/.test(word);
}

function looksLikeProperNoun(word) {
  if (word.length < 3) return false;
  // 排除分区名/分类名（这些是 Bilibili 系统标签，不是内容关键词）
  if (/^(单机游戏|手机游戏|电子竞技|同人|GMV|日常|翻唱|演奏|舞蹈|影视|综艺|搞笑|美食|动物|知识|资讯|娱乐|生活|音乐|时尚|数码|纪录片|电影|电视剧)$/i.test(word)) return false;
  if (looksJapanese(word)) return true;
  if (/^[a-zA-Z].*[a-zA-Z]$/.test(word) && word.length >= 4
      && !/^(the|and|for|with|from|this|that|your|into|over|some|what|more|than|about|there|their|could|would|should)$/i.test(word)) return true;
  return false;
}

/** 从通过的条目中发现新的 include 关键词 */
function discoverIncludeKeywords(passedItems, bank) {
  var existSet = new Set(bankWords(bank.include).map(function (k) { return k.toLowerCase(); }));
  var candidates = {};
  passedItems.forEach(function (item) {
    extractTags(item._rawTag || '').forEach(function (t) {
      if (!looksLikeProperNoun(t)) return;
      var lc = t.toLowerCase();
      if (existSet.has(lc)) return;
      candidates[lc] = (candidates[lc] || 0) + 1;
    });
  });
  return Object.keys(candidates).filter(function (k) { return candidates[k] >= 2; });
}

/** 从被拒绝的条目中发现新的 exclude 关键词。
 *  仅学习标题中的专有名词（≥3 次出现才纳入），完全不学标签——
 * 因为标签不可靠：标记 "galgame" 的视频可能因其他原因（标题含垃圾词）被拒。 */
function discoverExcludeKeywords(rejectedItems, bank) {
  var existSet = new Set(bankWords(bank.exclude).map(function (k) { return k.toLowerCase(); }));
  var candidates = {};
  rejectedItems.forEach(function (item) {
    var words = (item.title || '').split(/\s+/);
    words.forEach(function (w) {
      w = w.replace(/^[【\[「『]|[\]】」』.,;:：；，。!！?？、\\)(（\-—\-_]$/g, '').trim();
      if (w.length < 3) return;
      var lc = w.toLowerCase();
      if (existSet.has(lc)) return;
      if (!looksLikeProperNoun(w)) return;
      candidates[lc] = (candidates[lc] || 0) + 1;
    });
    // 标签不纳入 exclude 学习——太容易误杀（见注）
  });
  // 要求 ≥3 次出现才纳入 exclude（include 只需 ≥2，exclude 更保守）
  return Object.keys(candidates).filter(function (k) { return candidates[k] >= 3; });
}

/**
 * 冲突解决：如果同一个词被 include 和 exclude 同时提名，优先归 include。
 * 在 saveKeywordBank 之前调用。
 */
function resolveConflicts(bank, incCandidates, excCandidates) {
  var overlap = new Set();
  (excCandidates || []).forEach(function (w) {
    var lc = w.toLowerCase();
    if ((incCandidates || []).some(function (iw) { return iw.toLowerCase() === lc; })) {
      overlap.add(w);
    }
  });
  return (excCandidates || []).filter(function (w) { return !overlap.has(w); });
}

function reportBankChanges(label, addedInclude, addedExclude) {
  if (addedInclude.length) console.log('  + include (' + label + ', ' + addedInclude.length + '): ' + addedInclude.join(', '));
  if (addedExclude.length) console.log('  - exclude (' + label + ', ' + addedExclude.length + '): ' + addedExclude.join(', '));
  if (!addedInclude.length && !addedExclude.length) console.log('  (no new keywords learned this run)');
}

// ============================================================
// Data sources
// ============================================================

async function fetchAniListTrending() {
  var query = {
    query: 'query { Page(page:1, perPage:3) { media(sort:TRENDING_DESC, type:ANIME, status:RELEASING, isAdult:false) { title { romaji english native } description siteUrl startDate { year month day } genres averageScore } } }'
  };
  var raw = await httpPost('https://graphql.anilist.co', query);
  var data = JSON.parse(raw);
  var media = ((data.data || {}).Page || {}).media || [];
  return media.map(function (m) {
    var title = m.title.english || m.title.romaji || m.title.native || '';
    var nativeNote = (m.title.native && m.title.native !== title && m.title.english) ? ' / ' + m.title.native : '';
    var desc = (m.description || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    var genres = (m.genres || []).slice(0, 3).join(' · ');
    var score = m.averageScore ? ' ⭐' + m.averageScore + '%' : '';
    var date = [m.startDate.year, String(m.startDate.month || 1).padStart(2,'0'), String(m.startDate.day || 1).padStart(2,'0')].join('-');
    return {
      title: title + score,
      summary: nativeNote + ' | ' + genres + ' | ' + desc,
      url: m.siteUrl || 'https://anilist.co',
      date: date,
      source: 'AniList',
      heat: Math.floor((m.averageScore || 60) * 0.75),
    };
  });
}

async function fetchAniListUpcoming() {
  var query = {
    query: 'query { Page(page:1, perPage:2) { media(sort:POPULARITY_DESC, type:ANIME, status:NOT_YET_RELEASED, isAdult:false) { title { romaji english native } description siteUrl startDate { year month day } genres } } }'
  };
  var raw = await httpPost('https://graphql.anilist.co', query);
  var data = JSON.parse(raw);
  var media = ((data.data || {}).Page || {}).media || [];
  return media.map(function (m) {
    var title = m.title.english || m.title.romaji || m.title.native || '';
    var nativeNote = (m.title.native && m.title.native !== title && m.title.english) ? ' / ' + m.title.native : '';
    var desc = (m.description || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    var genres = (m.genres || []).slice(0, 3).join(' · ');
    var date = [m.startDate.year, String(m.startDate.month || 1).padStart(2,'0'), String(m.startDate.day || 1).padStart(2,'0')].join('-');
    return {
      title: '即将开播：' + title,
      summary: nativeNote + ' | ' + genres + ' | ' + desc,
      url: m.siteUrl || 'https://anilist.co',
      date: date,
      source: 'AniList',
      heat: Math.max(30, Math.min(55, 30 + (m.genres || []).length * 5 + Math.floor(desc.length / 20))),
    };
  });
}

async function fetchJikanTop() {
  var raw = await httpGet('https://api.jikan.moe/v4/top/anime?limit=10&filter=airing');
  var data = JSON.parse(raw);
  var list = (data.data || []);
  var currentYear = new Date().getFullYear();
  var minYear = currentYear - 2;
  list = list.filter(function (a) {
    var fromYear = a.aired && a.aired.from ? parseInt((a.aired.from || '').slice(0, 4)) : 0;
    return fromYear >= minYear;
  });
  return list.slice(0, 3).map(function (a) {
    var genres = (a.genres || []).map(function (g) { return g.name; }).slice(0, 3).join(' · ');
    var title = a.title_english || a.title || '';
    return {
      title: title,
      summary: 'MAL 评分 ' + (a.score || '?') + ' | ' + genres + ' | ' + (a.synopsis || '').replace(/\[.*?\]/g, '').slice(0, 150),
      url: a.url || 'https://myanimelist.net',
      date: (a.aired || {}).from ? (a.aired.from || '').slice(0, 10) : todayStr(),
      source: 'MyAnimeList',
      heat: Math.min(90, Math.floor((a.score || 6) * 8)),
    };
  });
}

// ============================================================
// Bilibili source（含关键词反馈学习 + dry-run 分类日志）
// ============================================================

async function fetchBilibiliPopular() {
  var bank = loadKeywordBank();

  // ---- 合并种子词（从 data/seed-keywords.json 加载）+ 学习词 → 正则 ----
  var learnedInc = bankWords(bank.include);
  var learnedExc = bankWords(bank.exclude);
  var GAME_JP_KW   = joinRegex([seedsToRegex(_GAME_JP), kwToRegex(learnedInc)]);
  var ANIME_KW     = joinRegex([seedsToRegex(_ANIME), kwToRegex(learnedInc)]);
  var GACHA_BLOCK  = joinRegex([seedsToRegex(_GACHA), kwToRegex(learnedExc)]);
  var JUNK         = joinRegex([seedsToRegex(_JUNK), kwToRegex(learnedExc)]);
  var BLOCK_TAG_RE = joinRegex([seedsToRegex(_BLOCK_TAG), kwToRegex(learnedExc)]);
  var WATCH_RE = buildWatchRegex();

  // ---- 拉取数据 ----
  var raw = await httpGet('https://api.bilibili.com/x/web-interface/popular?ps=50', {
    headers: { 'Referer': 'https://www.bilibili.com/' }
  });
  var json = JSON.parse(raw);
  var list = (json && json.data && json.data.list) || [];

  // ---- 分类过滤：pass / reject + 原因（用于学习）----
  var passed = [];
  var rejected = [];
  var biliNoMatch = []; // 本轮盲区

  list.forEach(function (v) {
    if (!v || !v.title || v.title.length < 4) return;
    var tid = v.tid || 0;
    var tname = v.tname || '';
    var title = v.title;
    bilibiliTitles.push(title);

    // WATCH — v8 P1: 试用期关键词，只记录不拦截
    checkWatchMatch(title, DRY_RUN);

    // 分区黑名单
    if (SEED_BLOCK_TIDS.has(tid))                         { rejected.push({ title: title, _rawTag: tname, reason: 'block_tid' }); if (DRY_RUN) console.log('  [block:tid]  ' + title.slice(0, 60)); return; }
    if (BLOCK_TAG_RE && BLOCK_TAG_RE.test(tname))         { rejected.push({ title: title, _rawTag: tname, reason: 'block_tag' }); if (DRY_RUN) console.log('  [block:tag]  ' + title.slice(0, 60)); return; }
    if (JUNK && JUNK.test(title))                          { rejected.push({ title: title, _rawTag: tname, reason: 'junk' }); if (DRY_RUN) console.log('  [block:junk] ' + title.slice(0, 60)); return; }
    if (GACHA_BLOCK && GACHA_BLOCK.test(title))            { rejected.push({ title: title, _rawTag: tname, reason: 'gacha' }); if (DRY_RUN) console.log('  [block:gacha] ' + title.slice(0, 60)); return; }
    var exclaimCount = (title.match(/！/g) || []).length;
    if (title.length >= 12 && exclaimCount >= 2)           { rejected.push({ title: title, _rawTag: tname, reason: 'exclaim' }); if (DRY_RUN) console.log('  [block:!!!!] ' + title.slice(0, 60)); return; }

    // 二游二次检查 — 描述/分区名中含抽卡/氪金/体力等手游模式词不放行
    var desc = (v.desc || '').slice(0, 300);
    var gachaSignal = (GACHA_BLOCK && GACHA_BLOCK.test(desc)) ||
                      (GACHA_BLOCK && GACHA_BLOCK.test(tname));
    if (gachaSignal)                                       { rejected.push({ title: title, _rawTag: tname, reason: 'gacha_desc' }); if (DRY_RUN) console.log('  [block:gacha*] ' + title.slice(0, 60)); return; }

    if (SEED_ALLOWED_TIDS.has(tid))                        { passed.push({ title: title, _rawTag: tname }); if (DRY_RUN) console.log('  [pass:tid]   ' + title.slice(0, 60)); return; }
    if (tid === 17 && GAME_JP_KW && GAME_JP_KW.test(title)) {
      if (GACHA_BLOCK && GACHA_BLOCK.test(desc))           { rejected.push({ title: title, _rawTag: tname, reason: 'gacha_desc' }); if (DRY_RUN) console.log('  [block:gacha*] ' + title.slice(0, 60)); return; }
      passed.push({ title: title, _rawTag: tname }); if (DRY_RUN) console.log('  [pass:game]  ' + title.slice(0, 60)); return;
    }
    if (ANIME_KW && ANIME_KW.test(title)) {
      if (GACHA_BLOCK && GACHA_BLOCK.test(desc))           { rejected.push({ title: title, _rawTag: tname, reason: 'gacha_desc' }); if (DRY_RUN) console.log('  [block:gacha*] ' + title.slice(0, 60)); return; }
      passed.push({ title: title, _rawTag: tname }); if (DRY_RUN) console.log('  [pass:anime] ' + title.slice(0, 60)); return;
    }

    // no_match — 穿透所有规则
    biliNoMatch.push(title);
    if (DRY_RUN) console.log('  [no_match]   ' + title.slice(0, 60));
  });

  // 收集盲区到全局
  noMatchTitles = noMatchTitles.concat(biliNoMatch);

  // ---- 关键词反馈学习 ----
  var newInclude = discoverIncludeKeywords(passed, bank);
  var rejectedForLearning = rejected.filter(function (r) { return r.reason === 'junk' || r.reason === 'gacha' || r.reason === 'gacha_desc' || r.reason === 'block_tid'; });
  var newExclude0 = discoverExcludeKeywords(rejectedForLearning, bank);
  var newExclude = resolveConflicts(bank, newInclude, newExclude0);

  var reobsInc = discoverReobserved(bank.include, passed);
  var reobsExc = discoverReobserved(bank.exclude, rejectedForLearning);

  var allInc = newInclude.concat(reobsInc);
  var allExc = newExclude.concat(reobsExc);

  if (allInc.length || allExc.length) {
    var oldIncSet = new Set(bankWords(bank.include).map(function (k) { return k.toLowerCase(); }));
    var oldExcSet = new Set(bankWords(bank.exclude).map(function (k) { return k.toLowerCase(); }));
    bankUpsert(bank.include, allInc);
    bankUpsert(bank.exclude, allExc);
    saveKeywordBank(bank);
    var netInc = bankWords(bank.include).filter(function (k) { return !oldIncSet.has(k.toLowerCase()); });
    var netExc = bankWords(bank.exclude).filter(function (k) { return !oldExcSet.has(k.toLowerCase()); });
    reportBankChanges('Bilibili popular', netInc, netExc);
  }

  // ---- 重建 filtered 列表 ----
  var passedTitles = new Set(passed.map(function (p) { return p.title; }));
  var filtered = list.filter(function (v) { return passedTitles.has(v.title); });
  filtered.sort(function (a, b) {
    var va = (a.stat && a.stat.view) || 0;
    var vb = (b.stat && b.stat.view) || 0;
    return vb - va;
  });

  var popItems = filtered.map(function (v) {
    var stat = v.stat || {};
    var view = parseInt(stat.view, 10) || 0;
    var like = parseInt(stat.like, 10) || 0;
    var heat = Math.floor(Math.log10(Math.max(1, view + like * 2)) * 14) + 12;
    heat = Math.min(80, Math.max(42, heat));
    return {
      title: v.title,
      summary: (v.desc || '').replace(/\n/g, ' ').slice(0, 180),
      url: 'https://www.bilibili.com/video/' + (v.bvid || ''),
      date: todayStr(),
      source: 'Bilibili',
      heat: heat,
    };
  });

  // ---- WBI 搜索补充 + 学习 ----
  if (popItems.length < 6) {
    await new Promise(function (r) { setTimeout(r, 2000); });
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

        var sPassed = []; var sRejected = []; var sNoMatch = [];
        sList.forEach(function (sv) {
          var t = (sv.title || '').replace(/<[^>]+>/g, '');
          if (!t || t.length < 4) return;
          var stag = sv.tag || '';
          var sdesc = (sv.description || '').slice(0, 300);
          bilibiliTitles.push(t);
          checkWatchMatch(t, DRY_RUN);
          if (BLOCK_TAG_RE && BLOCK_TAG_RE.test(stag))  { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'block_tag' }); return; }
          if (JUNK && JUNK.test(t))                     { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'junk' }); return; }
          if (GACHA_BLOCK && GACHA_BLOCK.test(t))       { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'gacha' }); return; }
          var sgachaSignal = GACHA_BLOCK && (GACHA_BLOCK.test(sdesc) || GACHA_BLOCK.test(stag));
          if (ANIME_KW && ANIME_KW.test(t)) {
            if (sgachaSignal) { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'gacha_desc' }); return; }
            sPassed.push({ title: t, _rawTag: stag, _rawDesc: sdesc, _url: 'https://www.bilibili.com/video/' + (sv.bvid||''), _view: sv.play || 0 }); return;
          }
          if (GAME_JP_KW && GAME_JP_KW.test(t)) {
            if (sgachaSignal) { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'gacha_desc' }); return; }
            sPassed.push({ title: t, _rawTag: stag, _rawDesc: sdesc, _url: 'https://www.bilibili.com/video/' + (sv.bvid||''), _view: sv.play || 0 }); return;
          }
          sNoMatch.push(t);
        });
        noMatchTitles = noMatchTitles.concat(sNoMatch);

        // 学习
        var sNewInc = discoverIncludeKeywords(sPassed, bank);
        var sNewExc0 = discoverExcludeKeywords(sRejected.filter(function(r){return r.reason==='junk'||r.reason==='gacha'||r.reason==='gacha_desc';}), bank);
        var sNewExc = resolveConflicts(bank, sNewInc, sNewExc0);
        var sReobsInc = discoverReobserved(bank.include, sPassed);
        var sReobsExc = discoverReobserved(bank.exclude, sRejected.filter(function(r){return r.reason==='junk'||r.reason==='gacha'||r.reason==='gacha_desc';}));
        var sAllInc = sNewInc.concat(sReobsInc);
        var sAllExc = sNewExc.concat(sReobsExc);
        if (sAllInc.length || sAllExc.length) {
          var oldIncS = new Set(bankWords(bank.include).map(function (k) { return k.toLowerCase(); }));
          var oldExcS = new Set(bankWords(bank.exclude).map(function (k) { return k.toLowerCase(); }));
          bankUpsert(bank.include, sAllInc);
          bankUpsert(bank.exclude, sAllExc);
          saveKeywordBank(bank);
          var netInc = bankWords(bank.include).filter(function (k) { return !oldIncS.has(k.toLowerCase()); });
          var netExc = bankWords(bank.exclude).filter(function (k) { return !oldExcS.has(k.toLowerCase()); });
          reportBankChanges('Bilibili search "' + kw + '"', netInc, netExc);
        }

        // 去重后补充
        var seen = new Set(popItems.map(function (p) { return (p.title || '').slice(0, 50); }));
        sPassed = sPassed.filter(function (p) {
          var k = p.title.slice(0, 50);
          if (seen.has(k)) return false; seen.add(k); return true;
        });
        var extra = sPassed.slice(0, 3).map(function (p) {
          return {
            title: p.title,
            summary: (p._rawDesc || '').replace(/\n/g, ' ').slice(0, 180),
            url: p._url || ('https://search.bilibili.com/all?keyword=' + encodeURIComponent(kw)),
            date: todayStr(),
            source: 'Bilibili',
            heat: Math.floor(Math.log10(Math.max(1, p._view || 1000)) * 14) + 12 || 50,
          };
        });
        popItems = popItems.concat(extra);
        if (extra.length > 0) console.log('  [Bilibili search] "' + kw + '" → ' + extra.length + ' supplement items');
      } catch (e) { /* silent */ }
    }
  }

  return popItems;
}

// ============================================================
// v7: 源健康监控
// ============================================================

function updateSourceHealth(counts) {
  var today = todayStr();
  var health = [];
  try { health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8')); } catch (e) {}
  if (!Array.isArray(health)) health = [];

  // 移除超过 30 天的记录
  var cutoff = daysAgo(30);
  health = health.filter(function (h) { return h.date >= cutoff; });

  // 追加今日记录
  health.push({ date: today, counts: counts });

  // 计算 7 天滑动均值并输出
  var recent = health.filter(function (h) { return h.date >= daysAgo(7); });
  var sources = ['AniList Trending', 'AniList Upcoming', 'Jikan Top', 'Bilibili热门'];
  console.log('\n[health] Source health (' + recent.length + ' days of data):');
  sources.forEach(function (src) {
    var todayVal = counts[src] || 0;
    var vals = recent.map(function (h) { return (h.counts && h.counts[src]) || 0; });
    var avg = vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length).toFixed(1) : '?';
    var trend = todayVal < avg * 0.5 ? ' ⚠ below normal' : todayVal < avg * 0.75 ? ' ↓' : ' →';
    console.log('  ' + src + ': ' + todayVal + ' (avg ' + avg + ')' + trend);

    // 连续两日低于 50% 告警
    if (vals.length >= 2) {
      var lastTwo = vals.slice(-2);
      if (lastTwo[0] < avg * 0.5 && lastTwo[1] < avg * 0.5) {
        console.warn('  ⚠ ' + src + ' consecutive low — check API availability');
      }
    }
  });

  if (!DRY_RUN) {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2), 'utf-8');
  }
}

// ============================================================
// v7: 盲区日志
// ============================================================

function writeNoMatchLog() {
  var today = todayStr();
  var log = {};
  try { log = JSON.parse(fs.readFileSync(NOMATCH_FILE, 'utf-8')); } catch (e) {}
  if (!log || typeof log !== 'object') log = {};

  // 清理 7 天前的记录
  var cutoff = daysAgo(7);
  Object.keys(log).forEach(function (d) { if (d < cutoff) delete log[d]; });

  // 写入今日盲区（去重，最多 50 条）
  var unique = [];
  var seen = new Set();
  noMatchTitles.forEach(function (t) {
    var k = t.slice(0, 60).toLowerCase();
    if (!seen.has(k)) { seen.add(k); unique.push(t); }
  });
  log[today] = unique.slice(0, 50);

  if (!DRY_RUN) {
    fs.writeFileSync(NOMATCH_FILE, JSON.stringify(log, null, 2), 'utf-8');
  }

  // 输出摘要
  var totalNoMatch = Object.values(log).reduce(function (a, b) { return a + (Array.isArray(b) ? b.length : 0); }, 0);
  console.log('\n[no_match] Today: ' + unique.length + ' items fell through all filters' +
    (unique.length > 50 ? ' (showing top 50)' : '') +
    '. 7d backlog: ' + totalNoMatch + ' items in ' + NOMATCH_FILE);
  if (unique.length > 0 && DRY_RUN) {
    console.log('  Sample titles:');
    unique.slice(0, 10).forEach(function (t) { console.log('    - ' + t.slice(0, 80)); });
  }
}

// ============================================================
// v8 P1: 种子词命中率追踪
// ============================================================

function loadSeedStats() {
  var stats = {};
  try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8')); } catch (e) {}
  return stats;
}

function saveSeedStats(stats) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
}

/** 对所有经过 Bilibili 过滤的标题，逐一测试每个种子关键词是否命中 */
function updateSeedStats() {
  if (!bilibiliTitles.length) return;
  var stats = loadSeedStats();
  var today = todayStr();

  // 大小写不敏感去重
  var unique = [];
  var seen = new Set();
  bilibiliTitles.forEach(function (t) {
    var k = t.slice(0, 60).toLowerCase();
    if (!seen.has(k)) { seen.add(k); unique.push(t); }
  });

  var cats = [
    { seeds: _ANIME, type: 'include' },
    { seeds: _GAME_JP, type: 'include' },
    { seeds: _GACHA, type: 'exclude' },
    { seeds: _JUNK, type: 'exclude' },
    { seeds: _BLOCK_TAG, type: 'exclude' }
  ];

  cats.forEach(function (cat) {
    (cat.seeds || []).forEach(function (seed) {
      var lcSeed = seed.toLowerCase();
      for (var i = 0; i < unique.length; i++) {
        if (unique[i].toLowerCase().indexOf(lcSeed) !== -1) {
          if (!stats[seed]) stats[seed] = { h: 0, d: today, c: cat.type };
          stats[seed].h++;
          stats[seed].d = today;
          break;
        }
      }
    });
  });

  seedHitCounts = stats;
  saveSeedStats(stats);
}

function outputSeedStatsSummary() {
  var stats = seedHitCounts;
  var cutoff = daysAgo(30);
  var tracked = Object.keys(stats);

  if (!tracked.length) return;

  // Dead keywords (unused 30d)
  var deadInclude = [];
  var deadExclude = [];
  tracked.forEach(function (kw) {
    if (stats[kw].d < cutoff) {
      if (stats[kw].c === 'include') deadInclude.push(kw);
      else deadExclude.push(kw);
    }
  });

  var totalDead = deadInclude.length + deadExclude.length;
  console.log('\n[seed-stats] Tracking ' + tracked.length + ' seed keywords');
  if (totalDead > 0) {
    console.log('[seed-stats] unused 30d (' + totalDead + '/' + tracked.length + '):');
    if (deadInclude.length) console.log('  include: ' + deadInclude.join(', '));
    if (deadExclude.length) console.log('  exclude: ' + deadExclude.join(', '));
  }

  // Top 5 blockers
  var excludeSeeds = tracked.filter(function (kw) { return stats[kw].c === 'exclude'; });
  excludeSeeds.sort(function (a, b) { return stats[b].h - stats[a].h; });
  var top5 = excludeSeeds.slice(0, 5);
  if (top5.length > 0) {
    console.log('[seed-stats] top blockers: ' + top5.map(function (kw) { return kw + '(' + stats[kw].h + ')'; }).join(', '));
  }

  // Top 5 passers
  var includeSeeds = tracked.filter(function (kw) { return stats[kw].c === 'include'; });
  includeSeeds.sort(function (a, b) { return stats[b].h - stats[a].h; });
  var topInc = includeSeeds.slice(0, 5);
  if (topInc.length > 0) {
    console.log('[seed-stats] top passers: ' + topInc.map(function (kw) { return kw + '(' + stats[kw].h + ')'; }).join(', '));
  }
}

// ============================================================
// v8 P1: 关键词试用期
// ============================================================

function buildWatchRegex() {
  if (!_WATCH.length) return null;
  return seedsToRegex(_WATCH);
}

/** 检查标题是否命中试用期关键词 — 只记录不拦截 */
function checkWatchMatch(title, verbose) {
  if (!_WATCH.length) return;
  var lc = title.toLowerCase();
  for (var i = 0; i < _WATCH.length; i++) {
    var kw = _WATCH[i];
    if (lc.indexOf(kw.toLowerCase()) !== -1) {
      watchMatches.push({ w: kw, title: title, date: todayStr() });
      if (verbose) console.log('  [watch:' + kw + '] ' + title.slice(0, 50));
    }
  }
}

function loadWatchLog() {
  var log = {};
  try { log = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf-8')); } catch (e) {}
  return log;
}

function saveWatchLog(log) {
  if (DRY_RUN) return;
  fs.writeFileSync(WATCH_FILE, JSON.stringify(log, null, 2), 'utf-8');
}

function updateWatchLog() {
  if (!watchMatches.length) return;
  var log = loadWatchLog();
  var today = todayStr();

  // 聚合同一关键词的本日匹配
  var agg = {};
  watchMatches.forEach(function (m) {
    if (!agg[m.w]) agg[m.w] = { count: 0, titles: [] };
    agg[m.w].count++;
    if (agg[m.w].titles.length < 5) agg[m.w].titles.push(m.title.slice(0, 80));
  });

  Object.keys(agg).forEach(function (kw) {
    if (!log[kw]) log[kw] = { created: today, hits: 0, last: today, titles: [] };
    log[kw].hits += agg[kw].count;
    log[kw].last = today;
    log[kw].titles = agg[kw].titles;
  });

  saveWatchLog(log);
}

/** 评估试用期满 7 天的关键词：命中 ≥3 → 升级；<3 → 移除 */
function evaluateWatchPromotion() {
  if (!_WATCH.length) return;
  var log = loadWatchLog();
  var today = todayStr();
  var cutoff = daysAgo(7);

  var toPromote = [];
  var toRemove = [];

  Object.keys(log).forEach(function (kw) {
    if (_WATCH_SAFE.has(kw)) return;
    if (log[kw].created <= cutoff) {
      if (log[kw].hits >= 3) toPromote.push(kw);
      else toRemove.push(kw);
    }
  });

  if (toPromote.length) {
    console.log('\n[watch] Auto-promoting to SEED_JUNK: ' + toPromote.join(', '));
    autoPromoteToSeeds(toPromote);
  }
  if (toRemove.length) {
    console.log('[watch] Removing (hits < 3 in 7d): ' + toRemove.join(', '));
    removeWatchKeywords(toRemove);
  }
}

function autoPromoteToSeeds(keywords) {
  if (DRY_RUN) {
    console.log('[watch] (dry-run: would add to SEED_JUNK and remove from watch_exclude)');
    return;
  }
  try {
    var seeds = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
    var junkSet = new Set((seeds.SEED_JUNK || []).map(function (w) { return w; }));
    var kset = new Set(keywords);
    var added = [];
    keywords.forEach(function (kw) {
      if (!junkSet.has(kw)) { seeds.SEED_JUNK.push(kw); added.push(kw); junkSet.add(kw); }
    });
    seeds.watch_exclude = (seeds.watch_exclude || []).filter(function (w) { return !kset.has(w); });
    if (added.length) {
      fs.writeFileSync(SEED_FILE, JSON.stringify(seeds, null, 2), 'utf-8');
      console.log('[watch] ' + added.length + ' keyword(s) moved to SEED_JUNK');
    }
  } catch (e) {
    console.warn('[watch] auto-promote failed: ' + e.message);
  }
}

function removeWatchKeywords(keywords) {
  if (DRY_RUN) {
    console.log('[watch] (dry-run: would remove from watch_exclude)');
    return;
  }
  try {
    var seeds = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
    var kset = new Set(keywords);
    seeds.watch_exclude = (seeds.watch_exclude || []).filter(function (w) { return !kset.has(w); });
    fs.writeFileSync(SEED_FILE, JSON.stringify(seeds, null, 2), 'utf-8');
    var wlog = loadWatchLog();
    keywords.forEach(function (kw) { delete wlog[kw]; });
    saveWatchLog(wlog);
  } catch (e) {
    console.warn('[watch] remove failed: ' + e.message);
  }
}

// ============================================================
// Utility
// ============================================================

/** 返回 N 天前的日期字符串（YYYY-MM-DD），用于关键词 TTL 淘汰 */
function daysAgo(n) {
  var d = new Date(new Date().getTime() + 8 * 3600000 - n * 86400000);
  return d.toISOString().slice(0, 10);
}

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
      sourceCounts[fetchers[i].name] = items.length;
      allItems = allItems.concat(items);
    } catch (e) {
      console.warn('  ✗ ' + fetchers[i].name + ': ' + e.message);
      sourceCounts[fetchers[i].name] = 0;
    }
  }

  // ---- v7: 源健康 + 盲区 ----
  updateSourceHealth(sourceCounts);
  if (DRY_RUN || noMatchTitles.length > 0) writeNoMatchLog();

  // ---- v8 P1: 种子词命中 + 试用期 ----
  updateSeedStats();
  updateWatchLog();
  outputSeedStatsSummary();
  evaluateWatchPromotion();

  // ---- dry-run: 输出摘要即退出 ----
  if (DRY_RUN) {
    var totalFetched = allItems.length;
    var totalBlocked = noMatchTitles.length; // approximate — noMatch includes both popular + search
    console.log('\n[dry-run] Summary: ' + totalFetched + ' passed items ready to write (skipped — dry-run mode)');
    console.log('[dry-run] Edit data/seed-keywords.json and re-run with --dry-run to iterate');
    console.log('[dry-run] When satisfied, run without --dry-run to write files\n');
    process.exit(0);
  }

  if (!allItems.length) {
    console.log('No items fetched — keeping existing file unchanged');
    process.exit(0);
  }

  var existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8')); } catch (e) {}

  var curatedItems = existing.filter(function (e) { return e.content || e.pinned; });

  function dedupKey(title) {
    return (title || '').replace(/ ⭐\d+%/, '').trim().toLowerCase().slice(0, 60);
  }
  var seen = new Set();
  curatedItems.forEach(function (item) { seen.add(dedupKey(item.title)); });
  allItems = allItems.filter(function (item) {
    var key = dedupKey(item.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  var skipRe = /^(广告|推广|优惠|促销|红包|福利|签到|抽奖)/;
  allItems = allItems.filter(function (item) {
    return item.title && item.title.length >= 3 && !skipRe.test(item.title);
  });

  allItems.forEach(function (item) {
    var old = existing.find(function (e) { return e.title === item.title; });
    if (old && old.content) item.content = old.content;
    if (old && old.pinned) item.pinned = true;
  });

  allItems.forEach(function (item) { item.date = parseDate(item.date); });

  allItems.sort(function (a, b) {
    if ((a.heat || 0) !== (b.heat || 0)) return (b.heat || 0) - (a.heat || 0);
    return (b.date || '').localeCompare(a.date || '');
  });

  // ---- Safety gate: API 全失败 → 不覆盖 ----
  if (allItems.length === 0 && existing.length > 0) {
    console.log('No items fetched from any source — keeping existing file (' + existing.length + ' items) unchanged');
    process.exit(0);
  }

  var result = curatedItems.concat(allItems);
  var newItemCount = result.length - curatedItems.length;
  if (result.length > MAX_ITEMS) {
    result = result.slice(0, MAX_ITEMS);
    newItemCount = result.length - Math.min(curatedItems.length, MAX_ITEMS);
    if (curatedItems.length > MAX_ITEMS) {
      console.warn('  ⚠ curated items (' + curatedItems.length + ') exceed MAX_ITEMS (' + MAX_ITEMS + ') — extra curated dropped');
    }
  }

  console.log('Writing ' + result.length + ' items (' + curatedItems.length + ' curated, ' + newItemCount + ' new) to ' + OUT_FILE);
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
  console.log('Done.');
})();
