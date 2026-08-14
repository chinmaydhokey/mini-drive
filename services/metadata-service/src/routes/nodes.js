const express = require('express');
const router = express.Router();
const nodeController = require('../controllers/nodeController');

router.post('/register', nodeController.registerNode);
router.get('/', nodeController.listNodes);
router.post('/:nodeId/heartbeat', nodeController.heartbeat);
router.post('/:nodeId/drain', nodeController.drainNode);

module.exports = router;
