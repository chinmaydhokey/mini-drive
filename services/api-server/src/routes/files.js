const express = require('express');
const router = express.Router();

const fileController = require('../controllers/fileController');
const versionController = require('../controllers/versionController');
const resumableUploadController = require('../controllers/resumableUploadController');
const { authenticate } = require('../middleware/auth');
const { uploadSingle, uploadChunkSingle } = require('../middleware/upload');
const { ensureUploadDir } = require('../middleware/ensureUploadDir');

// All file routes require authentication
router.use(authenticate);

// ── Upload ───────────────────────────────────────────────────
// Order matters: authenticate → ensureUploadDir → multer → controller
router.post(
  '/upload',
  ensureUploadDir,
  uploadSingle,
  fileController.uploadFile
);

// ── Resumable Upload ─────────────────────────────────────────
router.post('/upload/init', resumableUploadController.initUpload);
router.post('/upload/chunk', uploadChunkSingle, resumableUploadController.uploadChunk);
router.post('/upload/complete', resumableUploadController.completeUpload);
router.get('/upload/status/:fileId', resumableUploadController.getUploadStatus);

// ── Storage Stats (must be before /:id to avoid matching "storage" as an ID) ──
router.get('/storage', fileController.getStorageStats);

// ── Search (must be before /:id to avoid matching "search" as an ID) ──
router.get('/search', fileController.searchFiles);

// ── List all files ───────────────────────────────────────────
router.get('/', fileController.listFiles);

// ── Single file operations ───────────────────────────────────
router.get('/:id', fileController.getFile);
router.get('/:id/download', fileController.downloadFile);
router.get('/:id/view', fileController.viewFile);
router.patch('/:id', fileController.updateFile);
router.delete('/:id', fileController.deleteFile);

// ── Version operations ───────────────────────────────────────
router.get('/:id/versions', versionController.listVersions);
router.post('/:id/versions', ensureUploadDir, uploadSingle, fileController.uploadNewVersion);
router.get('/:id/versions/:versionNum/download', versionController.downloadVersion);
router.post('/:id/versions/:versionNum/restore', versionController.restoreVersion);

module.exports = router;

