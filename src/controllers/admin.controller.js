import { supabase } from '../config/supabase.js';
import { ApiError, asyncHandler, dbFail } from '../utils/errors.js';
import { assignSchema, closeSchema, parseErrandId, paymentSchema, quoteSchema } from '../utils/validators.js';
import { transition } from '../services/errandService.js';
import { createCheckout } from '../services/payments/index.js';
import { notifyAssigned, sendQuote } from '../services/notify.js';
import { PROOF_BUCKET, REQUEST_BUCKET, STATUS } from '../utils/constants.js';

// PUT /api/admin/errands/:id/quote
// body: { "quote_amount": 7500, "currency": "NGN" | "USD", "notify": ["email", "whatsapp"] }
// Saves the quote, creates a checkout link with the active payment gateway, and sends it to the customer.
export const setQuote = asyncHandler(async (req, res) => {
  const id = parseErrandId(req.params.id);
  const { quote_amount, currency, notify } = quoteSchema.parse(req.body);

  let link = null;
  const errand = await transition({
    id, actorId: req.user.id,
    allowedFrom: [STATUS.PENDING, STATUS.QUOTED], // can re-quote until it is paid
    guard: (cur) => {
      if (cur.approval_status === 'disapproved') throw new ApiError(409, 'This order was disapproved');
      // Optional house rule: set REQUIRE_APPROVAL=true to stop quotes going out before an order is approved.
      if (process.env.REQUIRE_APPROVAL === 'true' && cur.approval_status !== 'approved') throw new ApiError(409, 'Approve this order first (Errand tracking)');
    },
    prepare: async (cur) => {
      const checkout = await createCheckout({ errand: cur, amount: quote_amount, currency });
      if (!checkout) return { payment_link: null, payment_reference: null }; // no gateway configured yet
      link = checkout.url;
      return { payment_link: checkout.url, payment_reference: checkout.reference };
    },
    patch: { quote_amount, quote_currency: currency, status: STATUS.QUOTED },
    note: `Quote set to ${currency} ${quote_amount}`,
  });

  // Customers are sent to OUR checkout page (it shows the quotation fee, then goes on to the gateway).
  // The page reads this code: id | service | amount | gateway link | currency.
  const site = (process.env.CUSTOMER_SITE_URL || '').replace(/\/$/, '');
  const code = Buffer.from([errand.errand_id, errand.service_type, errand.quote_amount, link || '', errand.quote_currency].join('|')).toString('base64url');
  const checkout_link = link && site ? `${site}/#/checkout?c=${code}` : link;
  const notifications = await sendQuote({ errand, channels: notify, link: checkout_link });
  res.json({ errand, payment_link: link, checkout_link, notifications });
});

// PUT /api/admin/errands/:id/assign   body: { "agent_id": "<uuid>" }
export const assignAgent = asyncHandler(async (req, res) => {
  const id = parseErrandId(req.params.id);
  const { agent_id } = assignSchema.parse(req.body);

  const { data: agent, error } = await supabase
    .from('users').select('id, name, email, phone, role, is_active').eq('id', agent_id).maybeSingle();
  if (error) dbFail(error);
  if (!agent || agent.role !== 'agent') throw new ApiError(400, 'agent_id must belong to a user with the "agent" role');
  if (!agent.is_active) throw new ApiError(400, 'That agent is not active');

  const errand = await transition({
    id, actorId: req.user.id,
    allowedFrom: [STATUS.PAID, STATUS.ASSIGNED], // only paid errands; can reassign before work starts
    patch: { assigned_agent_id: agent_id, status: STATUS.ASSIGNED },
    note: `Assigned to ${agent.name}`,
  });
  // Tell the agent about the job and the customer who their agent is.
  const notifications = await notifyAssigned(errand, agent);
  res.json({ errand, notifications });
});

// PUT /api/admin/errands/:id/payment   body: { "payment_reference": "..." }
// Manual "mark as paid" (cash/transfer, or if the Paystack webhook is not set up yet).
export const markPaid = asyncHandler(async (req, res) => {
  const id = parseErrandId(req.params.id);
  const { payment_reference } = paymentSchema.parse(req.body);
  const errand = await transition({
    id, actorId: req.user.id,
    allowedFrom: [STATUS.QUOTED],
    patch: { status: STATUS.PAID, payment_reference, paid_at: new Date().toISOString() },
    note: `Payment recorded manually (${payment_reference})`,
  });
  res.json(errand);
});

// PUT /api/admin/errands/:id/complete   Proof Uploaded -> Completed (admin approves the proof)
export const completeErrand = asyncHandler(async (req, res) => {
  const id = parseErrandId(req.params.id);
  const errand = await transition({
    id, actorId: req.user.id, allowedFrom: [STATUS.PROOF_UPLOADED],
    patch: { status: STATUS.COMPLETED }, note: 'Proof approved',
  });
  res.json(errand);
});

// PUT /api/admin/errands/:id/close   body: { "note": "..." }
// Closes the request. Normal path: Completed -> Closed. Closing anything else needs a reason.
export const closeErrand = asyncHandler(async (req, res) => {
  const id = parseErrandId(req.params.id);
  const { note } = closeSchema.parse(req.body);
  const errand = await transition({
    id, actorId: req.user.id,
    allowedFrom: Object.values(STATUS).filter((s) => s !== STATUS.CLOSED),
    guard: (cur) => {
      if (cur.status !== STATUS.COMPLETED && (!note || note.length < 3)) {
        throw new ApiError(400, 'Add a reason to close an errand that is not completed');
      }
    },
    patch: { status: STATUS.CLOSED }, note: note || 'Closed by admin',
  });
  res.json(errand);
});

// ------------------------------------------------------------ read endpoints (dashboard)

// GET /api/admin/errands   (latest 200, newest first)
export const listErrands = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('errand_requests')
    .select('errand_id, service_type, task_description, date_time, status, quote_amount, quote_currency, assigned_agent_id, contact_info, created_at, updated_at')
    .order('created_at', { ascending: false }).limit(200);
  if (error) dbFail(error);
  res.json(data);
});

// GET /api/admin/errands/:id   full record + history + 1-hour links to proof files
export const getErrand = asyncHandler(async (req, res) => {
  const id = parseErrandId(req.params.id);
  const [errandRes, historyRes, paymentsRes, movingRes] = await Promise.all([
    supabase.from('errand_requests').select('*').eq('errand_id', id).maybeSingle(),
    supabase.from('errand_status_history').select('from_status, to_status, note, created_at')
      .eq('errand_id', id).order('created_at'),
    supabase.from('payments').select('id, provider, reference, amount, currency, status, created_at, paid_at')
      .eq('errand_id', id).order('created_at'),
    supabase.from('moving_bookings').select('*').eq('errand_id', id).maybeSingle(),
  ]);
  if (errandRes.error || historyRes.error || paymentsRes.error) dbFail(errandRes.error || historyRes.error || paymentsRes.error);
  if (!errandRes.data) throw new ApiError(404, 'Errand not found');

  const proof_links = [];
  for (const path of errandRes.data.proof_urls || []) {
    const { data } = await supabase.storage.from(PROOF_BUCKET).createSignedUrl(path, 3600);
    if (data?.signedUrl) proof_links.push(data.signedUrl);
  }
  const request_photo_links = [];
  for (const path of errandRes.data.request_files || []) {
    const { data } = await supabase.storage.from(REQUEST_BUCKET).createSignedUrl(path, 3600);
    if (data?.signedUrl) request_photo_links.push(data.signedUrl);
  }
  res.json({ ...errandRes.data, proof_links, request_photo_links, history: historyRes.data, payments: paymentsRes.data, moving: movingRes.error ? null : movingRes.data });
});

// GET /api/admin/agents   (the dashboard shows only is_active agents in the dropdown)
export const listAgents = asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('users').select('id, name, phone, is_active').eq('role', 'agent').order('name');
  if (error) dbFail(error);
  res.json(data);
});

// GET /api/admin/payments/issues   payments that arrived but could not be applied (need a human)
export const listPaymentIssues = asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('payments')
    .select('id, errand_id, provider, reference, amount, currency, status, paid_at')
    .in('status', ['stale', 'mismatch']).order('created_at', { ascending: false });
  if (error) dbFail(error);
  res.json(data);
});

// PUT /api/admin/payments/:id/resolve   mark a stale/mismatch payment as reviewed
export const resolvePayment = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, 'Payment not found');
  const { data, error } = await supabase.from('payments').update({ status: 'resolved' })
    .eq('id', id).in('status', ['stale', 'mismatch']).select('id, status').maybeSingle();
  if (error) dbFail(error);
  if (!data) throw new ApiError(404, 'No payment needing review with that id');
  res.json(data);
});
