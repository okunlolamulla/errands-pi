import { supabase } from '../config/supabase.js';
import { ApiError, dbFail } from '../utils/errors.js';

export async function logHistory({ errandId, from, to, actorId, note }) {
  const { error } = await supabase.from('errand_status_history').insert({
    errand_id: errandId, from_status: from ?? null, to_status: to, actor_id: actorId ?? null, note: note ?? null,
  });
  if (error) console.error('[history]', error); // never fail the request because of the audit log
}

/**
 * The one place a status change happens.
 *  - allowedFrom : statuses the errand must currently be in
 *  - guard(cur)  : optional extra check (e.g. "is this your errand?"), throws ApiError
 *  - prepare(cur): optional async step that returns extra columns to save (e.g. uploads)
 * The update only applies if the status is still what we read (compare-and-set), so two
 * people acting at the same moment cannot both succeed.
 */
export async function transition({ id, allowedFrom, guard, prepare, patch, actorId, note }) {
  const { data: cur, error: readError } = await supabase
    .from('errand_requests').select('*').eq('errand_id', id).maybeSingle();
  if (readError) dbFail(readError);
  if (!cur) throw new ApiError(404, 'Errand not found');

  if (guard) guard(cur);
  if (!allowedFrom.includes(cur.status)) {
    throw new ApiError(409, `Not allowed while the errand is "${cur.status}"`);
  }

  const extra = prepare ? await prepare(cur) : {};
  const { data, error } = await supabase
    .from('errand_requests').update({ ...patch, ...extra })
    .eq('errand_id', id).eq('status', cur.status)
    .select().maybeSingle();
  if (error) {
    if (error.code === '23505') throw new ApiError(409, 'That payment reference is already used');
    dbFail(error);
  }
  if (!data) throw new ApiError(409, 'This errand was just changed by someone else. Reload and try again.');

  if (data.status !== cur.status) {
    await logHistory({ errandId: id, from: cur.status, to: data.status, actorId, note });
  }
  return data;
}
