// node --test tests/    Shop checkout paid online: prices from the database, stock, retry, payment status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShop } from '../src/controllers/shop.core.js';

function fakeDb() {
  const t = {
    services: [{ name: 'Shop order', is_active: true }],
    products: [
      { id: 'rice-1', name: 'Rice', size: '5kg', price: 7500, in_stock: true, stock_qty: 10, category: { age18: false } },
      { id: 'wine-1', name: 'Red wine', size: '75cl', price: 8500, in_stock: true, stock_qty: null, category: { age18: true } },
      { id: 'gone-1', name: 'Beans', size: '1kg', price: 3000, in_stock: false, stock_qty: 0, category: { age18: false } },
    ],
    errand_requests: [], order_items: [], carts: [{ id: '11111111-1111-4111-8111-111111111111', errand_id: null, status: 'open' }], payments: [],
  };
  let n = 0; const rpcs = [];
  const from = (name) => {
    const st = { op: 'select', f: [], inn: null, row: null, patch: null };
    const run = () => {
      let rows = t[name].filter((r) => st.f.every(([k, v]) => r[k] === v) && (!st.inn || st.inn[1].includes(r[st.inn[0]])));
      if (st.op === 'insert') { const row = { ...st.row, errand_id: 'EB-SHOP' + (++n), paid_at: null }; t[name].push(row); return { data: row }; }
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.patch)); return { data: rows[0] || null }; }
      if (st.op === 'delete') { t[name] = t[name].filter((r) => !rows.includes(r)); return { data: null }; }
      return { data: st.many ? rows : (rows[0] || null) };
    };
    const q = {
      select: () => q, order: () => q, limit: () => q, eq: (k, v) => (st.f.push([k, v]), q), in: (k, v) => (st.inn = [k, v], st.many = true, q),
      insert: (r) => (st.op = 'insert', st.row = r, q), update: (p) => (st.op = 'update', st.patch = p, q), delete: () => (st.op = 'delete', q),
      maybeSingle: async () => run(), single: async () => run(), then: (res) => { st.many = true; return Promise.resolve(run()).then(res); },
    };
    return q;
  };
  const rpc = async (fn, args) => {
    rpcs.push(args);
    for (const it of args.p_items) {
      const pr = t.products.find((x) => x.id === it.id);
      if (!pr.in_stock || (pr.stock_qty != null && pr.stock_qty < it.qty)) return { error: { message: 'OUT_OF_STOCK: ' + pr.name } };
    }
    for (const it of args.p_items) { const pr = t.products.find((x) => x.id === it.id); t.order_items.push({ errand_id: args.p_errand_id, product_id: it.id, unit_price: pr.price, qty: it.qty }); if (pr.stock_qty != null) pr.stock_qty -= it.qty; }
    return { error: null };
  };
  return { t, from, rpc, rpcs };
}
const mkRes = () => { const r = { code: 200, body: null }; r.status = (c) => (r.code = c, r); r.json = (b) => (r.body = b, r); return r; };
const CART = '11111111-1111-4111-8111-111111111111';
const body = (over = {}) => ({ items: [{ id: 'rice-1', qty: 2 }], cart_id: CART, contact: { name: 'Ada', phone: '08031234567', email: 'ada@example.com' }, delivery_location: '12 Test Street, Lekki', ...over });
const calls = [];
function setup(opts = {}) {
  const db = fakeDb();
  const shop = createShop({ db, createCheckout: async ({ amount, errand }) => { calls.push({ amount, errand }); return { url: 'https://checkout.paystack.com/s1', reference: errand.errand_id + '-r' }; }, payments: opts.payments });
  return { db, shop };
}
const run = async (shop, b) => { const r = mkRes(); await shop.checkout({ body: b }, r); return r; };

test('charges the database price, ignores any price sent from the browser', async () => {
  const { shop, db } = setup();
  await assert.rejects(() => run(shop, body({ total: 1 })), (e) => e.name === 'ZodError');
  await assert.rejects(() => run(shop, body({ items: [{ id: 'rice-1', qty: 2, price: 1 }] })), (e) => e.name === 'ZodError');
  const r = await run(shop, body());
  assert.equal(r.code, 201); assert.equal(r.body.total, 15000); assert.equal(calls.at(-1).amount, 15000);
  assert.equal(db.t.errand_requests[0].quote_amount, 15000); assert.equal(db.t.errand_requests[0].status, 'Quoted');
  assert.equal(r.body.payment_url, 'https://checkout.paystack.com/s1'); assert.equal(db.t.carts[0].status, 'ordered');
});

test('out of stock / removed item: clear error, nothing created', async () => {
  const { shop, db } = setup();
  await assert.rejects(() => run(shop, body({ items: [{ id: 'gone-1', qty: 1 }] })), (e) => e.status === 409 && /out of stock/.test(e.message));
  await assert.rejects(() => run(shop, body({ items: [{ id: 'rice-1', qty: 11 }] })), (e) => e.status === 409);
  await assert.rejects(() => run(shop, body({ items: [{ id: 'nope', qty: 1 }] })), (e) => e.status === 409);
  assert.equal(db.t.errand_requests.length, 0);
});

test('alcohol needs the 18+ confirmation, email is required', async () => {
  const { shop } = setup();
  await assert.rejects(() => run(shop, body({ items: [{ id: 'wine-1', qty: 1 }] })), (e) => e.status === 400);
  assert.equal((await run(shop, body({ items: [{ id: 'wine-1', qty: 1 }], age_confirmed: true }))).body.total, 8500);
  await assert.rejects(() => run(shop, body({ contact: { name: 'Ada', phone: '08031234567' } })), (e) => e.name === 'ZodError');
});

test('retry with the same cart returns the same payment, stock taken once', async () => {
  const { shop, db } = setup();
  const a = await run(shop, body()); const b = await run(shop, body());
  assert.equal(a.body.errand_id, b.body.errand_id); assert.equal(db.t.errand_requests.length, 1); assert.equal(db.t.products[0].stock_qty, 8);
});

test('status: asks the gateway, reports paid / failed', async () => {
  let g = 'failed';
  const { shop, db } = setup({ payments: { verify: async () => { if (g === 'success') db.t.errand_requests[0].paid_at = 'now'; return g; } } });
  await run(shop, body());
  db.t.errand_requests[0].errand_id = 'EB-ABC234'; db.t.payments = [{ errand_id: 'EB-ABC234', reference: 'x', status: 'pending' }];
  const r1 = mkRes(); await shop.status({ query: { id: 'EB-ABC234' } }, r1);
  assert.equal(r1.body.paid, false); assert.equal(r1.body.gateway, 'failed'); assert.equal(r1.body.email, 'ad***@example.com');
  g = 'success'; const r2 = mkRes(); await shop.status({ query: { id: 'EB-ABC234' } }, r2);
  assert.equal(r2.body.paid, true); assert.equal(r2.body.amount, 15000);
  await assert.rejects(() => shop.status({ query: { id: 'bad' } }, mkRes()), (e) => e.status === 400);
});
