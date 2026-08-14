const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Generate an access token (short-lived, used in Authorization header)
 */
function generateAccessToken(payload) {
  return jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiry,
  });
}

/**
 * Generate a refresh token (long-lived, stored in httpOnly cookie + hashed in DB)
 */
function generateRefreshToken(payload) {
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiry,
  });
}

/**
 * Verify an access token
 */
function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.accessSecret);
}

/**
 * Verify a refresh token
 */
function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret);
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
