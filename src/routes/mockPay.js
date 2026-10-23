import { Router } from 'express';
import { supabase } from '../config/supabase.js';
import { confirmPayment } from '../services/payments/index.js';
import { afterPaid } from '../services/afterPaid.js';

// LOCAL TESTING ONLY (PAYMENT_PROVIDER=mock, never in production): a fake "Paystack" page so you can try
// paying, failing and cancelling on your own computer without a gateway account or real money.
const r = Router();
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const back = (ref, extra = '') => {
  const cb = process.env.PAYMENT_CALLBACK_URL || 'http://localhost:8080/#/paid';
  return `${cb}${cb.includes('?') ? '&' : '?'}reference=${encodeURIComponent(ref)}&trxref=${encodeURIComponent(ref)}${extra}`;
};

async function find(ref) {
  const { data } = await supabase.from('payments').select('reference, amount, currency, status, provider, errand_id').eq('reference', ref).maybeSingle();
  return data && data.provider === 'mock' ? data : null;
}

r.get('/:ref', async (req, res) => {
  const p = await find(req.params.ref);
  if (!p) return res.status(404).send('Unknown test payment.');
  const btn = (o, label, c) => `<form method="post" action="/mock-pay/${esc(p.reference)}/${o}"><button style="background:${c}">${label}</button></form>`;
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test payment</title>
<style>body{font-family:system-ui,sans-serif;background:#f3f6fb;display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#fff;border-radius:16px;box-shadow:0 8px 30px #0002;padding:28px;max-width:380px;width:90%;text-align:center}
.t{background:#fff3cd;color:#7a5b00;border-radius:8px;padding:6px 10px;font-size:.8rem;margin-bottom:14px}
h1{margin:.2em 0}button{width:100%;border:0;color:#fff;font-size:1rem;font-weight:700;padding:13px;border-radius:10px;margin-top:10px;cursor:pointer}
small{color:#667}</style><div class="c"><div class="t">TEST MODE. No real money is used.</div>
<small>Pay Errand Boys</small><h1>${esc(p.currency)} ${Number(p.amount).toLocaleString('en-NG')}</h1><small>${esc(p.reference)}</small>
${p.status === 'paid' ? '<p>This payment was already completed.</p>' : btn('success', 'Pay now (success)', '#0a8f4e') + btn('fail', 'Simulate a failed payment', '#d93a3a') + btn('cancel', 'Cancel', '#667')}
</div>`);
});

r.post('/:ref/:outcome', async (req, res, next) => {
  try {
    const p = await find(req.params.ref);
    if (!p) return res.status(404).send('Unknown test payment.');
    const { outcome } = req.params;
    if (outcome === 'success') {
      const applied = await confirmPayment({ provider: 'mock', reference: p.reference, amountMinor: Math.round(Number(p.amount) * 100), currency: p.currency, txnId: `mock-${Date.now()}` });
      if (applied === 'paid') await afterPaid(p.reference);
    } else if (outcome === 'fail' || outcome === 'cancel') {
      return res.redirect(303, back(p.reference, '&cancelled=1')); // nothing is charged; the order stays unpaid and the website shows the error page
    } else return res.status(404).end();
    res.redirect(303, back(p.reference));
  } catch (e) { next(e); }
});

export default r;
