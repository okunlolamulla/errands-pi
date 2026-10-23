import rateLimit from 'express-rate-limit';

const base = { standardHeaders: 'draft-7', legacyHeaders: false };

export const createLimiter = rateLimit({
  ...base, windowMs: 15 * 60 * 1000, limit: 10,
  message: { error: 'Too many requests. Please try again later.' },
});

// Tracking is public and anyone with an ID can look it up, so keep guessing slow.
export const trackLimiter = rateLimit({
  ...base, windowMs: 5 * 60 * 1000, limit: 30,
  message: { error: 'Too many lookups. Please try again later.' },
});

// Slow down password guessing on the dashboard login.
export const loginLimiter = rateLimit({
  ...base, windowMs: 15 * 60 * 1000, limit: 8,
  message: { error: 'Too many sign-in attempts. Please try again later.' },
});

// The shop catalogue and the live cart are read and saved often, so allow plenty.
export const cartLimiter = rateLimit({
  ...base, windowMs: 5 * 60 * 1000, limit: 300,
  message: { error: 'Too many requests. Please try again shortly.' },
});

// Distance quotes call a paid map service, so keep each visitor to a sensible number.
export const movingLimiter = rateLimit({
  ...base, windowMs: 10 * 60 * 1000, limit: 60,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
});
