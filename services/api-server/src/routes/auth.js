const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const validators = require('../middleware/validators');
const handleValidation = require('../middleware/handleValidation');

// POST /api/auth/register — create a new account
router.post(
  '/register',
  validators.register,
  handleValidation,
  authController.register
);

// POST /api/auth/login — authenticate and get tokens
router.post(
  '/login',
  validators.login,
  handleValidation,
  authController.login
);

// POST /api/auth/refresh — get new access token using refresh token
router.post(
  '/refresh',
  validators.refresh,
  handleValidation,
  authController.refresh
);

// POST /api/auth/logout — invalidate refresh token (requires auth)
router.post('/logout', authenticate, authController.logout);

// GET /api/auth/me — get current user profile (requires auth)
router.get('/me', authenticate, authController.getMe);

module.exports = router;
