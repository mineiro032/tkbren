// loja · servidor node sem dependências
// rodar: node server.js  (config no .env)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnv();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.WIINPAY_API_KEY || '';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const WIINPAY = 'https://api-v2.wiinpay.com.br';
const MOCK = !API_KEY; // sem chave = modo teste
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (MOCK ? 'admin' : '');
const RESERVE_MIN = Number(process.env.RESERVE_MINUTES || 30); // tempo que a unidade fica presa num pix não pago

const DATA = path.join(__dirname, 'data');
const FILES = path.join(DATA, 'files'); // entregáveis: fora da pasta pública
const DB_FILE = path.join(DATA, 'db.json');
fs.mkdirSync(FILES, { recursive: true });

// ---------- banco (json) ----------
let db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : { products: [], stock: [], orders: {} };
if (!db.products.length && fs.existsSync(path.join(DATA, 'products.json'))) {
  db.products = JSON.parse(fs.readFileSync(path.join(DATA, 'products.json'), 'utf8')).map((p) => ({ active: true, ...p }));
}
if (!db.secret) db.secret = crypto.randomBytes(32).toString('hex');
const save = () => { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, DB_FILE); };
save();

const uid = (n = 6) => crypto.randomBytes(n).toString('hex');
const available = (pid) => db.stock.filter((s) => s.product_id === pid && s.status === 'available');
const productStats = (p) => {
  const units = db.stock.filter((s) => s.product_id === p.id);
  return { ...p, stock: units.filter((s) => s.status === 'available').length, reserved: units.filter((s) => s.status === 'reserved').length, sold: units.filter((s) => s.status === 'delivered').length };
};

// ---------- estoque ----------
// tudo síncrono: node roda uma coisa por vez, então duas compras nunca pegam a mesma unidade
function reserve(order) {
  for (const it of order.items) if (available(it.id).length < it.qty) return `"${it.name}" só tem ${available(it.id).length} em estoque`;
  const until = Date.now() + RESERVE_MIN * 60e3;
  order.units = [];
  for (const it of order.items) {
    for (const u of available(it.id).slice(0, it.qty)) {
      Object.assign(u, { status: 'reserved', order_id: order.id, reserved_until: until });
      order.units.push(u.id);
    }
  }
  return null;
}

function releaseExpired() {
  const now = Date.now();
  let changed = false;
  for (const u of db.stock) {
    if (u.status === 'reserved' && u.reserved_until < now) {
      const o = db.orders[u.order_id];
      if (o && o.status === 'paid') continue;
      Object.assign(u, { status: 'available', order_id: null, reserved_until: null });
      if (o) o.units = (o.units || []).filter((x) => x !== u.id);
      changed = true;
    }
  }
  if (changed) save();
}
setInterval(releaseExpired, 60e3);

// completa as unidades de um pedido pago e marca como entregues
function fulfill(order) {
  order.units ||= [];
  let missing = 0;
  for (const it of order.items) {
    const have = order.units.filter((id) => db.stock.find((s) => s.id === id)?.product_id === it.id).length;
    const fresh = available(it.id).slice(0, it.qty - have);
    for (const u of fresh) order.units.push(u.id);
    missing += it.qty - have - fresh.length;
  }
  const now = new Date().toISOString();
  for (const id of order.units) {
    const u = db.stock.find((s) => s.id === id);
    if (u.status !== 'delivered') Object.assign(u, { status: 'delivered', order_id: order.id, delivered_at: now, reserved_until: null });
  }
  order.missing = missing; // >0 = pagou mas faltou estoque · aparece no admin
}

function markPaid(order) {
  if (order.status === 'paid') return;
  order.status = 'paid';
  order.paid_at = new Date().toISOString();
  fulfill(order);
  save();
  console.log(`[pago] pedido ${order.id} · R$ ${order.total.toFixed(2)} · ${order.units.length} unidade(s) entregue(s)${order.missing ? ` · FALTOU ${order.missing}` : ''}`);
}

// estoque novo chegou: entrega primeiro pra quem pagou e ficou sem (ordem de pagamento)
function fulfillBacklog() {
  Object.values(db.orders).filter((o) => o.status === 'paid' && o.missing > 0)
    .sort((a, b) => a.paid_at.localeCompare(b.paid_at)).forEach(fulfill);
}

// ---------- wiinpay ----------
async function createPix(order) {
  if (MOCK) return { id: 'mock_' + order.id, pix: '00020126MOCKPIXCOPIAECOLA' + order.id, qr: null };
  const res = await fetch(`${WIINPAY}/payment/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      api_key: API_KEY, value: order.total, name: order.customer.name, email: order.customer.email,
      description: `pedido ${order.id}`, webhook_url: `${BASE_URL}/api/webhook/wiinpay`, metadata: { order_id: order.id },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('wiinpay: ' + JSON.stringify(body));
  const d = body.data || body;
  const pick = (...keys) => { for (const k of keys) if (d[k]) return d[k]; return null; };
  return {
    id: pick('paymentId', 'payment_id', 'id'),
    pix: pick('qr_code', 'qrcode', 'pix_copy_paste', 'pixCopiaECola', 'copy_paste', 'brcode', 'emv'),
    qr: pick('qr_code_base64', 'qrcode_base64', 'qrCodeBase64', 'image'),
  };
}
async function checkPix(paymentId) {
  if (MOCK || !paymentId) return null;
  const res = await fetch(`${WIINPAY}/payment/list/${paymentId}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${API_KEY}` } });
  const body = await res.json().catch(() => ({}));
  return body?.data?.payment?.status || body?.status || null;
}
const isPaid = (s) => s && /paid|approved|completed/i.test(s);

// ---------- auth admin ----------
const adminToken = () => crypto.createHmac('sha256', db.secret).update('admin:' + ADMIN_PASSWORD).digest('hex');
const isAdmin = (req) => ADMIN_PASSWORD && (req.headers.cookie || '').split(/;\s*/).includes('adm=' + adminToken());

// ---------- http helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const readBody = (req, limit = 40e6) => new Promise((ok, fail) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > limit) { fail(new Error('arquivo grande demais')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { ok({}); } });
});
function sendFile(res, unit) {
  const fp = path.join(FILES, unit.id);
  if (!fs.existsSync(fp)) return send(res, 404, { error: 'arquivo não encontrado' });
  res.writeHead(200, {
    'Content-Type': unit.mime || 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(unit.filename || unit.id)}`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(fp).pipe(res);
}
const deliverables = (o) => o.status !== 'paid' ? [] : (o.units || []).map((id) => db.stock.find((s) => s.id === id)).filter(Boolean).map((u) => ({
  id: u.id, product: db.products.find((p) => p.id === u.product_id)?.name || '', type: u.type, filename: u.filename, size: u.size, text: u.type === 'text' ? u.text : undefined,
}));
const publicOrder = (o) => ({ id: o.id, status: o.status, created_at: o.created_at, paid_at: o.paid_at, customer: o.customer, items: o.items, total: o.total, pix: o.pix, qr: o.qr, mock: MOCK, missing: o.missing || 0, deliverables: deliverables(o) });

// ---------- rotas ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;
  if (p.startsWith('/api/')) releaseExpired();
  try {
    // ===== loja =====
    if (req.method === 'GET' && p === '/api/products') {
      return send(res, 200, db.products.filter((x) => x.active).map((x) => { const s = productStats(x); return { id: s.id, name: s.name, description: s.description, price: s.price, image: s.image, stock: s.stock }; }));
    }

    if (req.method === 'POST' && p === '/api/checkout') {
      const { cart = [], customer = {} } = await readBody(req, 1e5);
      if (!customer.name || !customer.email || !customer.phone) return send(res, 400, { error: 'preencha nome, e-mail e whatsapp' });
      const items = cart.map(({ id, qty }) => {
        const pr = db.products.find((x) => x.id === id && x.active);
        return pr && qty > 0 ? { id, name: pr.name, price: pr.price, qty: Math.min(99, qty | 0) } : null;
      }).filter(Boolean);
      if (!items.length) return send(res, 400, { error: 'carrinho vazio' });
      const total = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
      const order = { id: uid(5).toUpperCase(), token: uid(16), status: 'pending', created_at: new Date().toISOString(),
        customer: { name: customer.name, email: customer.email, phone: customer.phone, cpf: customer.cpf || '' }, items, total, units: [] };
      const err = reserve(order); // reserva antes de gerar o pix
      if (err) return send(res, 409, { error: err });
      db.orders[order.id] = order; save();
      try {
        const pix = await createPix(order);
        Object.assign(order, { payment_id: pix.id, pix: pix.pix, qr: pix.qr }); save();
      } catch (e) {
        // falhou o pix: devolve as unidades
        for (const id of order.units) Object.assign(db.stock.find((s) => s.id === id), { status: 'available', order_id: null, reserved_until: null });
        delete db.orders[order.id]; save();
        throw e;
      }
      return send(res, 200, { id: order.id, token: order.token });
    }

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/orders\/([A-F0-9]+)$/))) {
      const o = db.orders[m[1]];
      if (!o || o.token !== url.searchParams.get('t')) return send(res, 404, { error: 'pedido não encontrado' });
      if (o.status === 'pending' && isPaid(await checkPix(o.payment_id).catch(() => null))) markPaid(o);
      return send(res, 200, publicOrder(o));
    }

    // download do entregável: só o dono do pedido, só depois de pago
    if (req.method === 'GET' && (m = p.match(/^\/api\/orders\/([A-F0-9]+)\/files\/([a-f0-9]+)$/))) {
      const o = db.orders[m[1]];
      if (!o || o.token !== url.searchParams.get('t') || o.status !== 'paid' || !o.units.includes(m[2])) return send(res, 404, { error: 'não encontrado' });
      const u = db.stock.find((s) => s.id === m[2] && s.order_id === o.id);
      if (!u || u.type !== 'file') return send(res, 404, { error: 'não encontrado' });
      return sendFile(res, u);
    }

    if (req.method === 'POST' && p === '/api/webhook/wiinpay') {
      const b = await readBody(req, 1e5);
      const d = b.data || b;
      const pid = d.payment_id || d.paymentId || d.id;
      const oid = d.metadata?.order_id;
      const o = (oid && db.orders[oid]) || Object.values(db.orders).find((x) => x.payment_id === pid);
      if (o && o.status !== 'paid') {
        const s = MOCK ? d.status : await checkPix(o.payment_id).catch(() => null); // confirma na api antes
        if (isPaid(s)) markPaid(o);
      }
      return send(res, 200, { ok: true });
    }

    if (MOCK && req.method === 'POST' && (m = p.match(/^\/api\/orders\/([A-F0-9]+)\/simulate$/)) && db.orders[m[1]]) {
      markPaid(db.orders[m[1]]); return send(res, 200, { ok: true });
    }

    // ===== admin =====
    if (req.method === 'POST' && p === '/api/admin/login') {
      const { password } = await readBody(req, 1e4);
      const a = Buffer.from(String(password || '')), b = Buffer.from(ADMIN_PASSWORD);
      if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'senha incorreta' });
      return send(res, 200, { ok: true }, { 'Set-Cookie': `adm=${adminToken()}; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000` });
    }
    if (req.method === 'POST' && p === '/api/admin/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'adm=; Path=/; Max-Age=0' });

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'login necessário' });

      if (req.method === 'GET' && p === '/api/admin/summary') {
        const paid = Object.values(db.orders).filter((o) => o.status === 'paid');
        return send(res, 200, {
          mock: MOCK,
          revenue: paid.reduce((s, o) => s + o.total, 0),
          paid: paid.length,
          pending: Object.values(db.orders).filter((o) => o.status === 'pending').length,
          stock: db.stock.filter((s) => s.status === 'available').length,
          issues: paid.filter((o) => o.missing > 0).length,
        });
      }

      if (req.method === 'GET' && p === '/api/admin/products') return send(res, 200, db.products.map(productStats));

      if (req.method === 'POST' && p === '/api/admin/products') {
        const b = await readBody(req, 1e5);
        if (!b.name || !(Number(b.price) > 0)) return send(res, 400, { error: 'nome e preço são obrigatórios' });
        const pr = { id: 'p' + uid(4), name: String(b.name), description: String(b.description || ''), price: Math.round(Number(b.price) * 100) / 100, image: String(b.image || ''), active: b.active !== false };
        db.products.push(pr); save();
        return send(res, 200, productStats(pr));
      }

      if ((m = p.match(/^\/api\/admin\/products\/([a-z0-9]+)$/))) {
        const pr = db.products.find((x) => x.id === m[1]);
        if (!pr) return send(res, 404, { error: 'produto não encontrado' });
        if (req.method === 'GET') return send(res, 200, { product: productStats(pr), units: db.stock.filter((s) => s.product_id === pr.id).map((u) => ({ ...u, text: u.type === 'text' ? u.text : undefined })) });
        if (req.method === 'PUT') {
          const b = await readBody(req, 1e5);
          if (b.name !== undefined) pr.name = String(b.name);
          if (b.description !== undefined) pr.description = String(b.description);
          if (b.price !== undefined && Number(b.price) > 0) pr.price = Math.round(Number(b.price) * 100) / 100;
          if (b.image !== undefined) pr.image = String(b.image);
          if (b.active !== undefined) pr.active = !!b.active;
          save(); return send(res, 200, productStats(pr));
        }
      }

      // adiciona unidades: { files:[{name,mime,data(base64)}] } ou { texts:["..",".."] }
      if (req.method === 'POST' && (m = p.match(/^\/api\/admin\/products\/([a-z0-9]+)\/stock$/))) {
        const pr = db.products.find((x) => x.id === m[1]);
        if (!pr) return send(res, 404, { error: 'produto não encontrado' });
        const b = await readBody(req);
        const added = [];
        for (const f of b.files || []) {
          const id = uid(8), buf = Buffer.from(f.data || '', 'base64');
          if (!buf.length) continue;
          fs.writeFileSync(path.join(FILES, id), buf);
          const u = { id, product_id: pr.id, type: 'file', filename: String(f.name || 'arquivo'), mime: String(f.mime || 'application/octet-stream'), size: buf.length, status: 'available', created_at: new Date().toISOString() };
          db.stock.push(u); added.push(u.id);
        }
        for (const t of b.texts || []) {
          if (!String(t).trim()) continue;
          const u = { id: uid(8), product_id: pr.id, type: 'text', text: String(t).trim(), status: 'available', created_at: new Date().toISOString() };
          db.stock.push(u); added.push(u.id);
        }
        fulfillBacklog();
        save(); return send(res, 200, { added: added.length });
      }

      if ((m = p.match(/^\/api\/admin\/stock\/([a-f0-9]+)$/)) && req.method === 'DELETE') {
        const u = db.stock.find((s) => s.id === m[1]);
        if (!u) return send(res, 404, { error: 'unidade não encontrada' });
        if (u.status !== 'available') return send(res, 409, { error: 'só dá pra remover unidade disponível' });
        db.stock = db.stock.filter((s) => s !== u);
        if (u.type === 'file') fs.rmSync(path.join(FILES, u.id), { force: true });
        save(); return send(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/admin\/stock\/([a-f0-9]+)\/file$/)) && req.method === 'GET') {
        const u = db.stock.find((s) => s.id === m[1] && s.type === 'file');
        return u ? sendFile(res, u) : send(res, 404, { error: 'não encontrado' });
      }

      if (req.method === 'GET' && p === '/api/admin/orders') {
        return send(res, 200, Object.values(db.orders).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((o) => ({
          id: o.id, token: o.token, status: o.status, created_at: o.created_at, paid_at: o.paid_at, customer: o.customer, items: o.items, total: o.total, missing: o.missing || 0,
          units: (o.units || []).map((id) => { const u = db.stock.find((s) => s.id === id); return u && { id: u.id, type: u.type, label: u.type === 'file' ? u.filename : u.text.slice(0, 40), status: u.status }; }).filter(Boolean),
        })));
      }
      return send(res, 404, { error: 'not found' });
    }

    // ===== estáticos =====
    const file = p === '/' ? '/index.html' : p.startsWith('/pedido/') ? '/pedido.html' : p === '/admin' || p.startsWith('/admin/') ? '/admin.html' : p;
    const pub = path.join(__dirname, 'public');
    const fp = path.join(pub, path.normalize(file));
    if (fp.startsWith(pub) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      return fs.createReadStream(fp).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message === 'arquivo grande demais' ? e.message : 'erro ao processar · tenta de novo' });
  }
}).listen(PORT, () => console.log(`loja em ${BASE_URL} · admin em ${BASE_URL}/admin ${MOCK ? '· MODO TESTE (senha admin: admin)' : '· wiinpay ativa'}`));

function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const mm = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (mm && !process.env[mm[1]]) process.env[mm[1]] = mm[2].replace(/^["']|["']$/g, '');
  }
}
