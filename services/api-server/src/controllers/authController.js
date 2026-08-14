const User = require('../models/User');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require('../utils/jwt');
const AppError = require('../utils/AppError');
const crypto = require('crypto');

/**
 * POST /api/auth/register
 */
const register = async (req, res, next) => {
  try {
    const { email, username, password } = req.body;

    // Check if user already exists (email or username)
    const existingUser = await User.findOne({
      $or: [{ email }, { username }],
    });
    if (existingUser) {
      const field = existingUser.email === email ? 'email' : 'username';
      throw new AppError(`A user with this ${field} already exists.`, 409);
    }

    // Create user (password hashing happens in pre-save hook)
    const user = new User({
      email,
      username,
      passwordHash: password, // pre-save hook will bcrypt this
    });

    // Generate tokens
    const tokenPayload = { userId: user._id.toString(), role: user.role };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // Store hashed refresh token in DB
    user.refreshToken = hashToken(refreshToken);
    await user.save();

    // Set refresh token as httpOnly cookie
    setRefreshCookie(res, refreshToken);

    res.status(201).json({
      success: true,
      data: {
        user: user.toSafeObject(),
        accessToken,
        refreshToken, // also in body for mobile/non-browser clients
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/login
 */
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      throw new AppError('Invalid email or password.', 401);
    }

    // Check if account is active
    if (!user.isActive) {
      throw new AppError('Account has been deactivated. Contact support.', 403);
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password.', 401);
    }

    // Generate tokens
    const tokenPayload = { userId: user._id.toString(), role: user.role };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // Store hashed refresh token
    user.refreshToken = hashToken(refreshToken);
    await user.save();

    // Set refresh token as httpOnly cookie
    setRefreshCookie(res, refreshToken);

    res.json({
      success: true,
      data: {
        user: user.toSafeObject(),
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/refresh
 * Accepts refresh token from body OR httpOnly cookie.
 * Issues new access + refresh token pair (token rotation).
 */
const refresh = async (req, res, next) => {
  try {
    // Get refresh token from body or cookie
    const refreshToken = req.body?.refreshToken || req.cookies?.refreshToken;
    if (!refreshToken) {
      throw new AppError('Refresh token is required.', 401);
    }

    // Verify the refresh token
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      throw new AppError('Invalid or expired refresh token.', 401);
    }

    // Find user and verify stored token matches
    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      throw new AppError('User not found or inactive.', 401);
    }

    const hashedIncoming = hashToken(refreshToken);
    if (user.refreshToken !== hashedIncoming) {
      // Possible token theft — someone reused an old refresh token
      // Invalidate all tokens for this user as a safety measure
      user.refreshToken = null;
      await user.save();
      throw new AppError('Refresh token reuse detected. All sessions invalidated.', 401);
    }

    // Issue new tokens (rotation)
    const tokenPayload = { userId: user._id.toString(), role: user.role };
    const newAccessToken = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);

    user.refreshToken = hashToken(newRefreshToken);
    await user.save();

    setRefreshCookie(res, newRefreshToken);

    res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/logout
 */
const logout = async (req, res, next) => {
  try {
    // Clear refresh token from DB
    await User.findByIdAndUpdate(req.user.userId, { refreshToken: null });

    // Clear cookie
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    res.json({
      success: true,
      data: { message: 'Logged out successfully.' },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/auth/me
 */
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      throw new AppError('User not found.', 404);
    }

    res.json({
      success: true,
      data: { user: user.toSafeObject() },
    });
  } catch (error) {
    next(error);
  }
};

// ── Helpers ──────────────────────────────────────────────────

/**
 * Hash a refresh token with SHA-256 for secure DB storage.
 * We don't store raw refresh tokens — if the DB leaks, tokens are useless.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Set refresh token as an httpOnly cookie.
 */
function setRefreshCookie(res, token) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',                           // 'lax' allows cookies on page navigation/refresh
    maxAge: 7 * 24 * 60 * 60 * 1000,           // 7 days in ms
    path: '/',                                  // sent on all routes (needed for proxy setups)
  });
}

module.exports = { register, login, refresh, logout, getMe };
