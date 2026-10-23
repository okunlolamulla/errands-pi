import multer from 'multer';
import { ApiError } from '../utils/errors.js';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

// Files are held in memory, checked, then sent to the private Supabase bucket.
export const uploadProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) =>
    ALLOWED.has(file.mimetype) ? cb(null, true) : cb(new ApiError(400, 'Only JPEG, PNG, WebP or PDF files are allowed')),
}).array('proof', 5);

// Photos a customer attaches to a new request (field name "photos"): images only.
const IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const uploadRequestPhotos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) =>
    IMAGES.has(file.mimetype) ? cb(null, true) : cb(new ApiError(400, 'Only JPEG, PNG or WebP photos are allowed')),
}).array('photos', 5);

// One product picture from the admin dashboard (field name "image").
export const uploadProductImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    IMAGES.has(file.mimetype) ? cb(null, true) : cb(new ApiError(400, 'Only JPEG, PNG or WebP pictures are allowed')),
}).single('image');
