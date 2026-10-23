import { ApiError } from '../utils/errors.js';

// Road distance between two places. The key for the mapping service lives ONLY here, on the server.
//   ROUTING_PROVIDER=google (default)  uses Google Routes API (needs GOOGLE_MAPS_API_KEY)
//   ROUTING_PROVIDER=mock              fixed answers for tests on your own computer (refused in production)
// Every provider returns { km } (driving distance in kilometres, never straight-line) or throws an ApiError.

const place = (p) => {
  const text = [p.address, p.city, p.state, 'Nigeria'].filter(Boolean).join(', ');
  return text;
};
const waypoint = (p) => (Number.isFinite(p.lat) && Number.isFinite(p.lng)
  ? { location: { latLng: { latitude: p.lat, longitude: p.lng } } }
  : { address: place(p) });

export async function googleDistance(from, to, { key = process.env.GOOGLE_MAPS_API_KEY, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!key) throw new ApiError(503, 'Distance calculation is not set up yet. Please contact us to book your move.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters' },
      body: JSON.stringify({
        origin: waypoint(from), destination: waypoint(to),
        travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', // same answer every time for the same trip
        regionCode: 'NG', units: 'METRIC',
      }),
    });
  } catch (e) {
    console.error('[routing] network', e.name);
    throw new ApiError(503, 'The distance service could not be reached. Please check your connection and try again.');
  } finally { clearTimeout(timer); }

  let json = {};
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const status = json?.error?.status || '';
    console.error('[routing] google', res.status, status, json?.error?.message);
    if (res.status === 404 || status === 'NOT_FOUND') throw new ApiError(422, 'We could not find one of those addresses. Please check the street, city and state.');
    // Google also answers 400 when the KEY is wrong or restricted. That is a setup problem, not the customer's address.
    if (res.status === 400 && /api key|key not valid|expired|not authorized|billing|has not been used|disabled/i.test(json?.error?.message || '')) {
      throw new ApiError(503, 'Distance calculation is temporarily unavailable. Please try again shortly.');
    }
    if (res.status === 400) throw new ApiError(422, 'We could not read one of those addresses. Please check the street, city and state.');
    if (res.status === 429) throw new ApiError(503, 'The distance service is busy. Please try again in a minute.');
    throw new ApiError(503, 'Distance calculation is temporarily unavailable. Please try again shortly.'); // 401/403: key or billing problem (logged above)
  }
  const meters = json?.routes?.[0]?.distanceMeters;
  if (!Number.isFinite(meters) || meters <= 0) throw new ApiError(422, 'We could not find a driving route between those two addresses.');
  return { km: meters / 1000 };
}

// Test double: an address containing "[5km]" is 5 km away; "invalid" is not found; "noroute" has no road; "down" simulates an outage.
export async function mockDistance(from, to) {
  const text = `${from.address} ${to.address}`.toLowerCase();
  if (text.includes('down')) throw new ApiError(503, 'The distance service could not be reached. Please check your connection and try again.');
  if (text.includes('invalid')) throw new ApiError(422, 'We could not find one of those addresses. Please check the street, city and state.');
  if (text.includes('noroute')) throw new ApiError(422, 'We could not find a driving route between those two addresses.');
  const m = /\[(\d+(?:\.\d+)?)km\]/.exec(text);
  return { km: m ? Number(m[1]) : 7.5 };
}

export function getRouter(env = process.env) {
  const name = (env.ROUTING_PROVIDER || 'google').toLowerCase();
  if (name === 'mock') {
    if (env.NODE_ENV === 'production') throw new Error('ROUTING_PROVIDER=mock is not allowed in production');
    return { name, distance: mockDistance };
  }
  return { name: 'google', distance: (a, b) => googleDistance(a, b, { key: env.GOOGLE_MAPS_API_KEY }) };
}
