// Emails and WhatsApp messages. Every sender returns { ok, detail } and never throws,
// so a failed message can never undo a saved quote, payment or assignment.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s, max = 900) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max); // WhatsApp variables can't hold line breaks

export const formatMoney = (amount, currency) => new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(Number(amount));

// 0816 462 1148 -> 2348164621148 (set DEFAULT_COUNTRY_CODE for other countries)
export function normalizePhone(raw) {
  const cc = process.env.DEFAULT_COUNTRY_CODE || '234';
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = cc + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : null;
}

async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { ok: res.ok, json: await res.json().catch(() => ({})) };
}

export async function sendEmail({ to, subject, text, html }) {
  const { RESEND_API_KEY, EMAIL_FROM } = process.env;
  if (!RESEND_API_KEY || !EMAIL_FROM) return { ok: false, detail: 'Email is not configured on the server' };
  if (!to) return { ok: false, detail: 'No email address on file' };
  const { ok, json } = await post('https://api.resend.com/emails', { Authorization: `Bearer ${RESEND_API_KEY}` }, { from: EMAIL_FROM, to: [to], subject, text, html });
  return ok ? { ok: true, detail: `Sent to ${to}` } : { ok: false, detail: json.message || 'Email provider rejected the message' };
}

// WhatsApp Cloud API. A business can only start a chat with an APPROVED template, one per message type:
// WHATSAPP_TEMPLATE_QUOTE / _PAID / _ASSIGNED_CUSTOMER / _ASSIGNED_AGENT (see README for the wording).
const templateName = (key) => process.env[`WHATSAPP_TEMPLATE_${key}`];

export async function sendWhatsApp({ phone, template, params }) {
  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE_LANG } = process.env;
  const name = templateName(template);
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !name) return { ok: false, detail: `WhatsApp is not configured (template ${template})` };
  const to = normalizePhone(phone);
  if (!to) return { ok: false, detail: 'The phone number looks invalid' };
  const { ok, json } = await post(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name, language: { code: WHATSAPP_TEMPLATE_LANG || 'en' },
      components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: oneLine(p, 1000) })) }] },
  });
  return ok ? { ok: true, detail: `Sent to +${to}` } : { ok: false, detail: json?.error?.message || 'WhatsApp rejected the message' };
}

const safe = async (fn) => {
  try { return await fn(); } catch (err) { console.error('[notify]', err); return { ok: false, detail: 'Could not reach the provider' }; }
};
const both = async (email, whatsapp) => {
  const [e, w] = await Promise.all([safe(email), safe(whatsapp)]);
  return { email: e, whatsapp: w };
};

export function alertAdmin(subject, text) {
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (!to) return { ok: false, detail: 'ADMIN_ALERT_EMAIL is not set' };
  return safe(() => sendEmail({ to, subject, text, html: `<p>${esc(text)}</p>` }));
}

// ---- 1) Quote: the payment link, to the customer (channels chosen by the admin)
export async function sendQuote({ errand, channels, link }) {
  const out = {};
  if (!channels.length) return out;
  if (!link) {
    for (const c of channels) out[c] = { ok: false, detail: 'No payment link was created (no payment provider is configured)' };
    return out;
  }
  const name = errand.contact_info?.name || 'there';
  const amount = formatMoney(errand.quote_amount, errand.quote_currency);
  await Promise.all(channels.map(async (c) => {
    out[c] = await safe(() => (c === 'email'
      ? sendEmail({
        to: errand.contact_info?.email, subject: `Your Errand Boys quote (${errand.errand_id})`,
        text: `Hello ${name},\n\nYour quote for errand ${errand.errand_id} is ${amount}.\nPay securely here: ${link}\n\nErrand Boys`,
        html: `<p>Hello ${esc(name)},</p><p>Your quote for errand <b>${esc(errand.errand_id)}</b> is <b>${esc(amount)}</b>.</p><p><a href="${esc(link)}">Pay securely here</a></p><p>Errand Boys</p>`,
      })
      : sendWhatsApp({ phone: errand.contact_info?.phone, template: 'QUOTE', params: [name, errand.errand_id, amount, link] })));
  }));
  return out;
}

// ---- 2) Payment confirmed: receipt to the customer, and a heads-up to the admin that an agent is needed.
// (No agent is assigned yet at this point: assignment happens after payment.)
// Moving receipt: the full breakdown, emailed once the payment is confirmed.
export function movingReceipt(errand, b, reference) {
  const name = errand.contact_info?.name || 'there';
  const money = (n) => formatMoney(n, 'NGN');
  const van = b.vehicle === 'big' ? 'Big Van' : 'Small Van';
  const rows = [
    ['Receipt number', reference], ['Booking ID', errand.errand_id], ['Date paid', new Date(errand.paid_at || Date.now()).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })],
    ['Pickup', `${b.pickup_address}, ${b.pickup_city}, ${b.pickup_state}`], ['Destination', `${b.dest_address}, ${b.dest_city}, ${b.dest_state}`],
    ['Road distance', `${Number(b.distance_km)} km`], ['Van', van], ['Rate', `${money(b.rate_per_km)} per km`],
    ['Moving date', `${b.moving_date} at ${b.pickup_time}`], ['Property', b.property_type], ['Amount paid', money(b.total)],
  ];
  const text = `Hello ${name},\n\nThank you. We received your payment and your move is booked on our schedule.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nWe will contact you to confirm the details.\n\nErrand Boys`;
  const html = `<p>Hello ${esc(name)},</p><p>Thank you. We received your payment and your move is <b>booked on our schedule</b>.</p><table cellpadding="6" style="border-collapse:collapse;border:1px solid #dde">${rows.map(([k, v]) => `<tr><td style="border:1px solid #dde;color:#456">${esc(k)}</td><td style="border:1px solid #dde"><b>${esc(v)}</b></td></tr>`).join('')}</table><p>We will contact you to confirm the details.</p><p>Errand Boys</p>`;
  return { subject: `Your Errand Boys receipt (${errand.errand_id})`, text, html };
}

export async function notifyPaid(errand, moving) {
  const name = errand.contact_info?.name || 'there';
  const amount = formatMoney(errand.quote_amount, errand.quote_currency);
  let receipt = null;
  if (moving?.booking) {
    const r = movingReceipt(errand, moving.booking, moving.reference);
    receipt = await safe(() => sendEmail({ to: errand.contact_info?.email, ...r }));
  }
  const customer = receipt ? { email: receipt, whatsapp: await safe(() => sendWhatsApp({ phone: errand.contact_info?.phone, template: 'PAID', params: [name, errand.errand_id, amount] })) } : await both(
    () => sendEmail({
      to: errand.contact_info?.email, subject: `Payment received (${errand.errand_id})`,
      text: `Hello ${name},\n\nWe received your payment of ${amount} for errand ${errand.errand_id}. We are assigning an agent now and will update you.\n\nErrand Boys`,
      html: `<p>Hello ${esc(name)},</p><p>We received your payment of <b>${esc(amount)}</b> for errand <b>${esc(errand.errand_id)}</b>. We are assigning an agent now and will update you.</p><p>Errand Boys</p>`,
    }),
    () => sendWhatsApp({ phone: errand.contact_info?.phone, template: 'PAID', params: [name, errand.errand_id, amount] }),
  );
  const admin = await alertAdmin(`Paid: ${errand.errand_id} needs an agent`, `${errand.errand_id} (${errand.service_type}) was paid: ${amount}. Open the dashboard and assign an agent.`);
  return { customer, admin, receiptSent: !!receipt?.ok };
}

// ---- 3) Agent assigned: the job to the agent, and the agent's name to the customer.
export async function notifyAssigned(errand, agent) {
  const c = errand.contact_info || {};
  const when = errand.date_time ? new Date(errand.date_time).toLocaleString('en-NG') : 'flexible';
  const job = oneLine(`${errand.service_type}: ${errand.task_description}. Pickup: ${errand.pickup_location || 'n/a'}. Delivery: ${errand.delivery_location || 'n/a'}. When: ${when}. Customer: ${c.name} ${c.phone}`);
  const agentResult = await both(
    () => sendEmail({
      to: agent.email, subject: `New errand assigned: ${errand.errand_id}`,
      text: `Hello ${agent.name},\n\nYou have a new errand.\n${errand.errand_id}\n${job}\n\nErrand Boys`,
      html: `<p>Hello ${esc(agent.name)},</p><p>You have a new errand: <b>${esc(errand.errand_id)}</b></p><p>${esc(job)}</p><p>Errand Boys</p>`,
    }),
    () => sendWhatsApp({ phone: agent.phone, template: 'ASSIGNED_AGENT', params: [agent.name, errand.errand_id, errand.service_type, job] }),
  );
  const customer = await both(
    () => sendEmail({
      to: c.email, subject: `Your agent is assigned (${errand.errand_id})`,
      text: `Hello ${c.name},\n\n${agent.name} will handle errand ${errand.errand_id}. We will keep you updated.\n\nErrand Boys`,
      html: `<p>Hello ${esc(c.name)},</p><p><b>${esc(agent.name)}</b> will handle errand <b>${esc(errand.errand_id)}</b>. We will keep you updated.</p><p>Errand Boys</p>`,
    }),
    () => sendWhatsApp({ phone: c.phone, template: 'ASSIGNED_CUSTOMER', params: [c.name || 'there', errand.errand_id, agent.name] }),
  );
  return { agent: agentResult, customer };
}
