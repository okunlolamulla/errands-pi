import { supabase } from '../config/supabase.js';
import { asyncHandler } from '../utils/errors.js';
import { createCheckout, verifyAndApply } from '../services/payments/index.js';
import { afterPaid } from '../services/afterPaid.js';
import { logHistory } from '../services/errandService.js';
import { getRouter } from '../services/routing.js';
import { createMoving } from './moving.core.js';

// Signs the distance quotes. Set QUOTE_SECRET to any long random text; it falls back to the service key, which never leaves the server.
const secret = () => process.env.QUOTE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let impl;
const m = () => impl || (impl = createMoving({ db: supabase, router: getRouter(), createCheckout, logHistory, secret: secret(),
  payments: { verify: async (ref) => { if ((await verifyAndApply(ref)) === 'paid') await afterPaid(ref); } } }));

export const movingConfig = asyncHandler((req, res) => m().config(req, res));
export const movingQuote = asyncHandler((req, res) => m().quote(req, res));
export const movingStatus = asyncHandler((req, res) => m().status(req, res));
export const movingBook = asyncHandler((req, res) => m().book(req, res));
export const adminMovingList = asyncHandler((req, res) => m().adminList(req, res));
export const adminMovingStatus = asyncHandler((req, res) => m().adminStatus(req, res));
export const adminMovingSettings = asyncHandler((req, res) => m().adminGetSettings(req, res));
export const adminMovingSetSettings = asyncHandler((req, res) => m().adminSetSettings(req, res));
