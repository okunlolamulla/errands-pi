import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import routes from './routes/index.js';
import mockPay from './routes/mockPay.js';
import { paymentWebhook } from './controllers/webhook.controller.js';
import { errorHandler, notFound } from './utils/errors.js';

const app = express();
app.set('trust proxy', 1); // correct client IPs for rate limiting behind a host's proxy
// "upgrade-insecure-requests" would break http://localhost during a test run, so only use it in production.
const csp = helmet.contentSecurityPolicy.getDefaultDirectives();
if (process.env.NODE_ENV !== 'production') delete csp['upgrade-insecure-requests'];
app.use(helmet({ contentSecurityPolicy: { directives: csp } }));

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
// The customer website must always be allowed to call the API (shop stock, tracking, order notices), so its address is
// added automatically, with and without "www.". Without this the website quietly falls back to its built-in product list.
const site = (process.env.CUSTOMER_SITE_URL || '').trim().replace(/\/$/, '');
if (site) {
  origins.push(site);
  try { const u = new URL(site); origins.push(`${u.protocol}//${u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname}${u.port ? ':' + u.port : ''}`); } catch { /* not a valid address */ }
}
app.use(cors({ origin: origins.length ? origins : false }));
// The gateway's signature is computed over the raw bytes, so this route must come before express.json().
// (/api/webhooks/paystack is kept as an alias for webhook URLs you may already have saved.)
app.post(['/api/webhooks/payment', '/api/webhooks/paystack'], express.raw({ type: '*/*', limit: '100kb' }), paymentWebhook);
app.use(express.json({ limit: '50kb' }));

// Fake pay page for local tests only (PAYMENT_PROVIDER=mock). Not mounted in production.
if (process.env.NODE_ENV !== 'production' && (process.env.PAYMENT_PROVIDER || '').toLowerCase() === 'mock') app.use('/mock-pay', mockPay);
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
