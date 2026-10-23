import { supabase } from '../config/supabase.js';
import { ApiError, asyncHandler, dbFail } from '../utils/errors.js';
import { approvalSchema, customerSchema, parseErrandId, serviceSchema } from '../utils/validators.js';
import { transition } from '../services/errandService.js';
import { confirmPayment } from '../services/payments/index.js';
import { STATUS } from '../utils/constants.js';

// Characters that would break a PostgREST filter string.
const clean = (s) => String(s || '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 60);
const intParam = (v, d, max) => Math.min(Math.max(parseInt(v, 10) || d, 1), max);

// ------------------------------------------------------------------ 1. overview
// GET /api/admin/overview  -> totals for the dashboard home page (one database call)
export const overview = asyncHandler(async (req, res) => {
  const { data, error } = await supabase.rpc('admin_overview');
  if (error) dbFail(error);
  res.json(data);
});

// ------------------------------------------------------------------ 2. orders
// GET /api/admin/orders?status=&service=&approval=&q=&page=&per=
export const listOrders = asyncHandler(async (req, res) => {
  const { status, service, approval, q } = req.query;
  const page = intParam(req.query.page, 1, 10000), per = intParam(req.query.per, 25, 100);
  let query = supabase.from('errand_requests').select(
    'errand_id, service_type, status, approval_status, approval_note, task_description, pickup_location, delivery_location, date_time, contact_info, quote_amount, quote_currency, paid_at, assigned_agent_id, customer_id, created_at, updated_at',
    { count: 'exact' });
  if (status) query = query.eq('status', status);
  if (service) query = query.eq('service_type', service);
  if (['pending', 'approved', 'disapproved'].includes(approval)) query = query.eq('approval_status', approval);
  if (q && clean(q)) {
    const t = clean(q);
    query = query.or(`errand_id.ilike.%${t}%,contact_info->>name.ilike.%${t}%,contact_info->>phone.ilike.%${t}%`);
  }
  const { data, error, count } = await query.order('created_at', { ascending: false }).range((page - 1) * per, page * per - 1);
  if (error) dbFail(error);
  res.json({ rows: data, total: count ?? data.length, page, per });
});

// ---------------------------------------------------------------- 3. customers
// GET /api/admin/customers?q=
export const listCustomers = asyncHandler(async (req, res) => {
  const page = intParam(req.query.page, 1, 10000), per = intParam(req.query.per, 25, 100);
  let query = supabase.from('customer_summary').select('*', { count: 'exact' });
  const t = clean(req.query.q);
  if (t) query = query.or(`name.ilike.%${t}%,phone.ilike.%${t}%,email.ilike.%${t}%`);
  const { data, error, count } = await query.order('last_order_at', { ascending: false, nullsFirst: false }).range((page - 1) * per, page * per - 1);
  if (error) dbFail(error);
  res.json({ rows: data, total: count ?? data.length, page, per });
});

// GET /api/admin/customers/:id  -> the customer and all their orders
export const getCustomer = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ApiError(404, 'Customer not found');
  const { data: customer, error } = await supabase.from('customer_summary').select('*').eq('id', id).maybeSingle();
  if (error) dbFail(error);
  if (!customer) throw new ApiError(404, 'Customer not found');
  const { data: orders, error: e2 } = await supabase.from('errand_requests')
    .select('errand_id, service_type, status, approval_status, quote_amount, quote_currency, paid_at, created_at')
    .eq('customer_id', id).order('created_at', { ascending: false }).limit(200);
  if (e2) dbFail(e2);
  res.json({ customer, orders });
});

// PUT /api/admin/customers/:id   body: { notes }
export const updateCustomer = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ApiError(404, 'Customer not found');
  const { notes } = customerSchema.parse(req.body);
  const { data, error } = await supabase.from('customers').update({ notes }).eq('id', id).select('id, notes').maybeSingle();
  if (error) dbFail(error);
  if (!data) throw new ApiError(404, 'Customer not found');
  res.json(data);
});

// ----------------------------------------------------------------- 4. services
// GET /api/admin/services  -> all services with how many orders each has had
export const listServices = asyncHandler(async (req, res) => {
  const { data: services, error } = await supabase.from('services').select('*').order('sort_order').order('id');
  if (error) dbFail(error);
  const { data: summary, error: e2 } = await supabase.rpc('admin_overview');
  if (e2) dbFail(e2);
  const stats = Object.fromEntries((summary.by_service || []).map((s) => [s.service, s]));
  res.json(services.map((s) => ({ ...s, orders: stats[s.name]?.orders || 0, revenue_ngn: stats[s.name]?.revenue_ngn || 0 })));
});

// PUT /api/admin/services/:id   body: any of description, icon, base_fee, currency, is_active, sort_order
export const updateService = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ApiError(404, 'Service not found');
  const patch = serviceSchema.parse(req.body);
  if (!Object.keys(patch).length) throw new ApiError(400, 'Nothing to change');
  const { data, error } = await supabase.from('services').update(patch).eq('id', id).select().maybeSingle();
  if (error) dbFail(error);
  if (!data) throw new ApiError(404, 'Service not found');
  res.json(data);
});

// GET /api/services  (public) -> the services that are switched on
export const publicServices = asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('services').select('name, slug, description, icon, base_fee, currency').eq('is_active', true).order('sort_order');
  if (error) dbFail(error);
  res.json(data);
});

// ----------------------------------------------------------------- 5. payments
// GET /api/admin/payments?status=&q=&page=
export const listPayments = asyncHandler(async (req, res) => {
  const page = intParam(req.query.page, 1, 10000), per = intParam(req.query.per, 25, 100);
  let query = supabase.from('payments')
    .select('id, errand_id, provider, reference, amount, currency, status, provider_txn_id, gateway_status, verified_at, paid_at, created_at, errand:errand_requests(service_type, contact_info)', { count: 'exact' });
  if (['pending', 'paid', 'stale', 'mismatch', 'resolved'].includes(req.query.status)) query = query.eq('status', req.query.status);
  const t = clean(req.query.q);
  if (t) query = query.or(`reference.ilike.%${t}%,errand_id.ilike.%${t}%`);
  const { data, error, count } = await query.order('created_at', { ascending: false }).range((page - 1) * per, page * per - 1);
  if (error) dbFail(error);

  // totals across all payments, not just this page
  const { data: all, error: e2 } = await supabase.from('payments').select('amount, currency, status').limit(5000);
  if (e2) dbFail(e2);
  const totals = { paid: {}, pending: {}, counts: {} };
  for (const p of all) {
    totals.counts[p.status] = (totals.counts[p.status] || 0) + 1;
    if (p.status === 'paid') totals.paid[p.currency] = (totals.paid[p.currency] || 0) + Number(p.amount);
    if (p.status === 'pending') totals.pending[p.currency] = (totals.pending[p.currency] || 0) + Number(p.amount);
  }
  res.json({ rows: data, total: count ?? data.length, page, per, totals });
});

// POST /api/admin/payments/:id/verify
// Asks Paystack directly what happened to this payment. If Paystack says it succeeded and we have not
// recorded it yet (for example a webhook was missed), the normal safe confirm_payment step applies it.
export const verifyPayment = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ApiError(404, 'Payment not found');
  const { data: pay, error } = await supabase.from('payments').select('*').eq('id', id).maybeSingle();
  if (error) dbFail(error);
  if (!pay) throw new ApiError(404, 'Payment not found');
  if (pay.provider !== 'paystack') throw new ApiError(400, 'Only Paystack payments can be checked here');
  if (!process.env.PAYSTACK_SECRET_KEY) throw new ApiError(503, 'Paystack is not configured on the server');

  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(pay.reference)}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  });
  const json = await r.json().catch(() => ({}));
  if (r.status === 404) { // Paystack never saw this reference: the customer has not opened the link yet
    await supabase.from('payments').update({ gateway_status: 'not_started', verified_at: new Date().toISOString() }).eq('id', id);
    return res.json({ gateway_status: 'not_started', applied: null });
  }
  if (!r.ok || !json.status) throw new ApiError(502, `Paystack could not be reached${json.message ? ': ' + json.message : ''}`);

  const d = json.data;
  await supabase.from('payments').update({ gateway_status: d.status, verified_at: new Date().toISOString() }).eq('id', id);
  let applied = null;
  if (d.status === 'success' && pay.status === 'pending') {
    applied = await confirmPayment({ provider: 'paystack', reference: pay.reference, amountMinor: d.amount, currency: d.currency, txnId: String(d.id) });
  }
  res.json({ gateway_status: d.status, gateway_amount: d.amount / 100, gateway_currency: d.currency, paid_at: d.paid_at || null, applied });
});

// ------------------------------------------------------------- 6. approval
// PUT /api/admin/errands/:id/approval   body: { decision: "approve" | "disapprove", note }
// Approve: the order may go ahead. Disapprove: the order is refused and closed (only before it is paid).
export const decideApproval = asyncHandler(async (req, res) => {
  const id = parseErrandId(req.params.id);
  const { decision, note } = approvalSchema.parse(req.body);
  const approve = decision === 'approve';
  const base = { approval_status: approve ? 'approved' : 'disapproved', approval_note: note || null, approval_by: req.user.id, approval_at: new Date().toISOString() };

  const errand = await transition({
    id, actorId: req.user.id,
    allowedFrom: approve ? [STATUS.PENDING, STATUS.QUOTED, STATUS.PAID, STATUS.ASSIGNED, STATUS.ON_THE_WAY, STATUS.IN_PROGRESS, STATUS.PROOF_UPLOADED, STATUS.COMPLETED]
                         : [STATUS.PENDING, STATUS.QUOTED],
    guard: (cur) => {
      if (!approve && cur.paid_at) throw new ApiError(409, 'This order is already paid. Refund it in Paystack, then close it from the orders list.');
    },
    patch: approve ? base : { ...base, status: STATUS.CLOSED },
    note: approve ? `Order approved${note ? ': ' + note : ''}` : `Order disapproved: ${note}`,
  });
  res.json(errand);
});
