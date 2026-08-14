const express = require('express');
const router = express.Router();

const folderController = require('../controllers/folderController');
const { authenticate } = require('../middleware/auth');

// All folder routes require authentication
router.use(authenticate);

// POST /api/folders — create a folder
router.post('/', folderController.createFolder);

// GET /api/folders/:id — get folder contents (use "root" for root level)
router.get('/:id', folderController.getFolderContents);

// GET /api/folders/:id/tree — get folder tree (recursive)
router.get('/:id/tree', folderController.getFolderTree);

// PATCH /api/folders/:id — rename or move
router.patch('/:id', folderController.updateFolder);

// DELETE /api/folders/:id — soft delete folder + contents
router.delete('/:id', folderController.deleteFolder);

module.exports = router;
