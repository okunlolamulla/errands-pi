import { supabase } from '../config/supabase.js';
import { ApiError, asyncHandler, dbFail } from '../utils/errors.js';
import { agentStatusSchema, parseErrandId } from '../utils/validators.js';
import { transition } from '../services/errandService.js';
import { removeProofs, uploadProofs } from '../services/storage.js';
import { REQUIRE_PROOF_ON_UPLOAD, STATUS } from '../utils/constants.js';

// Agents move their own errands forward (skipping a step is fine, going back is not):
//   Assigned -> On the way -> In Progress -> Proof Uploaded ("Completed" button, with proof)
// The admin then reviews the proof and marks it Completed.
const FROM = {
  [STATUS.ON_THE_WAY]: [STATUS.ASSIGNED],
  [STATUS.IN_PROGRESS]: [STATUS.ASSIGNED, STATUS.ON_THE_WAY],
  [STATUS.PROOF_UPLOADED]: [STATUS.ON_THE_WAY, STATUS.IN_PROGRESS],
};

// GET /api/agent/errands   the logged-in agent's jobs. No price, payment or email is included.
export const listMyErrands = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('errand_requests')
    .select('errand_id, service_type, task_description, pickup_location, delivery_location, date_time, status, contact_info, proof_notes, proof_urls, updated_at')
    .eq('assigned_agent_id', req.user.id)
    .in('status', [STATUS.ASSIGNED, STATUS.ON_THE_WAY, STATUS.IN_PROGRESS, STATUS.PROOF_UPLOADED, STATUS.COMPLETED])
    .order('updated_at', { ascending: false }).limit(100);
  if (error) dbFail(error);
  res.json(data.map(({ contact_info, proof_urls, ...job }) => ({
    ...job, customer: { name: contact_info?.name, phone: contact_info?.phone }, proof_count: (proof_urls || []).length,
  })));
});

// PUT /api/agent/errands/:id/status   (multipart/form-data, or plain JSON when there are no files)
//   fields: status = "On the way" | "In Progress" | "Proof Uploaded", proof_notes (optional)
//   files : proof (up to 5 JPEG/PNG/WebP/PDF, 5 MB each) - only with "Proof Uploaded"
export const updateStatus = asyncHandler(async (req, res) => {
  const id = parseErrandId(req.params.id);
  const { status, proof_notes } = agentStatusSchema.parse(req.body);
  const files = req.files || [];

  if (status !== STATUS.PROOF_UPLOADED && files.length > 0) {
    throw new ApiError(400, 'Proof files can only be attached when completing the errand');
  }
  if (status === STATUS.PROOF_UPLOADED && REQUIRE_PROOF_ON_UPLOAD && !proof_notes && files.length === 0) {
    throw new ApiError(400, 'Add proof notes or at least one proof file to upload proof');
  }

  let uploaded = [];
  try {
    const errand = await transition({
      id, actorId: req.user.id, allowedFrom: FROM[status],
      guard: (cur) => {
        // Same message as "not found" so agents cannot probe other agents' errands.
        if (cur.assigned_agent_id !== req.user.id) throw new ApiError(404, 'Errand not found');
      },
      // Upload only after the checks pass, so a rejected request leaves no stray files.
      prepare: async (cur) => {
        uploaded = await uploadProofs(id, files);
        return { proof_urls: [...(cur.proof_urls || []), ...uploaded], proof_notes: proof_notes ?? cur.proof_notes };
      },
      patch: { status },
      note: proof_notes,
    });
    res.json({ errand_id: errand.errand_id, status: errand.status, proof_notes: errand.proof_notes, proof_files: errand.proof_urls.length });
  } catch (err) {
    await removeProofs(uploaded); // clean up if the database update did not go through
    throw err;
  }
});
