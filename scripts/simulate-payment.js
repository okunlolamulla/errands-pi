// Pretends to be the payment gateway so you can test "Quoted -> Paid" on your own computer.
//   node --env-file=.env scripts/simulate-payment.js <reference> <amountMajor> [currency] [url]
// <reference> is shown under "Payments" in the errand's detail window. Example:
//   node --env-file=.env scripts/simulate-payment.js EB-K7M2QX-1a2b3c4d 7500 NGN
// Works with PAYMENT_PROVIDER=mock or paystack (it signs the call the same way the gateway would).
import crypto from 'node:crypto';

const [reference, amount, currency = 'NGN', url = `http://localhost:${process.env.PORT || 4000}/api/webhooks/payment`] = process.argv.slice(2);
if (!reference || !amount) { console.error('Usage: node --env-file=.env scripts/simulate-payment.js <reference> <amount> [currency] [url]'); process.exit(1); }

const provider = (process.env.PAYMENT_PROVIDER || 'paystack').toLowerCase();
const minor = Math.round(Number(amount) * 100);
let body; let headers;
if (provider === 'mock') {
  body = JSON.stringify({ reference, amountMinor: minor, currency });
  headers = { 'x-mock-signature': crypto.createHmac('sha256', process.env.MOCK_WEBHOOK_SECRET || 'dev-secret').update(body).digest('hex') };
} else if (provider === 'paystack') {
  body = JSON.stringify({ event: 'charge.success', data: { id: Date.now(), status: 'success', reference, amount: minor, currency } });
  headers = { 'x-paystack-signature': crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex') };
} else { console.error('Only mock and paystack can be simulated. Flutterwave verifies with their servers, so use their test mode.'); process.exit(1); }

const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
console.log(res.status, res.ok ? 'accepted' : 'rejected');
