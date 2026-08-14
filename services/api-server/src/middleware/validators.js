const { body } = require('express-validator');

/**
 * Validation rules for auth endpoints.
 * Used as middleware arrays in routes: router.post('/register', validate.register, controller.register)
 */
const register = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
  body('username')
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Username must be between 3 and 30 characters')
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Username can only contain letters, numbers, underscores, and hyphens'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number'),
];

const login = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

const refresh = [
  body('refreshToken')
    .optional() // can also come from cookie
    .isString()
    .withMessage('Refresh token must be a string'),
];

module.exports = { register, login, refresh };
