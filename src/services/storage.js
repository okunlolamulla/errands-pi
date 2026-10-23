import { randomUUID } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { PROOF_BUCKET } from '../utils/constants.js';
import { ApiError, dbFail } from '../utils/errors.js';

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

// The browser-supplied mimetype can be faked, so check the file's real first bytes too.
export function looksLike(buf, mime) {
  const at = (sig) => sig.every((b, i) => buf[i] === b);
  if (mime === 'image/jpeg') return at([0xff, 0xd8, 0xff]);
  if (mime === 'image/png') return at([0x89, 0x50, 0x4e, 0x47]);
  if (mime === 'application/pdf') return at([0x25, 0x50, 0x44, 0x46]);
  if (mime === 'image/webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

export async function uploadProofs(errandId, files, bucket = PROOF_BUCKET) {
  const paths = [];
  try {
    for (const f of files) {
      if (!looksLike(f.buffer, f.mimetype)) throw new ApiError(400, 'One of the files is not a valid image or PDF');
      // Never use the original file name: build the path ourselves.
      const path = `${errandId}/${Date.now()}-${randomUUID()}${EXT[f.mimetype]}`;
      const { error } = await supabase.storage.from(bucket).upload(path, f.buffer, { contentType: f.mimetype, upsert: false });
      if (error) dbFail(error);
      paths.push(path);
    }
    return paths;
  } catch (err) {
    await removeProofs(paths, bucket);
    throw err;
  }
}

export async function removeProofs(paths, bucket = PROOF_BUCKET) {
  if (paths.length) await supabase.storage.from(bucket).remove(paths).catch(() => {});
}
