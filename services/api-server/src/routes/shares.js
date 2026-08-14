const express = require('express');
const router = express.Router();

const shareController = require('../controllers/shareController');
const { authenticate } = require('../middleware/auth');

// Optional auth middleware — attaches req.user if token present, but doesn't 403
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();
  // Reuse the authenticate middleware but catch errors to make it optional
  authenticate(req, res, (err) => {
    // If auth fails, just continue without req.user
    next();
  });
};

// ── Authenticated routes (must be before /:token wildcard) ──
router.post('/', authenticate, shareController.createShare);
router.post('/batch', authenticate, shareController.createBatchShare);
router.post('/private', authenticate, shareController.createPrivateShare);
router.post('/batch-private', authenticate, shareController.createBatchPrivateShare);
router.get('/shared-with-me', authenticate, shareController.listSharedWithMe);
router.get('/file/:fileId', authenticate, shareController.getSharesForFile);
router.delete('/:shareId', authenticate, shareController.revokeShare);
router.patch('/:shareId/permissions', authenticate, shareController.updateSharePermissions);
router.delete('/:shareId/users/:targetUserId', authenticate, shareController.removeSharedUser);

// ── Public routes (no auth — share token IS the auth) ────────
// Uses optionalAuth so private shares can verify the user
router.get('/:token', optionalAuth, shareController.accessShare);
router.get('/:token/download', optionalAuth, shareController.downloadShare);
router.get('/:token/view', optionalAuth, shareController.viewShare);
router.get('/:token/files/:fileId/download', optionalAuth, shareController.downloadBatchFile);
router.get('/:token/files/:fileId/view', optionalAuth, shareController.viewBatchFile);

module.exports = router;
