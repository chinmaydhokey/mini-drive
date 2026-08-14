const cache = require('../services/cacheService');

/**
 * Rate limiting middleware using Redis sliding window.
 * Falls back to allowing all requests if Redis is unavailable.
 *
 * @param {number} maxRequests - Max requests per window (default 100)
 * @param {number} windowSec - Window in seconds (default 60)
 */
function rateLimit(maxRequests = 100, windowSec = 60) {
  return async (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const result = await cache.checkRateLimit(ip, maxRequests, windowSec);

    // Set rate limit headers (standard)
    res.set({
      'X-RateLimit-Limit': maxRequests,
      'X-RateLimit-Remaining': result.remaining,
      'X-RateLimit-Reset': Math.ceil(Date.now() / 1000) + result.resetIn,
    });

    if (!result.allowed) {
      return res.status(429).json({
        success: false,
        error: {
          message: 'Too many requests. Please try again later.',
          retryAfter: result.resetIn,
        },
      });
    }

    next();
  };
}

/**
 * Stricter rate limit for auth endpoints (prevent brute force).
 */
const authRateLimit = rateLimit(20, 60); // 20 per minute

/**
 * Upload rate limit (prevent abuse).
 */
const uploadRateLimit = rateLimit(30, 60); // 30 per minute

/**
 * General API rate limit.
 */
const apiRateLimit = rateLimit(100, 60); // 100 per minute

module.exports = { rateLimit, authRateLimit, uploadRateLimit, apiRateLimit };
