const express = require('express');
const multer = require('multer');
const router = express.Router();
const chunkController = require('../controllers/chunkController');

// Use memory storage — chunks are forwarded to storage nodes, not saved locally
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/upload', upload.single('chunk'), chunkController.uploadChunk);
router.post('/check-dedup', chunkController.checkDedup);
router.get('/:fileId', chunkController.getChunkMap);
router.get('/:fileId/:chunkIndex/download', chunkController.downloadChunk);
router.delete('/:fileId', chunkController.deleteChunks);

module.exports = router;
