import { ZodError } from 'zod';
import multer from 'multer';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Log the real database error server-side, send a generic message to the client.
export function dbFail(error) {
  console.error('[db]', error);
  throw new ApiError(500, 'Database error');
}

export function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}

// Thrown by a payment provider when a webhook's signature does not check out.
export class WebhookAuthError extends Error {}
