// 本機測試用伺服器：node dev-server.js，然後用 http://localhost:3000 開
// 同一個 Wi-Fi 的手機可以用 http://<電腦的 IP>:3000 連進來
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import handler from './api/game.js';

const PORT = process.env.PORT || 3000;
const ROOT = join(import.meta.dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/game') {
    let body = '';
    for await (const c of req) body += c;
    req.query = Object.fromEntries(url.searchParams);
    req.body = body ? JSON.parse(body) : {};
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
    return handler(req, res);
  }
  const file = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404; res.end('Not found');
  }
}).listen(PORT, () => console.log('古董局中局：http://localhost:' + PORT));
