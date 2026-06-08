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
// Keyword Bank — 自动学习反馈系统
// ============================================================

function loadKeywordBank() {
  var bank = { include: [], exclude: [] };
  try { bank = JSON.parse(fs.readFileSync(BANK_FILE, 'utf-8')); } catch (e) {}
  bank.include = bank.include || [];
  bank.exclude = bank.exclude || [];
  return bank;
}

function saveKeywordBank(bank) {
  // include: 去除过短(<3) / 过长(>25，可能是视频特定短语) / 纯数字
  bank.include = Array.from(new Set(bank.include))
    .filter(function (k) { return k.length >= 3 && k.length <= 25 && !/^\d+$/.test(k); })
    .sort();
  // exclude: 同上
  bank.exclude = Array.from(new Set(bank.exclude))
    .filter(function (k) { return k.length >= 3 && k.length <= 25 && !/^\d+$/.test(k); })
    .sort();
  // include 优先：同时出现在两边的从 exclude 移除
  var incSet = new Set(bank.include.map(function (k) { return k.toLowerCase(); }));
  bank.exclude = bank.exclude.filter(function (k) { return !incSet.has(k.toLowerCase()); });
  fs.writeFileSync(BANK_FILE, JSON.stringify(bank, null, 2), 'utf-8');
}

/** 关键词数组 → 正则 alternation（转义特殊字符） */
function kwToRegex(list) {
  if (!list.length) return null;
  var escaped = list.map(function (w) {
    return String(w).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  });
  return new RegExp(escaped.join('|'), 'i');
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
  var existSet = new Set(bank.include.map(function (k) { return k.toLowerCase(); }));
  var candidates = {};
  passedItems.forEach(function (item) {
    extractTags(item._rawTag || '').forEach(function (t) {
      if (!looksLikeProperNoun(t)) return;
      var lc = t.toLowerCase();
      if (existSet.has(lc)) return;
      candidates[lc] = (candidates[lc] || 0) + 1;
    });
  });
  // 要求 ≥2 次出现才纳入（单次可能是单条视频的专有标签）
  return Object.keys(candidates).filter(function (k) { return candidates[k] >= 2; });
}

/** 从被拒绝的条目中发现新的 exclude 关键词 */
function discoverExcludeKeywords(rejectedItems, bank) {
  var existSet = new Set(bank.exclude.map(function (k) { return k.toLowerCase(); }));
  var candidates = {};
  rejectedItems.forEach(function (item) {
    var words = (item.title || '').split(/\s+/);
    words.forEach(function (w) {
      w = w.replace(/^[【\[]|[\]】.,;:：；，。!！?？、\\)]$/g, '').trim();
      if (w.length < 3) return;
      var lc = w.toLowerCase();
      if (existSet.has(lc)) return;
      if (!looksLikeProperNoun(w)) return;
      candidates[lc] = (candidates[lc] || 0) + 1;
    });
    extractTags(item._rawTag || '').forEach(function (t) {
      if (!looksLikeProperNoun(t)) return;
      var lc = t.toLowerCase();
      if (existSet.has(lc)) return;
      candidates[lc] = (candidates[lc] || 0) + 1;
    });
  });
  return Object.keys(candidates).filter(function (k) { return candidates[k] >= 2; });
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
    query: 'query { Page(page:1, perPage:8) { media(sort:TRENDING_DESC, type:ANIME, status:RELEASING, isAdult:false) { title { romaji english native } description siteUrl startDate { year month day } genres averageScore } } }'
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
    query: 'query { Page(page:1, perPage:5) { media(sort:POPULARITY_DESC, type:ANIME, status:NOT_YET_RELEASED, isAdult:false) { title { romaji english native } description siteUrl startDate { year month day } genres } } }'
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
  return list.slice(0, 6).map(function (a) {
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

var SEARCH_KWS = ['Galgame', 'anime'];

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
    'hibiki','キャラメル','Cotton','MOONSTONE','tone work','ユニゾン','Recette','エスクード'];

  var SEED_ANIME = ['Galgame','galgame','gal','GAL','视觉小说','アニメ','anime','Anime','动漫','番剧','二次元',
    'OST','ACG','声优','新番','MAGES','Key社','柚子社','紫社','HIKARI','Nekonyan','Frontwing','八月社','minori',
    'CIRCUS','Navel','Palette','SAGA','Nitroplus','TYPE-MOON','Laplacian','ゆず','ぱれっと','魔法少女','異世界',
    '転生','鬼滅','呪術','SPY','チェンソーマン','葬送','フリーレン','Gundam','ガンダム','EVA','エヴァ',
    '化物語','まどか','Steins Gate','Fate','空の境界','ひぐらし','うみねこ','Rewrite','CLANNAD','AIR','Kanon',
    'リトルバスターズ','planetarian','Harmonia','Summer Pockets','Angel Beats','Charlotte','リトバス',
    'グリザイア','Grisaia','千恋万花','サノバウィッチ','RIDDLE JOKER','喫茶ステラ','アオナツライン',
    'アマカノ','Making','Lovers','Sugar','Style','タマユラ','白昼夢','アメイジング','グレイス','終わりの惑星',
    '月姫','魔法使いの夜','リメイク','Recette','エスクード','BISHOP','WAFFLE','Guilty','Alicesoft','Eushully',
    'ensemble','CUBE','SMEE','ASa','Azarashi','HOOKSOFT','戯画','light','Liar-soft','Whirlpool','まどそふと'];

  var SEED_GACHA = ['原神','星穹铁道','绝区零','鸣潮','明日方舟','终末地','崩坏','FGO','グラブル','プリコネ',
    'ウマ娘','アズレン','ブルアカ','崩壊','スタレ','ゼンレス','アークナイツ','ドルフロ','NIKKE','勝利の女神',
    '学園アイドルマスター','プロセカ','ヘブバン','リバース','1999','重返未来','少女前线','艦これ','刀剣乱舞',
    'あんスタ','Fate Grand Order'];

  var SEED_JUNK = ['震惊','卧槽','不看后悔','速看','千万别','哭死','怒赞','刷爆','逆天','网暴','塌房','全网',
    '必看','燃爆','贼爽','爽爆','夯爆','最狠','年度最佳','神作','封神','盘点','切片','合集','录播','迷你世界',
    '蛋仔派对','我的世界','东北雨姐','蔡徐坤','抽象','猎奇','孤岛小夫','流放之路','流放2','PoE','DNF',
    '地下城','吃鸡','王者荣耀','LOL','英雄联盟','瓦洛兰','归唐','穿越火线','CS'];

  var SEED_BLOCK_TAG = ['国产动画','国创','动态漫画','手机游戏','電子競技','电竞','电子竞技','国产原创相关'];

  // ---- 合并种子 + 学习词 → 正则 ----
  var GAME_JP_KW  = kwToRegex(SEED_GAME_JP.concat(bank.include));
  var ANIME_KW    = kwToRegex(SEED_ANIME.concat(bank.include));
  var GACHA_BLOCK = kwToRegex(SEED_GACHA.concat(bank.exclude));
  var JUNK        = kwToRegex(SEED_JUNK.concat(bank.exclude));
  var BLOCK_TAG_RE = kwToRegex(SEED_BLOCK_TAG.concat(bank.exclude));

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

    if (BLOCK_TAG_RE && BLOCK_TAG_RE.test(tname))         { rejected.push({ title: title, _rawTag: tname, reason: 'block_tag' }); return; }
    if (JUNK && JUNK.test(title))                          { rejected.push({ title: title, _rawTag: tname, reason: 'junk' }); return; }
    if (GACHA_BLOCK && GACHA_BLOCK.test(title))            { rejected.push({ title: title, _rawTag: tname, reason: 'gacha' }); return; }
    var exclaimCount = (title.match(/！/g) || []).length;
    if (title.length >= 12 && exclaimCount >= 2)           { rejected.push({ title: title, _rawTag: tname, reason: 'exclaim' }); return; }

    if (SEED_ALLOWED_TIDS.has(tid))                        { passed.push({ title: title, _rawTag: tname }); return; }
    if (tid === 17 && GAME_JP_KW && GAME_JP_KW.test(title)) { passed.push({ title: title, _rawTag: tname }); return; }
    if (ANIME_KW && ANIME_KW.test(title))                  { passed.push({ title: title, _rawTag: tname }); return; }
  });

  // ---- 关键词反馈学习 ----
  var newInclude = discoverIncludeKeywords(passed, bank);
  var rejectedForLearning = rejected.filter(function (r) { return r.reason === 'junk' || r.reason === 'gacha'; });
  var newExclude = discoverExcludeKeywords(rejectedForLearning, bank);

  if (newInclude.length || newExclude.length) {
    var oldInc = new Set(bank.include);
    var oldExc = new Set(bank.exclude);
    bank.include = bank.include.concat(newInclude);
    bank.exclude = bank.exclude.concat(newExclude);
    saveKeywordBank(bank);
    // 仅报告实际新增（save 后经过去重/过滤的净增加）
    var netInc = bank.include.filter(function (k) { return !oldInc.has(k); });
    var netExc = bank.exclude.filter(function (k) { return !oldExc.has(k); });
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
          if (BLOCK_TAG_RE && BLOCK_TAG_RE.test(stag))  { sRejected.push({ title: t, _rawTag: stag, reason: 'block_tag' }); return; }
          if (JUNK && JUNK.test(t))                     { sRejected.push({ title: t, _rawTag: stag, reason: 'junk' }); return; }
          if (GACHA_BLOCK && GACHA_BLOCK.test(t))       { sRejected.push({ title: t, _rawTag: stag, reason: 'gacha' }); return; }
          if (ANIME_KW && ANIME_KW.test(t))             { sPassed.push({ title: t, _rawTag: stag }); return; }
          if (GAME_JP_KW && GAME_JP_KW.test(t))         { sPassed.push({ title: t, _rawTag: stag }); return; }
        });

        // 学习
        var sNewInc = discoverIncludeKeywords(sPassed, bank);
        var sNewExc = discoverExcludeKeywords(sRejected.filter(function(r){return r.reason==='junk'||r.reason==='gacha';}), bank);
        if (sNewInc.length || sNewExc.length) {
          var oldInc = new Set(bank.include);
          var oldExc = new Set(bank.exclude);
          bank.include = bank.include.concat(sNewInc);
          bank.exclude = bank.exclude.concat(sNewExc);
          saveKeywordBank(bank);
          var netInc = bank.include.filter(function (k) { return !oldInc.has(k); });
          var netExc = bank.exclude.filter(function (k) { return !oldExc.has(k); });
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
            summary: '',
            url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(kw),
            date: todayStr(),
            source: 'Bilibili',
            heat: 68,
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

  var result = curatedItems.concat(allItems);
  if (result.length > MAX_ITEMS) {
    var curatedCount = curatedItems.length;
    result = result.slice(0, Math.max(MAX_ITEMS, curatedCount));
  }

  var newItemCount = result.length - curatedItems.length;
  if (newItemCount < 1 && existing.length > 1 && curatedItems.length === existing.length) {
    console.log('No new items fetched — keeping existing file (' + existing.length + ' items) unchanged');
    process.exit(0);
  }

  console.log('Writing ' + result.length + ' items (' + curatedItems.length + ' curated, ' + newItemCount + ' new) to ' + OUT_FILE);
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
  console.log('Done.');
})();
