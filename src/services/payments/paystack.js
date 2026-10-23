import crypto from 'node:crypto';
import { ApiError, WebhookAuthError } from '../../utils/errors.js';

export const name = 'paystack';
export const enabled = () => Boolean(process.env.PAYSTACK_SECRET_KEY);

// Returns { url } for a hosted checkout page. USD only works if Paystack enabled it on your account.
export async function createCheckout({ errandId, reference, email, amountMinor, currency }) {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, amount: amountMinor, currency, reference,
      callback_url: process.env.PAYMENT_CALLBACK_URL || undefined,
      metadata: { errand_id: errandId },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.status) {
    console.error('[paystack]', json);
    throw new ApiError(502, `Paystack could not create the payment link${json.message ? ': ' + json.message : ''}`);
  }
  return { url: json.data.authorization_url };
}

// Verifies Paystack's signature (HMAC-SHA512 of the raw body) and returns a normalised
// success event, or null for events we do not care about.
export async function parseWebhook(req) {
  const sent = Buffer.from(req.get('x-paystack-signature') || '');
  const expected = Buffer.from(crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex'));
  if (sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) throw new WebhookAuthError('bad signature');

  const event = JSON.parse(req.body.toString('utf8'));
  if (event.event !== 'charge.success' || event.data?.status !== 'success') return null;
  const d = event.data;
  return { provider: name, reference: d.reference, amountMinor: d.amount, currency: d.currency, txnId: String(d.id) };
}
