const express = require('express');
const router = express.Router();

const bulkController = require('../controllers/bulkController');
const { authenticate } = require('../middleware/auth');

// ── All bulk routes require authentication ───────────────────
router.post('/delete', authenticate, bulkController.bulkSoftDelete);
router.post('/restore', authenticate, bulkController.bulkRestore);
router.delete('/permanent-delete', authenticate, bulkController.bulkPermanentDelete);
router.post('/download', authenticate, bulkController.bulkDownloadZip);

module.exports = router;
