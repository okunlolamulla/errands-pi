import { WebhookAuthError } from '../utils/errors.js';
import { confirmPayment, getProvider } from '../services/payments/index.js';
import { alertAdmin } from '../services/notify.js';
import { afterPaid } from '../services/afterPaid.js';

// POST /api/webhooks/payment   (also reachable as /api/webhooks/paystack for older settings)
// The active gateway calls this when a payment succeeds. Steps:
//   1. prove the call is genuine (signature)            -> 401 if not
//   2. apply the payment in the database, atomically    -> Quoted -> Paid (idempotent, amount-checked)
//   3. answer 200 straight away                          (gateways retry slow or failing calls)
//   4. then send the notifications
export async function paymentWebhook(req, res) {
  const provider = getProvider();
  if (!provider) return res.sendStatus(503);

  let event;
  try {
    event = await provider.parseWebhook(req);
  } catch (err) {
    if (err instanceof WebhookAuthError) return res.sendStatus(401);
    console.error('[webhook] unreadable payload:', err.message);
    return res.sendStatus(400);
  }
  if (!event) return res.sendStatus(200); // an event type we ignore

  let outcome;
  try {
    outcome = await confirmPayment(event);
  } catch (err) {
    console.error('[webhook] database error', err);
    return res.sendStatus(500); // 5xx makes the gateway retry later
  }
  res.sendStatus(200);

  try {
    if (outcome === 'paid') await afterPaid(event.reference);
    else if (outcome === 'stale' || outcome === 'mismatch') {
      await alertAdmin(`Payment needs review (${event.reference})`,
        `A payment (${event.reference}) was received but could not be applied: ${outcome === 'stale' ? 'the quote changed or the errand already moved on' : 'the amount or currency did not match the quote'}. Check your gateway dashboard, refund if needed, and mark it reviewed in the admin dashboard.`);
    } else if (outcome === 'unknown_reference') console.warn('[webhook] unknown reference', event.reference);
  } catch (err) {
    console.error('[webhook] after-payment step failed', err);
  }
}
