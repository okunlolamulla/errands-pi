import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { ApiError, asyncHandler, dbFail } from '../utils/errors.js';

const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
}).strict();

// POST /api/auth/login   body: { email, password }
// Signs in with Supabase Auth and returns a short-lived access token plus the user's role.
export const login = asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  if (!process.env.SUPABASE_ANON_KEY) throw new ApiError(500, 'Server is missing SUPABASE_ANON_KEY');

  // A throwaway client per sign-in. Never sign in with the shared service-role client:
  // it would start using that person's token for every later database call.
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data?.session) throw new ApiError(401, 'Incorrect email or password');

  const { data: profile, error: dbError } = await supabase
    .from('users').select('name, role, must_change_password').eq('id', data.user.id).maybeSingle();
  if (dbError) dbFail(dbError);
  if (!profile) throw new ApiError(403, 'No profile for this account');

  res.json({ access_token: data.session.access_token, expires_in: data.session.expires_in, user: profile });
});

// ---------------------------------------------------------------- passwords
const newPassword = z.string().min(8, 'Use at least 8 characters').max(100)
  .regex(/[A-Za-z]/, 'Include at least one letter').regex(/[0-9]/, 'Include at least one number');

const anonClient = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// POST /api/auth/forgot-password   body: { email }
// Emails a reset link that opens the dashboard's /reset-password page. The answer is always the same,
// so nobody can use this to find out which emails have accounts.
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().trim().email().max(200) }).strict().parse(req.body);
  const site = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
  if (!site) console.error('[forgot-password] DASHBOARD_URL is not set in .env, so the reset link cannot point to the dashboard');
  const { error } = await anonClient().auth.resetPasswordForEmail(email, { redirectTo: site ? `${site}/reset-password` : undefined });
  if (error) console.error('[forgot-password]', error.message);
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
});

// POST /api/auth/reset-password   body: { access_token, password }
// The token comes from the link in the email (Supabase puts it in the address after the # sign).
export const resetPassword = asyncHandler(async (req, res) => {
  const { access_token, password } = z.object({ access_token: z.string().min(20).max(4000), password: newPassword }).strict().parse(req.body);
  const { data, error } = await supabase.auth.getUser(access_token);
  if (error || !data?.user) throw new ApiError(400, 'This reset link has expired or was already used. Ask for a new one.');
  const { error: upErr } = await supabase.auth.admin.updateUserById(data.user.id, { password });
  if (upErr) throw new ApiError(400, upErr.message || 'Could not change the password');
  await supabase.from('users').update({ must_change_password: false }).eq('id', data.user.id);
  res.json({ ok: true });
});

// POST /api/auth/change-password   (signed in)   body: { current_password, new_password }
export const changePassword = asyncHandler(async (req, res) => {
  const { current_password, new_password } = z.object({ current_password: z.string().min(1).max(200), new_password: newPassword }).strict().parse(req.body);
  if (current_password === new_password) throw new ApiError(400, 'Choose a password different from the current one');
  const { data, error } = await anonClient().auth.signInWithPassword({ email: req.user.email, password: current_password });
  if (error || !data?.session) throw new ApiError(400, 'The current password is not correct');
  const { error: upErr } = await supabase.auth.admin.updateUserById(req.user.id, { password: new_password });
  if (upErr) throw new ApiError(400, upErr.message || 'Could not change the password');
  await supabase.from('users').update({ must_change_password: false }).eq('id', req.user.id);
  res.json({ ok: true });
});
