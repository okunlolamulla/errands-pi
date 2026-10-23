import { supabase } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';

// Verifies the Supabase Auth JWT, then loads the user's role from public.users.
const make = (allowPending) => asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new ApiError(401, 'Authentication required');

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new ApiError(401, 'Invalid or expired token');

  const { data: profile, error: dbError } = await supabase
    .from('users').select('id, name, email, role, must_change_password').eq('id', data.user.id).maybeSingle();
  if (dbError) throw new ApiError(500, 'Database error');
  if (!profile) throw new ApiError(403, 'No profile for this account');

  // The default admin account must choose its own password before doing anything else.
  if (profile.must_change_password && !allowPending) throw new ApiError(403, 'Please change your password first');

  req.user = profile;
  next();
});
export const authenticate = make(false);
export const authenticateAllowPending = make(true); // only for the change-password route

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : next(new ApiError(403, 'Forbidden'));
