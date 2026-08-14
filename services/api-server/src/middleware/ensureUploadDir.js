const fs = require('fs').promises;
const path = require('path');

/**
 * Middleware: ensure the user's upload directory exists.
 * Must run BEFORE multer (which needs the directory to exist).
 */
const ensureUploadDir = async (req, res, next) => {
  try {
    const uploadDir = path.resolve(__dirname, '../../uploads', req.user.userId);
    await fs.mkdir(uploadDir, { recursive: true });
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { ensureUploadDir };
