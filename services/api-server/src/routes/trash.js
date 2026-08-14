const express = require('express');
const router = express.Router();

const trashController = require('../controllers/trashController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/trash — list all trashed items
router.get('/', trashController.listTrash);

// POST /api/trash/:id/restore — restore a file or folder (?type=file|folder)
router.post('/:id/restore', trashController.restoreItem);

// DELETE /api/trash/:id — permanently delete (?type=file|folder)
router.delete('/:id', trashController.permanentDelete);

// DELETE /api/trash — empty entire trash
router.delete('/', trashController.emptyTrash);

module.exports = router;
