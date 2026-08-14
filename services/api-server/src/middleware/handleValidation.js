const { validationResult } = require('express-validator');
const AppError = require('../utils/AppError');

/**
 * Middleware that checks for express-validator errors.
 * Place AFTER validation rule arrays in the route chain.
 *
 * Usage: router.post('/register', validate.register, handleValidation, controller.register)
 */
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map((e) => e.msg);
    throw new AppError(messages.join('. '), 400);
  }
  next();
};

module.exports = handleValidation;
