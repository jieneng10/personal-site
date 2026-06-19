/**
 * 每日二次元资讯抓取脚本 v4
 * 从多个全球可达的 API 获取动漫/视觉小说新闻，输出 anime-news.json
 *
 * 用法: node scripts/fetch-news.js
 * 由 GitHub Action 每日 22:00 UTC（北京时间 6:00）触发
 *
 * v4 新增：关键词反馈学习系统
 *   - data/keyword-bank.json 持久化已学关键词（include + exclude）
 *   - 每轮抓取后从通过/拒绝的条目自动发现新关键词
 *   - 种子关键词写在代码中，学习词累加到 JSON bank
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
// Bilibili source（含关键词反馈学习）
// ============================================================

var SEARCH_KWS = ['Galgame', 'GALGAME', '视觉小说', '美少女ゲーム', 'エロゲ', '新番', 'アニメ']; // WBI 搜索补充关键词（v5: 去掉过于宽泛的"二次元/anime"，改为 Galgame 特化）

async function fetchBilibiliPopular() {
  var bank = loadKeywordBank();

  // ---- 种子关键词（硬编码）----
  var SEED_ALLOWED_TIDS = new Set([47, 121]); // 同人·手书 | GMV

  var SEED_GAME_JP = ['日系','日本','anime','Anime','アニメ','Galgame','galgame','视觉小说','二次元','番','动漫',
    'RPG','JRPG','Persona','女神','ペルソナ','Final Fantasy','ファイナルファンタジー','Dragon Quest','ドラクエ',
    'Tales of','テイルズ','Atelier','アトリエ','無双','DMC','デビル','バイオハザード','RE:ZERO','モンハン','MH',
    'かまいたち','うたわれる','ダンガンロンパ','シュタインズ','カオスヘッド','ロボティクス','ノーツ',
    'CLANNAD','Angel Beats','Rewrite','Key','HIKARI','Nekonyan','Frontwing','TYPE-MOON','Nitroplus','Laplacian',
    'MAGES','ゆず','ぱれっと','Lump','minori','CIRCUS','Navel','Palette','SAGA','八月','BALDR','グリザイア',
    'Grisaia','9-nine','金色','白昼夢','アメイジング','グレイス','終わりの惑星','アマカノ','サノバ','千恋',
    'RIDDLE JOKER','喫茶ステラ','Making','Lovers','Sugar','Style','紫社','Sekai','Project','Purple','Liar-soft',
    'light','CUBE','HOOKSOFT','SMEE','ASa','Azarashi','Favorite','Whirlpool','まどそふと','戯画','BaseSon',
    'ensemble','ぱじゃま','Escu:de','Eushully','Alicesoft','シルキーズ','BISHOP','Guilty','WAFFLE',
    'hibiki','キャラメル','Cotton','MOONSTONE','tone work','ユニゾン','Recette','エスクード',
    // 中文游戏名关键词——Bilibili 单机游戏区识别日系游戏
    '女神异闻录','勇者斗恶龙','最终幻想','怪物猎人','生化危机','如龙','人中之龙',
    '轨迹','传说系列','伊苏','炼金工房','真女神转生','歧路旅人','八方旅人',
    '超次元','海王星','弹丸论破','命运石之门','混沌之脑','机器人笔记',
    '秋之回忆','告别回忆','Ever17','Remember11','极限脱出','善人死亡',
    '逆转裁判','大逆转','雷顿','幽灵诡计','AI梦境','梦境档案',
    '十三机兵','胧村正','龙之皇冠','奥丁领域','公主皇冠',
    '樱花大战','梦幻模拟战','Langrisser','圣剑传说','沙加','Saga',
    '时空之轮','Chrono','异度','Xeno','火纹','火焰纹章','FE',
    '塞尔达','Zelda','马力欧','Mario','卡比','Kirby','密特罗德',
    '星之卡比','大金刚','皮克敏','喷射战士','Splatoon',
    '牧场物语','符文工房','天穗','大乱斗','Smash',
    '罪恶装备','Guilty Gear','苍翼默示录','夜下降生','月姬格斗',
    // v6: 更多日系视觉小说/Galgame 品牌+作品
    '素晴らしき日々','サクラノ刻','サクラノ詩','サクラノトキ','サクラノウタ',
    'はつゆきさくら','はつゆき','ナツユメナギサ','G線上の魔王','車輪の国',
    'スマガ','最果てのイマ','CROSS†CHANNEL','ひまわり','家族計画',
    'パルフェ','この青空に約束を','フォセット','ショコラ',
    '天使の羽','きると','MOONSTONE','CLEAR','SWAY','Selen',
    'Overdrive','âge','ミラージュ','アージュ','マブラヴ','Muv-Luv',
    ' propeller','Carol Works','CUBE','CUFFS','Sphere',
    'ま～まれぇど','Marmalade','ねこねこソフト','Nekoneko',
    'Innocent Grey','ig社','殻ノ少女','虚ノ少女','天ノ少女',
    'FLOWERS','IG','シルキーズプラス','Silkys+',];

  var SEED_ANIME = ['Galgame','galgame','gal','GAL','视觉小说','アニメ','anime','Anime','动漫','番剧','二次元',
    'OST','ACG','声优','新番','MAGES','Key社','柚子社','紫社','HIKARI','Nekonyan','Frontwing','八月社','minori',
    'CIRCUS','Navel','Palette','SAGA','Nitroplus','TYPE-MOON','Laplacian','ゆず','ぱれっと','魔法少女','異世界',
    '転生','鬼滅','呪術','SPY','チェンソーマン','葬送','フリーレン','Gundam','ガンダム','EVA','エヴァ',
    '化物語','まどか','Steins Gate','Fate','空の境界','ひぐらし','うみねこ','Rewrite','CLANNAD','AIR','Kanon',
    'リトルバスターズ','planetarian','Harmonia','Summer Pockets','Angel Beats','Charlotte','リトバス',
    'グリザイア','Grisaia','千恋万花','サノバウィッチ','RIDDLE JOKER','喫茶ステラ','アオナツライン',
    'アマカノ','Making','Lovers','Sugar','Style','タマユラ','白昼夢','アメイジング','グレイス','終わりの惑星',
    '月姫','月姬','魔法使いの夜','魔法使之夜','リメイク','Recette','エスクード','BISHOP','WAFFLE','Guilty','Alicesoft','Eushully',
    'ensemble','CUBE','SMEE','ASa','Azarashi','HOOKSOFT','戯画','light','Liar-soft','Whirlpool','まどそふと',
    // 中文动漫术语 —— 扩展 Bilibili 搜索命中
    '异世界','转生','穿越','魔王','勇者','精灵','地下城','冒险者','公会',
    '轻小说','漫画','动画','剧场版','OVA','OAD','TV动画','WEB动画',
    '声优','配信','放送','新番','番剧','续作','系列','重制','复刻',
    '同人','COMIKET','コミケ','例大祭','M3','VOCALOID','ボカロ',
    '日配','中配','字幕','汉化','熟肉','生肉','机翻',
    // v6: 2024-2026 热门作品+泛ACGN术语补充
    '推しの子','我推的孩子','Oshi no Ko','ぼっち','Bocchi','孤独摇滚','莉可丽丝','リコリス',
    '無職転生','无职转生','Mushoku','ダンダダン','Dandadan','胆大党',
    '薬屋','药屋','Apothecary','サマータイムレンダ','夏日重现',
    '着せ恋','更衣人偶','着せ替え人形','メイドインアビス','来自深渊','Made in Abyss',
    'オーバーロード','Overlord','転スラ','転生したら','Tensei','Slime',
    'ヴァイオレット','Violet Evergarden','紫罗兰',
    '終末','終末なに','終末少女','ヨルシカ','Yorushika','ずっと真夜中','ZUTOMAYO',
    '結束バンド','结束乐队','結束band','kessoku',
    'ATRI','GINKA','LOOPERS','LUNARiA',];

  var SEED_GACHA = ['原神','星穹铁道','绝区零','鸣潮','明日方舟','终末地','崩坏','FGO','グラブル','プリコネ',
    'ウマ娘','アズレン','ブルアカ','崩壊','スタレ','ゼンレス','アークナイツ','ドルフロ','NIKKE','勝利の女神',
    '胜利女神','学園アイドルマスター','プロセカ','ヘブバン','リバース','1999','重返未来','少女前线','艦これ',
    '刀剣乱舞','あんスタ','Fate Grand Order','白夜極光','アナザーエデン','ドラガリ','FEH','FEヒーローズ',
    'パズドラ','モンスト','ディズニーツイステ','ツイステ',
    '崩坏3','崩坏学园','战双帕弥什','深空之眼','无期迷途','天地劫','梦幻模拟战手游',
    '妮姬','碧蓝航线','蔚蓝档案','赛马娘',
    // v5 扩充：更多二游名/别名/厂商/系列 — 只要可能出现在"二游信息流"，一律拦截
    '原神','genshin','崩铁','轨子','绝区','zzz','O神','米哈游','mihoyo','hoyoverse',
    '星穹','铁道','崩坏','崩二','崩3','未定事件','未定','tears of themis',
    '明日方舟','arknights','终末地','鹰角','hypergryph','来自星尘','罗德岛',
    '鸣潮','wuthering','库洛','kuro','战双','パニシング',
    'Fate/Grand','フェイト','FGO','fgo',
    '碧蓝航线','azur lane','碧蓝','アズレン','蔚蓝档案','blue archive','ブルアカ',
    'NIKKE','nikke','胜利女神','shiftup','デスティニーチャイルド',
    '蛋仔派对','eggyparty',
    '少女前线','girls frontline','ドルフロ','散爆','MICA','云图计划','追放',
    '重返未来','reverse','1999','深蓝互动','bluepoch',
    '白夜极光','alchemy stars',
    '无期迷途','path to nowhere',
    '幻塔','tower of fantasy',
    '尘白禁区','snowbreak',
    '无限暖暖','infinity nikki','恋与','光与夜','光夜','乙女',
    '永劫无间','naraka',
    '暗区突围','arena breakout','三角洲','使命召唤','codm','pubgm',
    '王者荣耀','honor of kings','LOLm','英雄联盟手游','金铲铲','云顶之弈','TFT',
    // 以下为经典动漫 IP（非二游），不在此拦截——它们属于原教旨二次元范畴
    '第五人格','identity v','阴阳师','onmyoji','百闻牌','决战平安京',
    'ウマ娘','uma musume','プリコネ','princess connect','サイゲ','cygames',
    'グラブル','granblue','グランブルー','シャドバ','shadowverse',
    'デレステ','ミリシタ','シャニマス','アイマス','imas','アイドルマスター',
    'プロセカ','project sekai',  // 音游（非 vocaloid 本身——初音ミク是正统二次元文化）
    // VTuber 文化（Hololive/にじさんじ等）属正统二次元范畴，不放杀 — 从 SEED_GACHA 移除
    // 若 VTuber 相关内容质量过低，由 SEED_JUNK 的 clickbait/切片/录播 等信号拦截
    'あんスタ','enstars','ツイステ','twisted wonderland',
    'FEH','ファイアーエムブレム','FEヒーローズ','パズドラ','モンスト','モンスターストライク',
    // 手游通用信号 — 标题中出现这些词但内容涉及抽卡/氪金/体力等二游模式
    '抽卡','出货','氪金','保底','十连','单抽','池子','卡池','限定池','常驻池',
    'SSR','UR','战力','练度','养成',];

  var SEED_JUNK = ['震惊','卧槽','不看后悔','速看','千万别','哭死','怒赞','刷爆','逆天','网暴','塌房','全网',
    '必看','燃爆','贼爽','爽爆','夯爆','最狠','年度最佳','神作','封神','盘点','切片','合集','录播','迷你世界',
    '我的世界','东北雨姐','蔡徐坤','抽象','猎奇','孤岛小夫','流放之路','流放2','PoE','DNF',
    '地下城','吃鸡','王者荣耀','LOL','英雄联盟','瓦洛兰','归唐','穿越火线','CS','三角洲','使命召唤',
    '战地','Apex','PUBG','Fortnite','彩虹六号','守望先锋','坦克世界','战争雷霆',
    '永劫无间','暗区突围','卡拉彼丘',
    '晚安钢琴','助眠','安眠','纯音乐','轻音乐','白噪音','催眠','入睡',
    '爽文','配音爽文','番茄小说','番茄畅听','有声小说','小说提','推文',
    '披萨店'];

  var SEED_BLOCK_TAG = ['国产动画','国创','动态漫画','手机游戏','電子競技','电竞','电子竞技','国产原创相关'];

  // v5: Bilibili 分区 ID 黑名单 — 这些分区的内容无论标题怎么匹配都是 二游/非原教旨二次元
  var SEED_BLOCK_TIDS = new Set([253]); // 253 = 手机游戏（手游区）

  // ---- 合并种子 + 学习词 → 正则 ----
  // 种子用 seedsToRegex（支持短词自动加 \b 边界），学习词用 kwToRegex
  var learnedInc = bankWords(bank.include);
  var learnedExc = bankWords(bank.exclude);
  var GAME_JP_KW   = joinRegex([seedsToRegex(SEED_GAME_JP), kwToRegex(learnedInc)]);
  var ANIME_KW     = joinRegex([seedsToRegex(SEED_ANIME), kwToRegex(learnedInc)]);
  var GACHA_BLOCK  = joinRegex([seedsToRegex(SEED_GACHA), kwToRegex(learnedExc)]);
  var JUNK         = joinRegex([seedsToRegex(SEED_JUNK), kwToRegex(learnedExc)]);
  var BLOCK_TAG_RE = joinRegex([seedsToRegex(SEED_BLOCK_TAG), kwToRegex(learnedExc)]);

  // ---- 拉取数据 ----
  var raw = await httpGet('https://api.bilibili.com/x/web-interface/popular?ps=50', {
    headers: { 'Referer': 'https://www.bilibili.com/' }
  });
  var json = JSON.parse(raw);
  var list = (json && json.data && json.data.list) || [];

  // ---- 分类过滤：pass / reject + 原因（用于学习）----
  var passed = [];
  var rejected = [];

  list.forEach(function (v) {
    if (!v || !v.title || v.title.length < 4) return;
    var tid = v.tid || 0;
    var tname = v.tname || '';
    var title = v.title;

    // v5: 分区黑名单（手游区等，无论标题如何一律拒绝）
    if (SEED_BLOCK_TIDS.has(tid))                         { rejected.push({ title: title, _rawTag: tname, reason: 'block_tid' }); return; }
    if (BLOCK_TAG_RE && BLOCK_TAG_RE.test(tname))         { rejected.push({ title: title, _rawTag: tname, reason: 'block_tag' }); return; }
    if (JUNK && JUNK.test(title))                          { rejected.push({ title: title, _rawTag: tname, reason: 'junk' }); return; }
    if (GACHA_BLOCK && GACHA_BLOCK.test(title))            { rejected.push({ title: title, _rawTag: tname, reason: 'gacha' }); return; }
    var exclaimCount = (title.match(/！/g) || []).length;
    if (title.length >= 12 && exclaimCount >= 2)           { rejected.push({ title: title, _rawTag: tname, reason: 'exclaim' }); return; }

    // v5: 二游二次检查 — 标题/描述中含抽卡/氪金/体力等手游模式词的不放行
    // GACHA_BLOCK 只扫标题，这里补扫描述和分区名，拦截伪装成动漫资讯的二游内容
    var desc = (v.desc || '').slice(0, 300);
    var gachaSignal = (GACHA_BLOCK && GACHA_BLOCK.test(desc)) ||
                      (GACHA_BLOCK && GACHA_BLOCK.test(tname));
    if (gachaSignal)                                       { rejected.push({ title: title, _rawTag: tname, reason: 'gacha_desc' }); return; }

    if (SEED_ALLOWED_TIDS.has(tid))                        { passed.push({ title: title, _rawTag: tname }); return; }
    if (tid === 17 && GAME_JP_KW && GAME_JP_KW.test(title)) {
      // v5: 单机游戏分区 + 日系关键词匹配 → 再做一次 gacha 描述信号检查
      if (GACHA_BLOCK && GACHA_BLOCK.test(desc))           { rejected.push({ title: title, _rawTag: tname, reason: 'gacha_desc' }); return; }
      passed.push({ title: title, _rawTag: tname }); return;
    }
    if (ANIME_KW && ANIME_KW.test(title)) {
      // v5: ANIME_KW 匹配 → 再做一次 gacha 描述信号检查（拦截标题含泛二次元词但内容为二游的）
      if (GACHA_BLOCK && GACHA_BLOCK.test(desc))           { rejected.push({ title: title, _rawTag: tname, reason: 'gacha_desc' }); return; }
      passed.push({ title: title, _rawTag: tname }); return;
    }
  });

  // ---- 关键词反馈学习 ----
  var newInclude = discoverIncludeKeywords(passed, bank);
  var rejectedForLearning = rejected.filter(function (r) { return r.reason === 'junk' || r.reason === 'gacha' || r.reason === 'gacha_desc' || r.reason === 'block_tid'; });
  var newExclude0 = discoverExcludeKeywords(rejectedForLearning, bank);
  var newExclude = resolveConflicts(bank, newInclude, newExclude0);

  // 重观察词：已在 bank 但本轮 tag 再次出现 → 刷新 ts+n
  var reobsInc = discoverReobserved(bank.include, passed);
  var reobsExc = discoverReobserved(bank.exclude, rejectedForLearning);

  // 合并新发现 + 重观察 → upsert
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

  // ---- 重建 filtered 列表（从原始数据按 title 匹配 passed）----
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
    // 热度与播放量成正比：100 播放→28分, 1k→42, 1w→56, 10w→70, 100w→78
    // 低质的 Bilibili 视频(<1w 播放)自然被 AniList(58+)和 Jikan(67+)挤出 top 16
    // Bilibili 信用加成 +12，确保 2k+ 播放的日系视频能与 AniList 底层(43-58)竞争
    var heat = Math.floor(Math.log10(Math.max(1, view + like * 2)) * 14) + 12;
    heat = Math.min(80, Math.max(42, heat));  // clamp 42-80
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

        var sPassed = []; var sRejected = [];
        sList.forEach(function (sv) {
          var t = (sv.title || '').replace(/<[^>]+>/g, '');
          if (!t || t.length < 4) return;
          var stag = sv.tag || '';
          var sdesc = (sv.description || '').slice(0, 300);
          if (BLOCK_TAG_RE && BLOCK_TAG_RE.test(stag))  { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'block_tag' }); return; }
          if (JUNK && JUNK.test(t))                     { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'junk' }); return; }
          if (GACHA_BLOCK && GACHA_BLOCK.test(t))       { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'gacha' }); return; }
          // v5: 放行前二游二次检查 — 描述中含抽卡/氪金/体力等手游模式词不放行
          var sgachaSignal = GACHA_BLOCK && (GACHA_BLOCK.test(sdesc) || GACHA_BLOCK.test(stag));
          if (ANIME_KW && ANIME_KW.test(t)) {
            if (sgachaSignal) { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'gacha_desc' }); return; }
            sPassed.push({ title: t, _rawTag: stag, _rawDesc: sdesc, _url: 'https://www.bilibili.com/video/' + (sv.bvid||''), _view: sv.play || 0 }); return;
          }
          if (GAME_JP_KW && GAME_JP_KW.test(t)) {
            if (sgachaSignal) { sRejected.push({ title: t, _rawTag: stag, _rawDesc: sdesc, reason: 'gacha_desc' }); return; }
            sPassed.push({ title: t, _rawTag: stag, _rawDesc: sdesc, _url: 'https://www.bilibili.com/video/' + (sv.bvid||''), _view: sv.play || 0 }); return;
          }
        });

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
      allItems = allItems.concat(items);
    } catch (e) {
      console.warn('  ✗ ' + fetchers[i].name + ': ' + e.message);
    }
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
