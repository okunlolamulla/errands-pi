import { ApiError } from '../utils/errors.js';
import { VEHICLES, feeFor, rateOf, roundKm, signQuote, verifyQuote } from '../services/moving.js';
import { bookSchema, quoteSchema, settingsSchema, statusSchema } from '../utils/movingSchemas.js';

// The moving-service logic, written so the database, the map service and the payment gateway are handed in.
// (controllers/moving.controller.js plugs in the real ones; the tests plug in fakes.)
export function createMoving({ db, router, createCheckout, logHistory = async () => {}, secret, now = () => Date.now(), payments = null }) {
  const fail = (error) => { console.error('[db]', error); throw new ApiError(500, 'Database error'); };

  async function loadSettings() {
    const { data, error } = await db.from('moving_settings').select('*').eq('id', 1).maybeSingle();
    if (error) fail(error);
    if (!data) throw new ApiError(503, 'Moving prices are not set up yet. Please contact us.');
    return data;
  }
  const vehicles = (s) => ['small', 'big'].map((id) => ({ id, name: VEHICLES[id].name, blurb: VEHICLES[id].blurb, rate: rateOf(s, id) }));

  // GET /api/moving/config  (public): the rates the website shows on the van cards
  async function config(req, res) {
    const s = await loadSettings();
    res.json({ currency: 'NGN', vehicles: vehicles(s) });
  }

  // POST /api/moving/quote  (public): road distance + the fee for each van, with a signed quote the booking must carry
  async function quote(req, res) {
    const { pickup, destination } = quoteSchema.parse(req.body);
    const s = await loadSettings();
    const { km } = await router.distance(pickup, destination);
    const dist = roundKm(km);
    if (dist > Number(s.max_distance_km)) throw new ApiError(422, `That route is ${dist} km, which is longer than we can quote online. Please contact us to book this move.`);
    res.json({
      distance_km: dist,
      vehicles: vehicles(s).map((v) => ({ ...v, fee: feeFor(dist, v.rate) })),
      quote_token: signQuote({ km: dist, settings: s, from: pickup, to: destination, secret, now: now() }),
    });
  }

  const bookingOut = (b, e) => ({
    errand_id: b.errand_id, vehicle: b.vehicle, distance_km: Number(b.distance_km), rate_per_km: Number(b.rate_per_km),
    moving_fee: Number(b.moving_fee), total: Number(b.total), payment_url: e?.payment_link || null,
  });

  // POST /api/moving/book  (public): checks everything again, saves the booking, opens the payment
  async function book(req, res) {
    const b = bookSchema.parse(req.body); // anything that looks like a price is rejected here (.strict())

    // A repeated click / retry with the same key returns the booking already made. Nothing is charged twice.
    const dup = await db.from('moving_bookings').select('*, errand:errand_requests(payment_link)').eq('idempotency_key', b.idempotency_key).maybeSingle();
    if (dup.error) fail(dup.error);
    if (dup.data) return res.json(bookingOut(dup.data, dup.data.errand));

    const v = verifyQuote(b.quote_token, { from: b.pickup, to: b.destination, secret, now: now() });
    if (v.error) throw new ApiError(409, v.error);
    const s = await loadSettings();
    const rate = rateOf(s, b.vehicle);
    // The rates in force now must be the ones the customer was shown. If the admin changed them meanwhile, ask again.
    if (rateOf({ small_van_rate: v.s, big_van_rate: v.b }, b.vehicle) !== rate) throw new ApiError(409, 'Our prices were just updated. Please review the new price and confirm again.');

    const svc = await db.from('services').select('is_active').eq('name', 'Moving service').maybeSingle();
    if (svc.data && !svc.data.is_active) throw new ApiError(400, 'Moving service is not available right now. Please contact us.');

    const km = roundKm(v.km);
    const fee = feeFor(km, rate); // the ONLY amount that is ever charged
    const vname = VEHICLES[b.vehicle].name;
    const when = `${b.moving_date}T${b.pickup_time}:00+01:00`;
    const details = {
      vehicle: vname, distance_km: String(km), rate_per_km: String(rate), moving_fee: String(fee),
      property_type: b.property_type, items: b.items.join(', ') || 'Not listed', pickup_city: b.pickup.city, destination_city: b.destination.city,
    };
    if (b.notes) details.notes = b.notes;

    const errandRow = {
      service_type: 'Moving service',
      task_description: `Moving (${b.property_type}): ${b.pickup.address}, ${b.pickup.city} to ${b.destination.address}, ${b.destination.city}. ${km} km, ${vname}.`,
      pickup_location: `${b.pickup.address}, ${b.pickup.city}, ${b.pickup.state}`,
      delivery_location: `${b.destination.address}, ${b.destination.city}, ${b.destination.state}`,
      date_time: when,
      contact_info: { name: b.contact.name, phone: b.contact.phone, email: b.contact.email },
      status: 'Quoted', quote_amount: fee, quote_currency: 'NGN', details,
    };
    const e = await db.from('errand_requests').insert(errandRow).select('*').single();
    if (e.error) fail(e.error);
    const errand = e.data;

    const bookingRow = {
      errand_id: errand.errand_id, idempotency_key: b.idempotency_key,
      pickup_address: b.pickup.address, pickup_state: b.pickup.state, pickup_city: b.pickup.city, pickup_lat: b.pickup.lat ?? null, pickup_lng: b.pickup.lng ?? null,
      dest_address: b.destination.address, dest_state: b.destination.state, dest_city: b.destination.city, dest_lat: b.destination.lat ?? null, dest_lng: b.destination.lng ?? null,
      distance_km: km, vehicle: b.vehicle, rate_per_km: rate, moving_fee: fee, total: fee,
      moving_date: b.moving_date, pickup_time: b.pickup_time, property_type: b.property_type, items: b.items, notes: b.notes || null,
      routing_provider: router.name,
    };
    const ins = await db.from('moving_bookings').insert(bookingRow).select('*').single();
    if (ins.error) {
      await db.from('errand_requests').delete().eq('errand_id', errand.errand_id); // no half-made booking
      if (ins.error.code === '23505') { // the same key arrived twice at the same moment
        const again = await db.from('moving_bookings').select('*, errand:errand_requests(payment_link)').eq('idempotency_key', b.idempotency_key).maybeSingle();
        if (again.data) return res.json(bookingOut(again.data, again.data.errand));
      }
      fail(ins.error);
    }
    await logHistory({ errandId: errand.errand_id, from: null, to: 'Quoted', note: `Moving booking: ${km} km, ${vname}, ${fee} NGN` });

    // Open the payment with the existing gateway, for exactly `fee`.
    let link = null;
    try {
      const checkout = await createCheckout({ errand, amount: fee, currency: 'NGN' });
      if (checkout) {
        link = checkout.url;
        const up = await db.from('errand_requests').update({ payment_link: checkout.url, payment_reference: checkout.reference }).eq('errand_id', errand.errand_id);
        if (up.error) console.error('[moving] could not save the payment link', up.error);
      }
    } catch (err) {
      console.error('[moving] checkout failed', err.message); // the booking stays; staff can re-send a payment link from the dashboard
    }
    res.status(201).json(bookingOut(ins.data, { payment_link: link }));
  }

  // GET /api/moving/status?id=EB-XXXXXX  (public): the thank-you page asks "has my payment been confirmed, and was my receipt emailed?"
  // If we have not heard from Paystack yet, ask Paystack directly (same safe confirm step as the webhook), so a late webhook never leaves the customer waiting.
  async function status(req, res) {
    const id = String(req.query.id || '').toUpperCase();
    if (!/^EB-[A-HJKMNP-Z2-9]{6}$/.test(id)) throw new ApiError(400, 'Invalid booking ID');
    const load = async () => {
      const r = await db.from('moving_bookings').select('*, errand:errand_requests(paid_at, contact_info)').eq('errand_id', id).maybeSingle();
      if (r.error) fail(r.error);
      if (!r.data) throw new ApiError(404, 'Booking not found');
      return r.data;
    };
    let b = await load();
    if (!b.errand?.paid_at && payments) {
      const p = await db.from('payments').select('reference, status').eq('errand_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (p.data && p.data.status === 'pending') {
        try { await payments.verify(p.data.reference); } catch (err) { console.error('[moving] verify failed', err.message); }
        b = await load();
      }
    }
    const email = b.errand?.contact_info?.email || '';
    const [u, d] = email.split('@');
    res.json({
      errand_id: id, paid: !!b.errand?.paid_at, receipt_sent: !!b.receipt_sent_at, amount: Number(b.total),
      email: d ? `${u.slice(0, 2)}***@${d}` : null,
    });
  }

  // ---------------------------------------------------------------- admin
  const intParam = (v, d, max) => Math.min(Math.max(parseInt(v, 10) || d, 1), max);
  const clean = (s) => String(s || '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 60);

  async function adminList(req, res) {
    const page = intParam(req.query.page, 1, 10000), per = intParam(req.query.per, 25, 100);
    const paid = req.query.payment === 'paid' ? 'paid' : req.query.payment === 'unpaid' ? 'unpaid' : '';
    let q = db.from('moving_bookings').select('*, errand:errand_requests!inner(errand_id, status, contact_info, paid_at, payment_reference, quote_amount)', { count: 'exact' });
    if (req.query.status && ['pending', 'confirmed', 'assigned', 'in_progress', 'completed', 'cancelled'].includes(req.query.status)) q = q.eq('status', req.query.status);
    if (paid === 'paid') q = q.not('errand.paid_at', 'is', null);
    if (paid === 'unpaid') q = q.is('errand.paid_at', null);
    const t = clean(req.query.q);
    if (t) q = q.or(`pickup_address.ilike.%${t}%,dest_address.ilike.%${t}%,errand_id.ilike.%${t}%`);
    const { data, error, count } = await q.order('created_at', { ascending: false }).range((page - 1) * per, page * per - 1);
    if (error) fail(error);
    const all = await db.from('moving_bookings').select('status, total, errand:errand_requests!inner(paid_at)').limit(5000);
    if (all.error) fail(all.error);
    const rows = all.data;
    const totals = {
      bookings: rows.length, pending: rows.filter((r) => r.status === 'pending').length,
      active: rows.filter((r) => ['confirmed', 'assigned', 'in_progress'].includes(r.status)).length,
      paid_value: rows.filter((r) => r.errand?.paid_at).reduce((a, r) => a + Number(r.total), 0),
      unpaid_value: rows.filter((r) => !r.errand?.paid_at && r.status !== 'cancelled').reduce((a, r) => a + Number(r.total), 0),
    };
    res.json({ rows: data, total: count ?? data.length, page, per, totals });
  }

  async function adminStatus(req, res) {
    const { status } = statusSchema.parse(req.body);
    const { data, error } = await db.from('moving_bookings').update({ status }).eq('id', req.params.id).select('*').maybeSingle();
    if (error) fail(error);
    if (!data) throw new ApiError(404, 'Booking not found');
    // A booking cancelled before it was paid also stops the payment from being applied later.
    if (status === 'cancelled') {
      await db.from('errand_requests').update({ status: 'Closed' }).eq('errand_id', data.errand_id).eq('status', 'Quoted');
    }
    res.json(data);
  }

  async function adminGetSettings(req, res) { res.json(await loadSettings()); }

  async function adminSetSettings(req, res) {
    const patch = settingsSchema.parse(req.body);
    const { data, error } = await db.from('moving_settings').update({ ...patch, updated_by: req.user?.id ?? null, updated_at: new Date(now()).toISOString() }).eq('id', 1).select('*').maybeSingle();
    if (error) fail(error);
    res.json(data);
  }

  return { config, quote, book, status, adminList, adminStatus, adminGetSettings, adminSetSettings };
}
