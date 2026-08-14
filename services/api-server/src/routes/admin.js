const express = require('express');
const router = express.Router();

const adminController = require('../controllers/adminController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// All admin routes require authentication + admin role
router.use(authenticate, requireAdmin);

router.get('/stats', adminController.getSystemStats);
router.get('/users', adminController.listUsers);
router.patch('/users/:userId', adminController.updateUser);
router.get('/nodes', adminController.getNodes);
router.post('/nodes/:nodeId/drain', adminController.drainNode);

module.exports = router;
