'use strict';
/** Local dev server: node scripts/dev-server.js  ->  http://localhost:3000  (static files + /api/*). Reads .env. */
const fs = require('fs'), path = require('path'), http = require('http');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} else console.warn('No .env file found - copy .env.example to .env');

const PUB = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
const api = { '/api/rpc': require('../api/rpc'), '/api/health': require('../api/health') };

http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (api[p]) return Promise.resolve(api[p](req, res)).catch((e) => { console.error(e); res.statusCode = 500; res.end('{"error":"dev server error"}'); });
  let f = path.join(PUB, p === '/' ? 'index.html' : p);
  if (!f.startsWith(PUB)) { res.statusCode = 403; return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  });
}).listen(process.env.PORT || 3000, () => console.log('Dashboard on http://localhost:' + (process.env.PORT || 3000)));
