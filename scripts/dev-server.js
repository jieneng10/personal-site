/** Local source preview with an explicit public-file allowlist. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PAGES = new Set(['index.html', 'admin.html', 'reset-password.html', '404.html', 'manifest.json', 'feed.xml', 'sw.js']);
const DATA = new Set(['data/articles.json', 'data/anime-news.json', 'data/i18n/zh-CN.json']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2',
};

function publicPath(url) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname); }
  catch { return null; }
  if (pathname.startsWith('/personal-site/')) pathname = pathname.slice('/personal-site/'.length);
  else pathname = pathname.replace(/^\//, '');
  if (!pathname) pathname = 'index.html';
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  const parts = pathname.split('/');
  if (parts.some(part => !part || part === '..' || part.startsWith('.'))) return null;
  const extension = path.extname(pathname).toLowerCase();
  const allowed = PAGES.has(pathname) || DATA.has(pathname) ||
    (pathname.startsWith('css/') && extension === '.css') ||
    (pathname.startsWith('js/') && (extension === '.js' || extension === '.mjs')) ||
    (pathname.startsWith('static/') && Object.hasOwn(MIME, extension));
  if (!allowed) return null;
  const file = path.resolve(ROOT, pathname);
  return file.startsWith(ROOT + path.sep) ? file : null;
}

function createSiteServer() {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    const file = publicPath(req.url || '/');
    if (!file) { res.writeHead(404); return res.end(); }
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { res.writeHead(404); return res.end(); }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
      let start = 0;
      let end = stat.size - 1;
      let status = 200;
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (match && stat.size) {
        if (match[1]) start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
        if (!match[1] && match[2]) start = Math.max(0, stat.size - Number(match[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = stat.size ? end - start + 1 : 0;
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || !stat.size) return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    });
  });
}

if (require.main === module) {
  const port = Number(process.argv[2] || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  createSiteServer().listen(port, '127.0.0.1', () => {
    console.log(`Local preview: http://127.0.0.1:${port}`);
  });
}

module.exports = { createSiteServer, publicPath };
