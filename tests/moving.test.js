// Run with:  node --test tests/
// Tests the moving booking rules with a fake database, fake map service and fake payment gateway (no keys needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMoving } from '../src/controllers/moving.core.js';
import { googleDistance, getRouter, mockDistance } from '../src/services/routing.js';
import { feeFor } from '../src/services/moving.js';
import { movingReceipt } from '../src/services/notify.js';

function fakeDb(seed = {}) {
  const t = { payments: [], moving_settings: [{ id: 1, small_van_rate: 4000, big_van_rate: 8000, max_distance_km: 1500 }], moving_bookings: [], errand_requests: [], services: [{ name: 'Moving service', is_active: true }], ...seed };
  let n = 0;
  const from = (name) => {
    const st = { op: 'select', filters: [], row: null, patch: null };
    const run = () => {
      const rows = t[name].filter((r) => st.filters.every(([k, v]) => r[k] === v));
      if (st.op === 'insert') {
        const row = { ...st.row };
        if (name === 'errand_requests') { row.errand_id = 'EB-TEST' + (++n); row.paid_at = null; }
        if (name === 'moving_bookings') {
          if (t.moving_bookings.some((b) => b.idempotency_key === row.idempotency_key)) return { error: { code: '23505' } };
          row.id = 'b' + (++n);
        }
        t[name].push(row); return { data: row };
      }
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.patch)); return { data: rows[0] || null }; }
      if (st.op === 'delete') { t[name] = t[name].filter((r) => !rows.includes(r)); return { data: null }; }
      return { data: rows[0] ? (name === 'moving_bookings' ? { ...rows[0], errand: t.errand_requests.find((e) => e.errand_id === rows[0].errand_id) } : rows[0]) : null };
    };
    const q = {
      select: () => q, order: () => q, limit: () => q, eq: (k, v) => (st.filters.push([k, v]), q),
      insert: (r) => (st.op = 'insert', st.row = r, q), update: (p) => (st.op = 'update', st.patch = p, q), delete: () => (st.op = 'delete', q),
      maybeSingle: async () => run(), single: async () => run(),
      then: (res) => Promise.resolve(run()).then(res),
    };
    return q;
  };
  return { t, from };
}
const mkRes = () => { const r = { code: 200, body: null }; r.status = (c) => (r.code = c, r); r.json = (b) => (r.body = b, r); return r; };
const calls = [];
const gateway = async ({ errand, amount, currency }) => { calls.push({ errand, amount, currency }); return { url: 'https://checkout.paystack.com/abc', reference: errand.errand_id + '-ref' }; };
const SECRET = 'test-secret';
const A = { address: '1 Test Street [5km]', state: 'Lagos', city: 'Ikeja' };
const B = { address: '9 Other Road', state: 'Lagos', city: 'Lekki' };
const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);

function setup(opts = {}) {
  const db = fakeDb(opts.seed);
  const router = opts.router || { name: 'mock', distance: mockDistance };
  const m = createMoving({ db, router, createCheckout: opts.gateway || gateway, secret: SECRET, now: opts.now, payments: opts.payments });
  return { db, m };
}
async function quoteOf(m, pickup = A, destination = B) {
  const res = mkRes(); await m.quote({ body: { pickup, destination } }, res); return res.body;
}
const bookBody = (q, over = {}) => ({
  quote_token: q.quote_token, vehicle: 'small', idempotency_key: crypto.randomUUID(), pickup: A, destination: B,
  contact: { name: 'Ada', phone: '08031234567', email: 'ada@example.com' },
  moving_date: future, pickup_time: '09:30', property_type: 'Room', items: ['Boxes'], ...over,
});
async function book(m, body) { const res = mkRes(); await m.book({ body }, res); return res; }

test('fee: 5, 10 and 20 km for both vans', () => {
  for (const [km, s, b] of [[5, 20000, 40000], [10, 40000, 80000], [20, 80000, 160000]]) {
    assert.equal(feeFor(km, 4000), s); assert.equal(feeFor(km, 8000), b);
  }
});

test('quote: 5 km shows 20,000 small and 40,000 big (one way, not doubled)', async () => {
  const { m } = setup(); const q = await quoteOf(m);
  assert.equal(q.distance_km, 5);
  assert.deepEqual(q.vehicles.map((v) => [v.id, v.rate, v.fee]), [['small', 4000, 20000], ['big', 8000, 40000]]);
});

test('quote: 10 km', async () => {
  const { m } = setup(); const q = await quoteOf(m, { ...A, address: 'x [10km]' }.address ? A : A);
  // the mock only knows 5 km and the 7.5 km default; use a router that returns 10
  const { m: m2 } = setup({ router: { name: 'mock', distance: async () => ({ km: 10 }) } });
  const q2 = await quoteOf(m2);
  assert.deepEqual(q2.vehicles.map((v) => v.fee), [40000, 80000]); assert.ok(q);
});

test('changing the address gives a new distance and a new fee', async () => {
  const { m } = setup();
  const a = await quoteOf(m); const b = await quoteOf(m, { ...A, address: '1 Test Street' });
  assert.equal(a.distance_km, 5); assert.equal(b.distance_km, 7.5);
  assert.equal(b.vehicles[0].fee, 30000);
});

test('switching vehicle: booking charges that vehicle only', async () => {
  const { m } = setup(); const q = await quoteOf(m);
  const r = await book(m, bookBody(q, { vehicle: 'big' }));
  assert.equal(r.code, 201); assert.equal(r.body.moving_fee, 40000); assert.equal(r.body.rate_per_km, 8000);
  assert.equal(calls.at(-1).amount, 40000); assert.equal(calls.at(-1).currency, 'NGN');
});

test('invalid address, no route and map failure give clear errors', async () => {
  for (const [addr, code] of [['invalid place', 422], ['noroute here', 422], ['service down', 503]]) {
    const { m } = setup();
    await assert.rejects(() => quoteOf(m, { ...A, address: addr }), (e) => e.status === code && e.message.length > 10, addr);
  }
});

test('Google response handling: ok, not found, quota, no key, network', async () => {
  const ok = (body, status = 200) => async () => ({ ok: status < 300, status, json: async () => body });
  const r = await googleDistance(A, B, { key: 'k', fetchImpl: ok({ routes: [{ distanceMeters: 12345 }] }) });
  assert.equal(r.km, 12.345);
  await assert.rejects(() => googleDistance(A, B, { key: 'k', fetchImpl: ok({}) }), (e) => e.status === 422);
  await assert.rejects(() => googleDistance(A, B, { key: 'k', fetchImpl: ok({}, 400) }), (e) => e.status === 422);
  await assert.rejects(() => googleDistance(A, B, { key: 'k', fetchImpl: ok({}, 429) }), (e) => e.status === 503);
  await assert.rejects(() => googleDistance(A, B, { key: '', fetchImpl: ok({}) }), (e) => e.status === 503);
  await assert.rejects(() => googleDistance(A, B, { key: 'k', fetchImpl: async () => { throw new Error('offline'); } }), (e) => e.status === 503);
  assert.throws(() => getRouter({ ROUTING_PROVIDER: 'mock', NODE_ENV: 'production' }));
});

test('fee manipulation is refused: price/distance/total fields, tampered or reused token', async () => {
  const { m } = setup(); const q = await quoteOf(m);
  for (const extra of [{ moving_fee: 1 }, { total: 1 }, { distance_km: 0.1 }, { rate_per_km: 1 }, { amount: 1 }]) {
    await assert.rejects(() => book(m, bookBody(q, extra)), (e) => e.name === 'ZodError', JSON.stringify(extra));
  }
  const [p, sig] = q.quote_token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), km: 0.1 })).toString('base64url');
  await assert.rejects(() => book(m, bookBody(q, { quote_token: forged + '.' + sig })), (e) => e.status === 409);
  await assert.rejects(() => book(m, bookBody(q, { destination: { ...B, address: 'Somewhere else far away' } })), (e) => e.status === 409);
});

test('an expired quote is refused', async () => {
  let now = Date.now();
  const { m } = setup({ now: () => now }); const q = await quoteOf(m);
  now += 31 * 60 * 1000;
  await assert.rejects(() => book(m, bookBody(q)), (e) => e.status === 409);
});

test('admin changes the rates: new quotes use them, old quotes are refused with 409', async () => {
  const { db, m } = setup(); const q = await quoteOf(m);
  const res = mkRes(); await m.adminSetSettings({ body: { small_van_rate: 5000 }, user: { id: 'u1' } }, res);
  assert.equal(res.body.small_van_rate, 5000);
  await assert.rejects(() => book(m, bookBody(q)), (e) => e.status === 409 && /updated/.test(e.message));
  const q2 = await quoteOf(m); assert.equal(q2.vehicles[0].fee, 25000);
  const r = await book(m, bookBody(q2)); assert.equal(r.body.moving_fee, 25000);
  assert.equal(db.t.moving_settings[0].big_van_rate, 8000);
  await assert.rejects(() => m.adminSetSettings({ body: { small_van_rate: -5 } }, mkRes()), (e) => e.name === 'ZodError');
});

test('double click / retry with the same key makes ONE booking and ONE checkout', async () => {
  const { db, m } = setup(); const q = await quoteOf(m); const body = bookBody(q);
  const before = calls.length;
  const a = await book(m, body); const b = await book(m, body);
  assert.equal(a.body.errand_id, b.body.errand_id);
  assert.equal(db.t.moving_bookings.length, 1); assert.equal(db.t.errand_requests.length, 1);
  assert.equal(calls.length - before, 1);
});

test('the total is the moving fee only, nothing added twice', async () => {
  const { db, m } = setup(); const q = await quoteOf(m);
  const r = await book(m, bookBody(q));
  const b = db.t.moving_bookings[0], e = db.t.errand_requests[0];
  assert.equal(b.total, b.moving_fee); assert.equal(e.quote_amount, b.moving_fee); assert.equal(e.status, 'Quoted');
  assert.equal(b.distance_km * b.rate_per_km, b.moving_fee); assert.equal(r.body.payment_url, 'https://checkout.paystack.com/abc');
  assert.equal(e.payment_link, 'https://checkout.paystack.com/abc');
});

test('payment gateway failure keeps the booking and does not crash', async () => {
  const { db, m } = setup({ gateway: async () => { throw new Error('paystack down'); } }); const q = await quoteOf(m);
  const r = await book(m, bookBody(q));
  assert.equal(r.code, 201); assert.equal(r.body.payment_url, null); assert.equal(db.t.moving_bookings.length, 1);
});

test('past date, bad phone, unknown van and bad property are refused', async () => {
  const { m } = setup(); const q = await quoteOf(m);
  for (const over of [{ moving_date: '2020-01-01' }, { contact: { name: 'A', phone: 'abc' } }, { vehicle: 'jumbo' }, { property_type: 'Castle' }]) {
    await assert.rejects(() => book(m, bookBody(q, over)), (e) => e.name === 'ZodError', JSON.stringify(over));
  }
});

test('switched-off service is refused; cancelling closes the unpaid payment', async () => {
  const off = setup({ seed: { services: [{ name: 'Moving service', is_active: false }] } });
  await assert.rejects(async () => book(off.m, bookBody(await quoteOf(off.m))), (e) => e.status === 400);
  const { db, m } = setup(); const q = await quoteOf(m); await book(m, bookBody(q));
  const res = mkRes(); await m.adminStatus({ params: { id: db.t.moving_bookings[0].id }, body: { status: 'cancelled' } }, res);
  assert.equal(db.t.moving_bookings[0].status, 'cancelled'); assert.equal(db.t.errand_requests[0].status, 'Closed');
});

test('receipt email is required, and the receipt lists the booking and the amount', async () => {
  const { m, db } = setup(); const q = await quoteOf(m);
  await assert.rejects(() => book(m, bookBody(q, { contact: { name: 'Ada', phone: '08031234567' } })), (e) => e.name === 'ZodError');
  await assert.rejects(() => book(m, bookBody(q, { contact: { name: 'Ada', phone: '08031234567', email: 'nope' } })), (e) => e.name === 'ZodError');
  await book(m, bookBody(q));
  const r = movingReceipt({ errand_id: 'EB-ABC234', contact_info: { name: 'Ada' }, paid_at: new Date().toISOString() }, { ...db.t.moving_bookings[0], pickup_address: 'A', pickup_city: 'B', pickup_state: 'C' }, 'REF-1');
  assert.match(r.text, /Amount paid: .*20,000/); assert.match(r.text, /REF-1/); assert.match(r.html, /booked on our schedule/);
});

test('thank-you status: not paid -> asks Paystack -> paid; receipt flag is reported', async () => {
  let verified = 0;
  const holder = {};
  const { db, m } = setup({ payments: { verify: async () => { verified++; Object.assign(db.t.errand_requests[0], { paid_at: 'now' }); db.t.moving_bookings[0].receipt_sent_at = 'now'; } } });
  const q = await quoteOf(m); await book(m, bookBody(q));
  const id = db.t.errand_requests[0].errand_id.replace('EB-TEST', 'EB-TEST'); // fake ids are not real format, so patch to a valid one
  db.t.errand_requests[0].errand_id = 'EB-ABC234'; db.t.moving_bookings[0].errand_id = 'EB-ABC234';
  db.t.payments = [{ errand_id: 'EB-ABC234', reference: 'EB-ABC234-x', status: 'pending' }];
  db.t.errand_requests[0].contact_info = { email: 'ada@example.com' };
  const res = mkRes(); await m.status({ query: { id: 'EB-ABC234' } }, res);
  assert.equal(verified, 1); assert.equal(res.body.paid, true); assert.equal(res.body.receipt_sent, true); assert.equal(res.body.email, 'ad***@example.com'); assert.equal(res.body.amount, 20000);
  await assert.rejects(() => m.status({ query: { id: 'bad' } }, mkRes()), (e) => e.status === 400);
  assert.ok(id && holder);
});
