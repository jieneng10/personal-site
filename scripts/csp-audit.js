/** Check the actual page references against its Content Security Policy. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'js/shared.js'), 'utf8');
const failures = [];

const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
if (!meta) throw new Error('index.html 缺少 Content-Security-Policy');

const policy = new Map(meta[1].split(';').map(part => part.trim()).filter(Boolean).map(part => {
  const [name, ...values] = part.split(/\s+/);
  return [name, new Set(values)];
}));

function expectToken(directive, token, context) {
  if (!policy.get(directive)?.has(token)) failures.push(`${context}: ${directive} 缺少 ${token}`);
}

function checkUrl(url, directive, context) {
  if (/^(?:data:|blob:)/.test(url)) {
    expectToken(directive, url.split(':')[0] + ':', context);
    return;
  }
  if (/^https?:\/\//.test(url)) {
    const origin = new URL(url).origin;
    const sources = policy.get(directive);
    if (!sources?.has(origin) && !sources?.has(new URL(url).protocol)) {
      failures.push(`${context}: ${directive} 不允许 ${origin}`);
    }
    return;
  }
  expectToken(directive, "'self'", context);
  const local = url.split(/[?#]/)[0].replace(/^\//, '');
  if (local && !fs.existsSync(path.join(root, local))) failures.push(`${context}: 文件不存在 ${url}`);
}

for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const src = match[1].match(/\bsrc="([^"]+)"/i);
  if (src) checkUrl(src[1], 'script-src', '脚本');
  else if (match[2].trim() && !/\btype="application\/ld\+json"/i.test(match[1])) {
    failures.push('存在未获 CSP 许可的内联可执行脚本');
  }
}

for (const match of html.matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
  const rel = match[1].match(/\brel="([^"]+)"/i)?.[1];
  const href = match[1].match(/\bhref="([^"]+)"/i)?.[1];
  if (!href) continue;
  if (rel === 'stylesheet') checkUrl(href, 'style-src', '样式');
  if (rel === 'manifest') checkUrl(href, 'manifest-src', '应用清单');
  if (rel === 'icon') checkUrl(href, 'img-src', '网站图标');
}

const supabaseUrl = shared.match(/SUPABASE_URL\s*=\s*['"](https:\/\/[^'"]+)['"]/);
if (!supabaseUrl) failures.push('无法从 js/shared.js 读取 Supabase URL');
else {
  const origin = new URL(supabaseUrl[1]).origin;
  expectToken('connect-src', origin, 'Supabase API');
  expectToken('media-src', origin, 'Supabase 音频');
}
expectToken('font-src', 'https://fonts.gstatic.com', 'Google Fonts');
expectToken('media-src', 'blob:', '本地 BGM');

if (failures.length) {
  console.error('CSP 审查失败:\n' + failures.map(item => '  - ' + item).join('\n'));
  process.exitCode = 1;
} else {
  console.log('CSP 审查通过：页面资源存在且来源已获许可');
}
