// núcleo da loja · roda igual no netlify (functions) e local (server.mjs)
// recebe um Request (padrão web) e devolve um Response
import crypto from 'node:crypto';

const WIINPAY = 'https://api-v2.wiinpay.com.br';
const uid = (n = 6) => crypto.randomBytes(n).toString('hex');
const isPaid = (s) => !!s && /paid|approved|completed/i.test(s);
const json = (code, obj, headers = {}) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export function createApp({ storage, env }) {
  const API_KEY = env.WIINPAY_API_KEY || '';
  const MOCK = env.MOCK === '1';
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
  const RESERVE_MIN = Number(env.RESERVE_MINUTES || 30);
  const MAX_FILE_MB = Number(env.MAX_FILE_MB || 4);

  // ---------- banco com trava otimista ----------
  // lê, altera e grava só se ninguém gravou no meio; senão tenta de novo.
  // é isso que impede duas compras simultâneas de levarem a mesma unidade.
  async function load() {
    const r = await storage.loadDb();
    const db = r?.db || { products: [], stock: [], orders: {} };
    db.secret ||= uid(32);
    release(db);
    return { db, version: r?.version ?? null };
  }
  async function mutate(fn) {
    for (let i = 0; i < 10; i++) {
      const { db, version } = await load();
      const result = await fn(db);
      if (await storage.saveDb(db, version)) return result;
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 120));
    }
    throw new Error('servidor ocupado · tenta de novo');
  }
  class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

  // ---------- estoque ----------
  const available = (db, pid) => db.stock.filter((s) => s.product_id === pid && s.status === 'available');
  const stats = (db, p) => {
    const u = db.stock.filter((s) => s.product_id === p.id);
    return { ...p, stock: u.filter((s) => s.status === 'available').length, reserved: u.filter((s) => s.status === 'reserved').length, sold: u.filter((s) => s.status === 'delivered').length };
  };
  function release(db) { // reservas vencidas voltam pro estoque
    const now = Date.now();
    for (const u of db.stock) {
      if (u.status !== 'reserved' || u.reserved_until > now) continue;
      const o = db.orders[u.order_id];
      if (o?.status === 'paid') continue;
      Object.assign(u, { status: 'available', order_id: null, reserved_until: null });
      if (o) o.units = (o.units || []).filter((x) => x !== u.id);
    }
  }
  function reserve(db, order) {
    for (const it of order.items) {
      const n = available(db, it.id).length;
      if (n < it.qty) return `"${it.name}" só tem ${n} em estoque`;
    }
    const until = Date.now() + RESERVE_MIN * 60e3;
    for (const it of order.items) for (const u of available(db, it.id).slice(0, it.qty)) {
      Object.assign(u, { status: 'reserved', order_id: order.id, reserved_until: until });
      order.units.push(u.id);
    }
    return null;
  }
  function fulfill(db, order) {
    order.units ||= [];
    let missing = 0;
    for (const it of order.items) {
      const have = order.units.filter((id) => db.stock.find((s) => s.id === id)?.product_id === it.id).length;
      const fresh = available(db, it.id).slice(0, it.qty - have);
      for (const u of fresh) order.units.push(u.id);
      missing += it.qty - have - fresh.length;
    }
    const now = new Date().toISOString();
    for (const id of order.units) {
      const u = db.stock.find((s) => s.id === id);
      if (u && u.status !== 'delivered') Object.assign(u, { status: 'delivered', order_id: order.id, delivered_at: now, reserved_until: null });
    }
    order.missing = missing;
  }
  const markPaid = (orderId) => mutate((db) => {
    const o = db.orders[orderId];
    if (!o || o.status === 'paid') return o;
    o.status = 'paid'; o.paid_at = new Date().toISOString();
    fulfill(db, o);
    console.log(`[pago] ${o.id} · R$ ${o.total.toFixed(2)} · ${o.units.length} unidade(s)${o.missing ? ` · faltou ${o.missing}` : ''}`);
    return o;
  });
  const fulfillBacklog = (db) => Object.values(db.orders).filter((o) => o.status === 'paid' && o.missing > 0)
    .sort((a, b) => a.paid_at.localeCompare(b.paid_at)).forEach((o) => fulfill(db, o));

  // ---------- wiinpay ----------
  async function createPix(order, baseUrl) {
    if (MOCK) return { id: 'mock_' + order.id, pix: '00020126MOCKPIXCOPIAECOLA' + order.id, qr: null };
    const res = await fetch(`${WIINPAY}/payment/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ api_key: API_KEY, value: order.total, name: order.customer.name, email: order.customer.email,
        description: `pedido ${order.id}`, webhook_url: `${baseUrl}/api/webhook/wiinpay`, metadata: { order_id: order.id } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('wiinpay create', res.status, JSON.stringify(body)); throw new HttpError(502, 'não deu pra gerar o pix agora · tenta de novo'); }
    const d = body.data || body;
    const pick = (...k) => { for (const x of k) if (d[x]) return d[x]; return null; };
    return { id: pick('paymentId', 'payment_id', 'id'), pix: pick('qr_code', 'qrcode', 'pix_copy_paste', 'pixCopiaECola', 'copy_paste', 'brcode', 'emv'), qr: pick('qr_code_base64', 'qrcode_base64', 'qrCodeBase64', 'image') };
  }
  async function checkPix(paymentId) {
    if (MOCK || !paymentId || !API_KEY) return null;
    try {
      const res = await fetch(`${WIINPAY}/payment/list/${paymentId}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${API_KEY}` } });
      const body = await res.json().catch(() => ({}));
      return body?.data?.payment?.status || body?.status || null;
    } catch { return null; }
  }

  // ---------- helpers ----------
  const adminToken = (db) => crypto.createHmac('sha256', env.SESSION_SECRET || db.secret).update('admin:' + ADMIN_PASSWORD).digest('hex');
  const isAdmin = (req, db) => !!ADMIN_PASSWORD && (req.headers.get('cookie') || '').split(/;\s*/).includes('adm=' + adminToken(db));
  async function body(req, limitBytes) {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > limitBytes) throw new HttpError(413, 'arquivo grande demais');
    try { return await req.json(); } catch { return {}; }
  }
  async function fileResponse(u) {
    const buf = await storage.getFile(u.id);
    if (!buf) return json(404, { error: 'arquivo não encontrado' });
    return new Response(buf, { headers: { 'Content-Type': u.mime || 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(u.filename || u.id)}`, 'Cache-Control': 'no-store' } });
  }
  const deliverables = (db, o) => o.status !== 'paid' ? [] : (o.units || []).map((id) => db.stock.find((s) => s.id === id)).filter(Boolean).map((u) => ({
    id: u.id, product: db.products.find((p) => p.id === u.product_id)?.name || '', type: u.type, filename: u.filename, size: u.size, text: u.type === 'text' ? u.text : undefined,
  }));
  const publicOrder = (db, o) => ({ id: o.id, status: o.status, created_at: o.created_at, paid_at: o.paid_at, customer: o.customer, items: o.items, total: o.total, pix: o.pix, qr: o.qr, mock: MOCK, missing: o.missing || 0, deliverables: deliverables(db, o) });

  // ---------- rotas ----------
  return async function handle(req) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');
    const baseUrl = (env.BASE_URL || url.origin).replace(/\/$/, '');
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    let m;
    try {
      // ===== loja =====
      if (req.method === 'GET' && p === '/api/products') {
        const { db } = await load();
        return json(200, db.products.filter((x) => x.active).map((x) => { const s = stats(db, x); return { id: s.id, name: s.name, description: s.description, price: s.price, image: s.image, stock: s.stock }; }));
      }

      if (req.method === 'POST' && p === '/api/checkout') {
        if (!API_KEY && !MOCK) return json(503, { error: 'pagamento ainda não configurado na loja' });
        const { cart = [], customer = {} } = await body(req, 1e5);
        if (!customer.name || !customer.email || !customer.phone) return json(400, { error: 'preencha nome, e-mail e whatsapp' });
        const order = await mutate((db) => {
          const items = cart.map(({ id, qty }) => {
            const pr = db.products.find((x) => x.id === id && x.active);
            return pr && qty > 0 ? { id, name: pr.name, price: pr.price, qty: Math.min(99, qty | 0) } : null;
          }).filter(Boolean);
          if (!items.length) throw new HttpError(400, 'carrinho vazio');
          const o = { id: uid(5).toUpperCase(), token: uid(16), status: 'pending', created_at: new Date().toISOString(),
            customer: { name: String(customer.name).slice(0, 120), email: String(customer.email).slice(0, 160), phone: String(customer.phone).slice(0, 30), cpf: String(customer.cpf || '').slice(0, 20) },
            items, total: Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100, units: [] };
          const err = reserve(db, o);
          if (err) throw new HttpError(409, err);
          db.orders[o.id] = o;
          return o;
        });
        let pix;
        try { pix = await createPix(order, baseUrl); }
        catch (e) {
          await mutate((db) => { // devolve as unidades
            for (const u of db.stock) if (u.order_id === order.id && u.status === 'reserved') Object.assign(u, { status: 'available', order_id: null, reserved_until: null });
            delete db.orders[order.id];
          });
          throw e;
        }
        await mutate((db) => { const o = db.orders[order.id]; if (o) Object.assign(o, { payment_id: pix.id, pix: pix.pix, qr: pix.qr }); });
        return json(200, { id: order.id, token: order.token });
      }

      if (req.method === 'GET' && (m = p.match(/^\/api\/orders\/([A-F0-9]+)$/))) {
        let { db } = await load();
        let o = db.orders[m[1]];
        if (!o || o.token !== url.searchParams.get('t')) return json(404, { error: 'pedido não encontrado' });
        if (o.status === 'pending' && isPaid(await checkPix(o.payment_id))) { await markPaid(o.id); ({ db } = await load()); o = db.orders[m[1]]; }
        return json(200, publicOrder(db, o));
      }

      if (req.method === 'GET' && (m = p.match(/^\/api\/orders\/([A-F0-9]+)\/files\/([a-f0-9]+)$/))) {
        const { db } = await load();
        const o = db.orders[m[1]];
        if (!o || o.token !== url.searchParams.get('t') || o.status !== 'paid' || !(o.units || []).includes(m[2])) return json(404, { error: 'não encontrado' });
        const u = db.stock.find((s) => s.id === m[2] && s.order_id === o.id && s.type === 'file');
        return u ? fileResponse(u) : json(404, { error: 'não encontrado' });
      }

      if (req.method === 'POST' && p === '/api/webhook/wiinpay') {
        const b = await body(req, 1e5);
        const d = b.data || b;
        const pid = d.payment_id || d.paymentId || d.id;
        const oid = d.metadata?.order_id;
        const { db } = await load();
        const o = (oid && db.orders[oid]) || Object.values(db.orders).find((x) => x.payment_id && x.payment_id === pid);
        if (o && o.status !== 'paid') {
          const s = MOCK ? d.status : await checkPix(o.payment_id); // confirma na api antes (evita webhook forjado)
          if (isPaid(s)) await markPaid(o.id);
        }
        return json(200, { ok: true });
      }

      if (MOCK && req.method === 'POST' && (m = p.match(/^\/api\/orders\/([A-F0-9]+)\/simulate$/))) {
        await markPaid(m[1]); return json(200, { ok: true });
      }

      // ===== admin =====
      if (req.method === 'POST' && p === '/api/admin/login') {
        if (!ADMIN_PASSWORD) return json(503, { error: 'configure ADMIN_PASSWORD no servidor' });
        const { password } = await body(req, 1e4);
        const a = Buffer.from(String(password || '')), b = Buffer.from(ADMIN_PASSWORD);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(401, { error: 'senha incorreta' });
        const { db, version } = await load();
        if (version === null) await storage.saveDb(db, null); // garante o secret salvo
        const { db: db2 } = await load();
        return json(200, { ok: true }, { 'Set-Cookie': `adm=${adminToken(db2)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000${secure}` });
      }
      if (req.method === 'POST' && p === '/api/admin/logout') return json(200, { ok: true }, { 'Set-Cookie': `adm=; Path=/; Max-Age=0${secure}` });

      if (p.startsWith('/api/admin/')) {
        const { db } = await load();
        if (!isAdmin(req, db)) return json(401, { error: 'login necessário' });

        if (req.method === 'GET' && p === '/api/admin/summary') {
          const orders = Object.values(db.orders), paid = orders.filter((o) => o.status === 'paid');
          return json(200, { mock: MOCK, payments: !!API_KEY || MOCK, max_file_mb: MAX_FILE_MB, revenue: paid.reduce((s, o) => s + o.total, 0), paid: paid.length,
            pending: orders.filter((o) => o.status === 'pending').length, stock: db.stock.filter((s) => s.status === 'available').length, issues: paid.filter((o) => o.missing > 0).length });
        }
        if (req.method === 'GET' && p === '/api/admin/products') return json(200, db.products.map((x) => stats(db, x)));

        if (req.method === 'POST' && p === '/api/admin/products') {
          const b = await body(req, 1e5);
          if (!b.name || !(Number(b.price) > 0)) return json(400, { error: 'nome e preço são obrigatórios' });
          const pr = await mutate((d) => {
            const x = { id: 'p' + uid(4), name: String(b.name), description: String(b.description || ''), price: Math.round(Number(b.price) * 100) / 100, image: String(b.image || ''), active: b.active !== false };
            d.products.push(x); return x;
          });
          return json(200, pr);
        }

        if ((m = p.match(/^\/api\/admin\/products\/([a-z0-9]+)$/))) {
          if (req.method === 'GET') {
            const pr = db.products.find((x) => x.id === m[1]);
            if (!pr) return json(404, { error: 'produto não encontrado' });
            return json(200, { product: stats(db, pr), units: db.stock.filter((s) => s.product_id === pr.id) });
          }
          if (req.method === 'PUT') {
            const b = await body(req, 1e5);
            const r = await mutate((d) => {
              const pr = d.products.find((x) => x.id === m[1]);
              if (!pr) throw new HttpError(404, 'produto não encontrado');
              if (b.name !== undefined) pr.name = String(b.name);
              if (b.description !== undefined) pr.description = String(b.description);
              if (b.price !== undefined && Number(b.price) > 0) pr.price = Math.round(Number(b.price) * 100) / 100;
              if (b.image !== undefined) pr.image = String(b.image);
              if (b.active !== undefined) pr.active = !!b.active;
              return stats(d, pr);
            });
            return json(200, r);
          }
        }

        // adiciona unidades: { files:[{name,mime,data(base64)}] } ou { texts:[...] }
        if (req.method === 'POST' && (m = p.match(/^\/api\/admin\/products\/([a-z0-9]+)\/stock$/))) {
          if (!db.products.find((x) => x.id === m[1])) return json(404, { error: 'produto não encontrado' });
          const b = await body(req, Math.ceil(MAX_FILE_MB * 1.4 * 1048576) + 1e5);
          const now = new Date().toISOString();
          const newUnits = [];
          for (const f of b.files || []) { // grava o arquivo antes de registrar a unidade
            const buf = Buffer.from(f.data || '', 'base64');
            if (!buf.length) continue;
            if (buf.length > MAX_FILE_MB * 1048576) return json(413, { error: `${f.name} passou de ${MAX_FILE_MB} mb` });
            const id = uid(8);
            await storage.putFile(id, buf);
            newUnits.push({ id, product_id: m[1], type: 'file', filename: String(f.name || 'arquivo'), mime: String(f.mime || 'application/octet-stream'), size: buf.length, status: 'available', created_at: now });
          }
          for (const t of b.texts || []) if (String(t).trim()) newUnits.push({ id: uid(8), product_id: m[1], type: 'text', text: String(t).trim(), status: 'available', created_at: now });
          await mutate((d) => { d.stock.push(...newUnits.map((u) => ({ ...u }))); fulfillBacklog(d); });
          return json(200, { added: newUnits.length });
        }

        if ((m = p.match(/^\/api\/admin\/stock\/([a-f0-9]+)$/)) && req.method === 'DELETE') {
          const u = await mutate((d) => {
            const x = d.stock.find((s) => s.id === m[1]);
            if (!x) throw new HttpError(404, 'unidade não encontrada');
            if (x.status !== 'available') throw new HttpError(409, 'só dá pra remover unidade disponível');
            d.stock = d.stock.filter((s) => s !== x); return x;
          });
          if (u.type === 'file') await storage.delFile(u.id);
          return json(200, { ok: true });
        }
        if ((m = p.match(/^\/api\/admin\/stock\/([a-f0-9]+)\/file$/)) && req.method === 'GET') {
          const u = db.stock.find((s) => s.id === m[1] && s.type === 'file');
          return u ? fileResponse(u) : json(404, { error: 'não encontrado' });
        }

        if (req.method === 'GET' && p === '/api/admin/orders') {
          return json(200, Object.values(db.orders).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((o) => ({
            id: o.id, token: o.token, status: o.status, created_at: o.created_at, paid_at: o.paid_at, customer: o.customer, items: o.items, total: o.total, missing: o.missing || 0,
            units: (o.units || []).map((id) => { const u = db.stock.find((s) => s.id === id); return u && { id: u.id, type: u.type, label: u.type === 'file' ? u.filename : u.text.slice(0, 40), status: u.status }; }).filter(Boolean),
          })));
        }
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) return json(e.code, { error: e.message });
      console.error(e);
      return json(500, { error: e.message === 'servidor ocupado · tenta de novo' ? e.message : 'erro ao processar · tenta de novo' });
    }
  };
}
