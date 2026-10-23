import { z } from 'zod';
import { SERVICE_TYPES, ERRAND_ID_RE } from './constants.js';
import { ApiError } from './errors.js';

// Multipart forms send objects as JSON text, so parse them first.
const parseJson = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const note = (n) => z.string().trim().max(n).optional();

export const createErrandSchema = z.object({
  service_type: z.enum(SERVICE_TYPES),
  task_description: z.string().trim().min(5).max(3000), // for groceries this is the shopping list
  pickup_location: z.string().trim().max(300).optional(),
  delivery_location: z.string().trim().max(400).optional(),
  // ISO 8601, e.g. 2026-10-12T14:30:00+01:00. Empty string / null means "no preferred time".
  date_time: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.date().optional()),
  contact_info: z.preprocess(parseJson, z.object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().trim().regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number'),
    email: z.string().trim().email().max(200).optional(),
  }).strict()),
  // Extra answers from the service forms (grocery, moving, pharmacy, house hunting, ...): short text values with
  // snake_case names, e.g. { shopping_list: "...", pickup_floor: "3rd floor" }.
  details: z.preprocess(parseJson, z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().trim().max(3000))
    .refine((o) => Object.keys(o).length <= 30, 'Too many detail fields')).optional(),
  // Shop orders: the cart, so stock can be checked and taken off. Prices always come from the database, never from here.
  items: z.preprocess(parseJson, z.array(z.object({ id: z.string().trim().min(1).max(60), qty: z.coerce.number().int().min(1).max(99) }).strict()).min(1).max(80)).optional(),
  cart_id: z.string().uuid().optional(),
}).strict();

export const quoteSchema = z.object({
  quote_amount: z.coerce.number().positive().max(100_000_000).transform((n) => Math.round(n * 100) / 100),
  currency: z.enum(['NGN', 'USD']).default('NGN'),
  notify: z.array(z.enum(['email', 'whatsapp'])).max(2).default([]), // who gets the payment link
}).strict();

export const closeSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

export const assignSchema = z.object({ agent_id: z.string().uuid() }).strict();

export const paymentSchema = z.object({
  payment_reference: z.string().trim().min(4).max(100),
}).strict();

export const agentStatusSchema = z.object({
  status: z.enum(['On the way', 'In Progress', 'Proof Uploaded']),
  proof_notes: z.string().trim().max(2000).optional(),
});

// Accepts "eb-abc234" and normalises it; anything else is treated as not found.
export function parseErrandId(raw) {
  const id = String(raw || '').trim().toUpperCase();
  if (!ERRAND_ID_RE.test(id)) throw new ApiError(404, 'Errand not found');
  return id;
}

// ---- admin control panel
export const approvalSchema = z.object({
  decision: z.enum(['approve', 'disapprove']),
  note: z.string().trim().max(500).optional(),
}).strict().refine((b) => b.decision === 'approve' || (b.note && b.note.length >= 3), { message: 'Give a short reason when you disapprove', path: ['note'] });

export const serviceSchema = z.object({
  description: z.string().trim().max(600).optional(),
  icon: z.string().trim().max(8).optional(),
  base_fee: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().min(0).max(100_000_000).nullable()).optional(),
  currency: z.enum(['NGN', 'USD']).optional(),
  is_active: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(999).optional(),
}).strict();

export const customerSchema = z.object({ notes: z.string().trim().max(2000) }).strict();

// ---- stock and carts
const money = z.coerce.number().min(0).max(100_000_000).transform((n) => Math.round(n * 100) / 100);
const optNum = (schema) => z.preprocess((v) => (v === '' || v === undefined ? undefined : v), schema.optional());
const nullableNum = (schema) => z.preprocess((v) => (v === '' ? null : v), schema.nullable().optional());

export const productSchema = z.object({
  category_id: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(120),
  size: z.string().trim().max(60).optional(),
  price: money,
  was_price: nullableNum(money),
  featured: z.boolean().optional(),
  is_new: z.boolean().optional(),
  img: z.string().trim().max(500).optional(),
  in_stock: z.boolean().optional(),
  stock_qty: nullableNum(z.coerce.number().int().min(0).max(1_000_000)), // null / empty = do not track the quantity
}).strict();
export const productPatchSchema = productSchema.partial().strict();

export const categorySchema = z.object({
  name: z.string().trim().min(2).max(60),
  emoji: z.string().trim().max(8).optional(),
  tint: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #f3e3ea').optional(),
  age18: z.boolean().optional(),
  img: z.string().trim().max(500).optional(),
  sort_order: optNum(z.coerce.number().int().min(0).max(999)),
}).strict();
export const categoryPatchSchema = categorySchema.partial().strict();

export const cartSchema = z.object({
  items: z.array(z.object({ id: z.string().trim().min(1).max(60), qty: z.coerce.number().int().min(1).max(99) }).strict()).max(80),
}).strict();
