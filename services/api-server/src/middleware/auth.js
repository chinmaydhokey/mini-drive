const { verifyAccessToken } = require('../utils/jwt');
const AppError = require('../utils/AppError');
const User = require('../models/User');

/**
 * Middleware: Require a valid JWT access token.
 * Attaches req.user = { userId, role } on success.
 */
const authenticate = async (req, res, next) => {
  try {
    // Extract token from Authorization header or query parameter
    let token;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      throw new AppError('Access denied. No token provided.', 401);
    }

    const decoded = verifyAccessToken(token);

    // Optional: verify user still exists and is active
    const user = await User.findById(decoded.userId).select('_id role isActive');
    if (!user) {
      throw new AppError('User no longer exists.', 401);
    }
    if (!user.isActive) {
      throw new AppError('Account has been deactivated.', 403);
    }

    req.user = {
      userId: decoded.userId,
      role: decoded.role,
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return next(new AppError('Invalid token.', 401));
    }
    if (error.name === 'TokenExpiredError') {
      return next(new AppError('Token expired.', 401));
    }
    next(error);
  }
};

/**
 * Middleware: Require admin role.
 * Must be used AFTER authenticate middleware.
 */
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return next(new AppError('Admin access required.', 403));
  }
  next();
};

module.exports = { authenticate, requireAdmin };
