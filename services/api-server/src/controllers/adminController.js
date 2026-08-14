const User = require('../models/User');
const File = require('../models/File');
const AppError = require('../utils/AppError');

/**
 * GET /api/admin/stats
 * System-wide statistics.
 */
const getSystemStats = async (req, res, next) => {
  try {
    const [totalUsers, activeUsers, totalFiles, totalSize] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isActive: true }),
      File.countDocuments({ isDeleted: false, status: 'AVAILABLE' }),
      File.aggregate([
        { $match: { isDeleted: false, status: 'AVAILABLE' } },
        { $group: { _id: null, total: { $sum: '$size' } } },
      ]),
    ]);

    const trashedFiles = await File.countDocuments({ isDeleted: true });

    res.json({
      success: true,
      data: {
        users: { total: totalUsers, active: activeUsers },
        files: { total: totalFiles, trashed: trashedFiles },
        storage: { totalBytes: totalSize[0]?.total || 0 },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/users
 * List all users with storage usage.
 */
const listUsers = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      User.find()
        .select('email username role isActive storageUsed storageQuota createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments(),
    ]);

    res.json({
      success: true,
      data: {
        users,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/admin/users/:userId
 * Update user (toggle active, change role, adjust quota).
 */
const updateUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { isActive, role, storageQuota } = req.body;

    const updates = {};
    if (isActive !== undefined) updates.isActive = isActive;
    if (role) updates.role = role;
    if (storageQuota !== undefined) updates.storageQuota = storageQuota;

    if (Object.keys(updates).length === 0) {
      throw new AppError('No update fields provided.', 400);
    }

    const user = await User.findByIdAndUpdate(userId, updates, { new: true })
      .select('email username role isActive storageUsed storageQuota');

    if (!user) throw new AppError('User not found.', 404);

    res.json({ success: true, data: { user } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/nodes
 * Proxy to metadata service — get storage node health.
 */
const getNodes = async (req, res, next) => {
  try {
    const axios = require('axios');
    const metadataUrl = process.env.METADATA_URL || 'http://localhost:4000';
    const { data } = await axios.get(`${metadataUrl}/health`, { timeout: 5000 });
    res.json({ success: true, data });
  } catch (error) {
    res.json({
      success: true,
      data: { status: 'unreachable', error: 'Metadata service unavailable' },
    });
  }
};

/**
 * POST /api/admin/nodes/:nodeId/drain
 * Proxy to metadata service — drain a storage node.
 */
const drainNode = async (req, res, next) => {
  try {
    const axios = require('axios');
    const metadataUrl = process.env.METADATA_URL || 'http://localhost:4000';
    const { data } = await axios.post(
      `${metadataUrl}/api/nodes/${req.params.nodeId}/drain`,
      {},
      { timeout: 10000 }
    );
    res.json({ success: true, data: data.data });
  } catch (error) {
    next(new AppError(error.response?.data?.error || error.message, 502));
  }
};

module.exports = { getSystemStats, listUsers, updateUser, getNodes, drainNode };
