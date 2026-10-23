import { createHmac, timingSafeEqual } from 'node:crypto';

// Pricing and the signed quote. Pure functions: no database, no network, easy to test.

export const VEHICLES = {
  small: { id: 'small', name: 'Small Van', blurb: 'Smaller loads, personal belongings and a few household items.' },
  big: { id: 'big', name: 'Big Van', blurb: 'Larger loads, furniture and many household items.' },
};

// One-way road distance, rounded to 0.1 km (what the customer sees), times the rate per km. Never doubled.
export const roundKm = (km) => Math.max(0.1, Math.round(km * 10) / 10);
export const feeFor = (km, rate) => Math.round(roundKm(km) * Number(rate) * 100) / 100;
export const rateOf = (settings, vehicle) => Number(vehicle === 'big' ? settings.big_van_rate : settings.small_van_rate);

// Everything about the trip that the fee depends on, in one string, so a quote cannot be reused for a different trip.
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const pt = (p) => [norm(p.address), norm(p.city), norm(p.state), Number.isFinite(p.lat) ? p.lat.toFixed(5) : '', Number.isFinite(p.lng) ? p.lng.toFixed(5) : ''].join('|');
export const tripKey = (from, to) => `${pt(from)}=>${pt(to)}`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');

export function signQuote({ km, settings, from, to, secret, now = Date.now(), ttlMs = 30 * 60 * 1000 }) {
  const body = b64({ km: roundKm(km), s: rateOf(settings, 'small'), b: rateOf(settings, 'big'), t: sign(tripKey(from, to), secret), exp: now + ttlMs });
  return `${body}.${sign(body, secret)}`;
}

// Returns the verified { km, s, b } or { error } with a message for the customer.
export function verifyQuote(token, { from, to, secret, now = Date.now() }) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return { error: 'The distance check is missing. Please calculate the distance again.' };
  const want = sign(body, secret);
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: 'The distance check is not valid. Please calculate the distance again.' };
  let q;
  try { q = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { error: 'The distance check is not valid. Please calculate the distance again.' }; }
  if (!(q.exp > now)) return { error: 'The distance check has expired. Please calculate the distance again.' };
  if (q.t !== sign(tripKey(from, to), secret)) return { error: 'The addresses changed after the distance was calculated. Please calculate it again.' };
  return { km: q.km, s: q.s, b: q.b };
}
