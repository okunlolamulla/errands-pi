import { randomBytes } from 'node:crypto';
import { supabase } from '../../config/supabase.js';
import { ApiError, dbFail } from '../../utils/errors.js';
import * as paystack from './paystack.js';
import * as flutterwave from './flutterwave.js';
import * as mock from './mock.js';

const PROVIDERS = { paystack, flutterwave, mock };

// One gateway is active at a time: PAYMENT_PROVIDER=paystack | flutterwave | mock (default paystack).
// Returns null when the chosen gateway is not configured, so the app still runs without one.
export function getProvider() {
  const p = PROVIDERS[(process.env.PAYMENT_PROVIDER || 'paystack').toLowerCase()];
  return p && p.enabled() ? p : null;
}

/**
 * Creates a checkout link for this exact errand + amount and records it in `payments` (status pending).
 * Returns { url, reference } or null when no gateway is configured.
 */
export async function createCheckout({ errand, amount, currency }) {
  const provider = getProvider();
  if (!provider) return null;

  const email = errand.contact_info?.email || process.env.PAYMENT_FALLBACK_EMAIL || process.env.PAYSTACK_FALLBACK_EMAIL;
  if (!email) throw new ApiError(400, 'The gateway needs an email: the customer gave none and PAYMENT_FALLBACK_EMAIL is not set');

  const reference = `${errand.errand_id}-${randomBytes(4).toString('hex')}`; // unique per quote
  const amountMinor = Math.round(amount * 100);
  const { url } = await provider.createCheckout({
    errandId: errand.errand_id, reference, email, customerName: errand.contact_info?.name, amountMinor, currency,
  });

  const { error } = await supabase.from('payments').insert({
    errand_id: errand.errand_id, provider: provider.name, reference, amount, currency, checkout_url: url,
  });
  if (error) dbFail(error);
  return { url, reference };
}

// Applies a confirmed payment atomically (see confirm_payment in the SQL).
// Returns 'paid' | 'already_processed' | 'unknown_reference' | 'mismatch' | 'stale'.
export async function confirmPayment(ev) {
  const { data, error } = await supabase.rpc('confirm_payment', {
    p_provider: ev.provider, p_reference: ev.reference, p_amount_minor: ev.amountMinor, p_currency: ev.currency, p_txn_id: ev.txnId,
  });
  if (error) throw error;
  return data;
}

// Asks Paystack what happened to one payment and, if it succeeded, applies it (safe to repeat).
// Returns { gateway: 'success' | 'failed' | 'abandoned' | 'pending' | ..., applied: confirm_payment result or null }, or null if Paystack is not set up / unreachable.
export async function verifyGateway(reference) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return null;
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${key}` } });
  const json = await r.json().catch(() => ({}));
  if (r.status === 404) return { gateway: 'not_started', applied: null };
  if (!r.ok || !json?.status) return null;
  const d = json.data;
  if (d.status !== 'success') return { gateway: d.status, applied: null };
  const applied = await confirmPayment({ provider: 'paystack', reference, amountMinor: d.amount, currency: d.currency, txnId: String(d.id) });
  return { gateway: 'success', applied };
}

export async function verifyAndApply(reference) {
  const r = await verifyGateway(reference);
  return r?.applied ?? null;
}
