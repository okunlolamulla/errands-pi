import { z } from 'zod';
import { ApiError } from '../utils/errors.js';

const text = (min, max) => z.string().trim().min(min).max(max);
export const shopCheckoutSchema = z.object({
  items: z.array(z.object({ id: text(1, 60), qty: z.coerce.number().int().min(1).max(99) }).strict()).min(1).max(80),
  cart_id: z.string().uuid().optional(),
  contact: z.object({
    name: text(2, 100),
    phone: z.string().trim().regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number'),
    email: z.string().trim().email('Enter the email where we should send your receipt').max(200),
  }).strict(),
  delivery_location: text(5, 400),
  landmark: z.string().trim().max(200).optional(),
  date_time: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.date().optional()),
  notes: z.string().trim().max(1000).optional(),
  age_confirmed: z.boolean().optional(),
}).strict(); // no price or total field: prices always come from the products table

const money = (n) => Math.round(Number(n) * 100) / 100;

// Shop orders paid online. The database, the payment gateway and the stock step are handed in (tests use fakes).
export function createShop({ db, createCheckout, logHistory = async () => {}, payments = null }) {
  const fail = (error) => { console.error('[db]', error); throw new ApiError(500, 'Database error'); };

  // POST /api/shop/checkout  (public)
  async function checkout(req, res) {
    const b = shopCheckoutSchema.parse(req.body);
    const svc = await db.from('services').select('is_active').eq('name', 'Shop order').maybeSingle();
    if (svc.data && !svc.data.is_active) throw new ApiError(400, 'Shop orders are not available right now. Please contact us.');

    // merge repeated products, then price everything from the database
    const qty = new Map();
    for (const i of b.items) qty.set(i.id, (qty.get(i.id) || 0) + i.qty);
    if ([...qty.values()].some((q) => q > 99)) throw new ApiError(400, 'Too many of one item.');
    const ids = [...qty.keys()];
    const p = await db.from('products').select('id, name, size, price, in_stock, stock_qty, category:product_categories(age18)').in('id', ids);
    if (p.error) fail(p.error);
    const byId = Object.fromEntries(p.data.map((x) => [x.id, x]));
    for (const id of ids) {
      const pr = byId[id];
      if (!pr) throw new ApiError(409, 'An item in your cart is no longer sold. Please refresh the shop and try again.');
      if (!pr.in_stock || (pr.stock_qty != null && pr.stock_qty < qty.get(id))) throw new ApiError(409, `Sorry, ${pr.name} is out of stock or there is not enough left. Please update your cart.`);
    }
    if (p.data.some((x) => x.category?.age18) && !b.age_confirmed) throw new ApiError(400, 'Please confirm that you are 18 or older to order alcohol.');
    const total = money(ids.reduce((a, id) => a + Number(byId[id].price) * qty.get(id), 0));
    if (!(total > 0)) throw new ApiError(400, 'Your cart total is zero.');

    // Same cart, same items, still unpaid: hand back the existing payment instead of reserving stock twice (retry / double click).
    if (b.cart_id) {
      const c = await db.from('carts').select('errand_id').eq('id', b.cart_id).maybeSingle();
      const eid = c.data?.errand_id;
      if (eid) {
        const e = await db.from('errand_requests').select('errand_id, status, payment_link, quote_amount, paid_at').eq('errand_id', eid).maybeSingle();
        const oi = await db.from('order_items').select('product_id, qty').eq('errand_id', eid);
        const same = oi.data && oi.data.length === ids.length && oi.data.every((r) => qty.get(r.product_id) === r.qty);
        if (e.data && e.data.status === 'Quoted' && !e.data.paid_at && e.data.payment_link && same && money(e.data.quote_amount) === total) {
          return res.json({ errand_id: eid, total, payment_url: e.data.payment_link });
        }
      }
    }

    const loc = b.delivery_location + (b.landmark ? ` (Landmark: ${b.landmark})` : '');
    const itemsText = ids.map((id) => `${qty.get(id)} x ${byId[id].name} (${byId[id].size || ''}) - ${money(Number(byId[id].price) * qty.get(id))}`).join('\n');
    const details = { shopping_list: itemsText.slice(0, 2900), budget: String(total), supermarket: 'Errand Boys shop' };
    if (b.landmark) details.landmark = b.landmark;
    if (b.notes) details.instructions = b.notes;
    if (p.data.some((x) => x.category?.age18)) details.age_confirmed = 'Yes';

    const e = await db.from('errand_requests').insert({
      service_type: 'Shop order', task_description: `Shop order: ${[...qty.values()].reduce((a, x) => a + x, 0)} items, total ${total}`,
      delivery_location: loc, date_time: b.date_time ? b.date_time.toISOString() : null,
      contact_info: { name: b.contact.name, phone: b.contact.phone, email: b.contact.email },
      status: 'Quoted', quote_amount: total, quote_currency: 'NGN', details,
    }).select('*').single();
    if (e.error) fail(e.error);
    const errand = e.data;

    // Check the stock and take it off; this also records the items at the database prices.
    const st = await db.rpc('place_order_items', { p_errand_id: errand.errand_id, p_items: ids.map((id) => ({ id, qty: qty.get(id) })) });
    if (st.error) {
      await db.from('errand_requests').delete().eq('errand_id', errand.errand_id);
      const m = /OUT_OF_STOCK: (.+)/.exec(st.error.message || '');
      if (m) throw new ApiError(409, `Sorry, ${m[1]} is out of stock or there is not enough left. Please update your cart.`);
      if (/UNKNOWN_PRODUCT|BAD_QUANTITY/.test(st.error.message || '')) throw new ApiError(409, 'An item in your cart is no longer sold. Please refresh the shop and try again.');
      fail(st.error);
    }
    // If a price changed between the two steps, charge what was actually recorded.
    const oi = await db.from('order_items').select('unit_price, qty').eq('errand_id', errand.errand_id);
    const charged = money((oi.data || []).reduce((a, r) => a + Number(r.unit_price) * r.qty, 0));
    if (charged > 0 && charged !== total) await db.from('errand_requests').update({ quote_amount: charged }).eq('errand_id', errand.errand_id);
    const amount = charged > 0 ? charged : total;
    if (b.cart_id) await db.from('carts').update({ status: 'ordered', errand_id: errand.errand_id }).eq('id', b.cart_id);
    await logHistory({ errandId: errand.errand_id, from: null, to: 'Quoted', note: `Shop order, paid online: ${amount} NGN` });

    let link = null;
    try {
      const co = await createCheckout({ errand: { ...errand, quote_amount: amount }, amount, currency: 'NGN' });
      if (co) {
        link = co.url;
        const up = await db.from('errand_requests').update({ payment_link: co.url, payment_reference: co.reference }).eq('errand_id', errand.errand_id);
        if (up.error) console.error('[shop] could not save the payment link', up.error);
      }
    } catch (err) { console.error('[shop] checkout failed', err.message); }
    res.status(201).json({ errand_id: errand.errand_id, total: amount, payment_url: link });
  }

  // GET /api/orders/status?id=EB-XXXXXX  (public): has this payment been confirmed? Asks the gateway if we have not heard yet.
  async function status(req, res) {
    const id = String(req.query.id || '').toUpperCase();
    if (!/^EB-[A-HJKMNP-Z2-9]{6}$/.test(id)) throw new ApiError(400, 'Invalid order ID');
    const load = async () => {
      const r = await db.from('errand_requests').select('errand_id, service_type, quote_amount, paid_at, contact_info').eq('errand_id', id).maybeSingle();
      if (r.error) fail(r.error);
      if (!r.data) throw new ApiError(404, 'Order not found');
      return r.data;
    };
    let e = await load();
    let gateway = null;
    if (!e.paid_at && payments) {
      const p = await db.from('payments').select('reference, status').eq('errand_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (p.data && p.data.status === 'pending') {
        try { gateway = await payments.verify(p.data.reference); } catch (err) { console.error('[orders] verify failed', err.message); }
        e = await load();
      } else if (p.data) gateway = p.data.status === 'paid' ? 'success' : p.data.status;
    }
    const email = e.contact_info?.email || '';
    const [u, d] = email.split('@');
    res.json({ errand_id: id, service: e.service_type, paid: !!e.paid_at, amount: Number(e.quote_amount), gateway, email: d ? `${u.slice(0, 2)}***@${d}` : null });
  }

  return { checkout, status };
}
