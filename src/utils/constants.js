export const SERVICE_TYPES = [
  'Grocery shopping', 'Moving service', 'Pharmacy pickup', 'Office errand',
  'House hunting', 'Verification errand', 'Custom errand', 'Car service', 'Care giving services',
  'Errand verification', // old name, kept so earlier requests still open
  'Shop order', // an order placed from the website shop (cart checkout)
];

export const STATUS = {
  PENDING: 'Pending Review',
  QUOTED: 'Quoted',
  PAID: 'Paid',
  ASSIGNED: 'Assigned',
  ON_THE_WAY: 'On the way',
  IN_PROGRESS: 'In Progress',
  PROOF_UPLOADED: 'Proof Uploaded',
  COMPLETED: 'Completed',
  CLOSED: 'Closed',
};

export const ERRAND_ID_RE = /^EB-[A-HJKMNP-Z2-9]{6}$/;

// An agent must attach proof notes and/or files when moving an errand to "Proof Uploaded".
export const REQUIRE_PROOF_ON_UPLOAD = true;

export const PROOF_BUCKET = 'proofs';
export const REQUEST_BUCKET = 'requests'; // photos customers attach to a request
