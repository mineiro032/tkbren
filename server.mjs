// servidor local pra testar: node server.mjs  (sem WIINPAY_API_KEY roda em modo teste)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.mjs';
import { fileStorage } from './lib/storage-file.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const env = { ...process.env };
if (!env.WIINPAY_API_KEY && !env.MOCK) env.MOCK = '1';
if (env.MOCK === '1' && !env.ADMIN_PASSWORD) env.ADMIN_PASSWORD = 'admin';
const PORT = env.PORT || 3000;
const handle = createApp({ storage: fileStorage(path.join(ROOT, 'data')), env });

const PUB = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    const h = {}; r.headers.forEach((v, k) => (h[k] = v));
    res.writeHead(r.status, h); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  // mesmas regras do netlify.toml
  const p = url.pathname === '/' ? '/index.html' : url.pathname.startsWith('/pedido/') ? '/pedido.html' : /^\/admin(\/|$)/.test(url.pathname) ? '/admin.html' : url.pathname;
  const fp = path.join(PUB, path.normalize(p));
  if (fp.startsWith(PUB) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); return fs.createReadStream(fp).pipe(res);
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log(`loja em http://localhost:${PORT} · admin em /admin${env.MOCK === '1' ? ' · MODO TESTE (senha: admin)' : ''}`));
