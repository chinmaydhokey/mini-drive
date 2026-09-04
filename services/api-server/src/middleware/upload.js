const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AppError = require('../utils/AppError');

// ── Storage configuration ────────────────────────────────────
// Files stored at: services/api-server/uploads/<userId>/<uuid>-<originalname>
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // User-specific directory (created by controller before multer runs)
    const uploadDir = path.resolve(__dirname, '../../uploads', req.user.userId);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // UUID prefix prevents filename collisions
    const storageKey = uuidv4();
    const ext = path.extname(file.originalname);
    const storageName = `${storageKey}${ext}`;

    // Attach storageKey to the request so the controller can save it to DB
    req.storageKey = storageKey;
    req.storageName = storageName;

    cb(null, storageName);
  },
});

// ── File filter ──────────────────────────────────────────────
// Block dangerous file types. Allow everything else.
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1',
]);

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return cb(new AppError(`File type "${ext}" is not allowed.`, 400), false);
  }

  cb(null, true);
};

// ── Multer instance ──────────────────────────────────────────
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB max (before chunking in Phase 6)
    files: 1,                     // single file per request
  },
});

// ── Middleware: handle multer errors gracefully ──────────────
const uploadSingle = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError('File size exceeds the 100 MB limit.', 400));
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return next(new AppError('Only one file can be uploaded at a time.', 400));
      }
      return next(new AppError(`Upload error: ${err.message}`, 400));
    }
    if (err) {
      return next(err); // AppError from fileFilter or other errors
    }
    if (!req.file) {
      return next(new AppError('No file provided. Use form field name "file".', 400));
    }
    next();
  });
};

// ── Chunk upload (in-memory buffer for forwarding to metadata service) ──
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max per chunk
    files: 1,
  },
});

const uploadChunkSingle = (req, res, next) => {
  chunkUpload.single('chunk')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError('Chunk size exceeds the 5 MB limit.', 400));
      }
      return next(new AppError(`Chunk upload error: ${err.message}`, 400));
    }
    if (err) return next(err);
    if (!req.file) {
      return next(new AppError('No chunk data provided. Use form field name "chunk".', 400));
    }
    next();
  });
};

module.exports = { uploadSingle, uploadChunkSingle };
