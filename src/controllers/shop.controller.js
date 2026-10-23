import { supabase } from '../config/supabase.js';
import { asyncHandler } from '../utils/errors.js';
import { createCheckout, verifyGateway } from '../services/payments/index.js';
import { logHistory } from '../services/errandService.js';
import { afterPaid } from '../services/afterPaid.js';
import { createShop } from './shop.core.js';

let impl;
const s = () => impl || (impl = createShop({
  db: supabase, createCheckout, logHistory,
  payments: { verify: async (ref) => { const r = await verifyGateway(ref); if (r?.applied === 'paid') await afterPaid(ref); return r?.gateway ?? null; } },
}));

export const shopCheckout = asyncHandler((req, res) => s().checkout(req, res));
export const orderStatus = asyncHandler((req, res) => s().status(req, res));
