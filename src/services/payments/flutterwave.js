import crypto from 'node:crypto';
import { ApiError, WebhookAuthError } from '../../utils/errors.js';

export const name = 'flutterwave';
export const enabled = () => Boolean(process.env.FLW_SECRET_KEY && process.env.FLW_SECRET_HASH && process.env.FLW_REDIRECT_URL);

const auth = () => ({ Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' });

// Flutterwave takes the amount in major units (7500 = ₦7,500), unlike Paystack.
export async function createCheckout({ errandId, reference, email, customerName, amountMinor, currency }) {
  const res = await fetch('https://api.flutterwave.com/v3/payments', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      tx_ref: reference, amount: amountMinor / 100, currency,
      redirect_url: process.env.FLW_REDIRECT_URL,           // where the customer lands after paying
      customer: { email, name: customerName },
      meta: { errand_id: errandId },
      customizations: { title: 'Errand Boys' },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status !== 'success') {
    console.error('[flutterwave]', json);
    throw new ApiError(502, `Flutterwave could not create the payment link${json.message ? ': ' + json.message : ''}`);
  }
  return { url: json.data.link };
}

// Flutterwave's webhook "signature" is just the secret hash you chose in their dashboard,
// so we also ask Flutterwave directly whether the transaction really succeeded.
export async function parseWebhook(req) {
  const sent = Buffer.from(req.get('verif-hash') || '');
  const expected = Buffer.from(process.env.FLW_SECRET_HASH);
  if (sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) throw new WebhookAuthError('bad hash');

  const event = JSON.parse(req.body.toString('utf8'));
  if (event.event !== 'charge.completed' || event.data?.status !== 'successful') return null;

  const res = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(event.data.id)}/verify`, { headers: auth() });
  const v = await res.json().catch(() => ({}));
  if (!res.ok || v.status !== 'success' || v.data?.status !== 'successful' || v.data.tx_ref !== event.data.tx_ref) return null;
  return { provider: name, reference: v.data.tx_ref, amountMinor: Math.round(Number(v.data.amount) * 100), currency: v.data.currency, txnId: String(v.data.id) };
}
