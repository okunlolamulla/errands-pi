import { z } from 'zod';

export const PROPERTY_TYPES = ['Room', 'Self-contained apartment', 'One-bedroom apartment', 'Two-bedroom apartment', 'Three-bedroom apartment', 'Office'];
export const MOVE_ITEMS = ['Furniture', 'Mattress', 'Refrigerator', 'Television', 'Wardrobe', 'Boxes', 'Electronics', 'Other household belongings'];
export const BOOKING_STATUSES = ['pending', 'confirmed', 'assigned', 'in_progress', 'completed', 'cancelled'];

const text = (min, max) => z.string().trim().min(min).max(max);
export const place = z.object({
  address: text(5, 300),
  state: text(2, 60),
  city: text(2, 80),
  lat: z.coerce.number().min(-90).max(90).optional(), // optional map pin ("use my location")
  lng: z.coerce.number().min(-180).max(180).optional(),
}).strict().refine((p) => (p.lat === undefined) === (p.lng === undefined), 'A map pin needs both latitude and longitude');

export const quoteSchema = z.object({ pickup: place, destination: place }).strict();

const lagosToday = () => new Date(Date.now() + 3600_000).toISOString().slice(0, 10); // Nigeria is UTC+1 all year
export const bookSchema = z.object({
  quote_token: z.string().min(20).max(2000),
  vehicle: z.enum(['small', 'big']),
  idempotency_key: z.string().uuid(),
  pickup: place,
  destination: place,
  contact: z.object({
    name: text(2, 100),
    phone: z.string().trim().regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number'),
    email: z.string().trim().email('Enter the email where we should send your receipt').max(200),
  }).strict(),
  moving_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the moving date').refine((d) => d >= lagosToday(), 'The moving date cannot be in the past'),
  pickup_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Choose a pickup time'),
  property_type: z.enum(PROPERTY_TYPES),
  items: z.array(z.enum(MOVE_ITEMS)).max(MOVE_ITEMS.length).default([]),
  notes: z.string().trim().max(1500).optional(),
}).strict(); // note: there is deliberately NO price, distance or total field. The server works those out.

export const statusSchema = z.object({ status: z.enum(BOOKING_STATUSES) }).strict();
const rate = z.coerce.number().positive().max(1_000_000).transform((n) => Math.round(n * 100) / 100);
export const settingsSchema = z.object({ small_van_rate: rate.optional(), big_van_rate: rate.optional() })
  .strict().refine((o) => o.small_van_rate !== undefined || o.big_van_rate !== undefined, 'Nothing to change');
