const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const VersionHistory = require('../models/VersionHistory');
const File = require('../models/File');
const User = require('../models/User');
const AppError = require('../utils/AppError');

/**
 * GET /api/files/:id/versions
 * List all versions of a file.
 */
const listVersions = async (req, res, next) => {
  try {
    const file = await File.findOne({
      _id: req.params.id,
      userId: req.user.userId,
      isDeleted: false,
    });
    if (!file) throw new AppError('File not found.', 404);

    const versions = await VersionHistory.find({ fileId: file._id })
      .sort({ versionNumber: -1 })
      .select('-storagePath -storageKey -__v');

    res.json({
      success: true,
      data: { fileId: file._id, currentVersion: file.currentVersion, versions },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/files/:id/versions/:versionNum/download
 * Download a specific version.
 */
const downloadVersion = async (req, res, next) => {
  try {
    const file = await File.findOne({
      _id: req.params.id,
      userId: req.user.userId,
      isDeleted: false,
    });
    if (!file) throw new AppError('File not found.', 404);

    const version = await VersionHistory.findOne({
      fileId: file._id,
      versionNumber: parseInt(req.params.versionNum, 10),
    });
    if (!version) throw new AppError('Version not found.', 404);

    try {
      await fs.access(version.storagePath);
    } catch {
      throw new AppError('Version data not found on storage.', 500);
    }

    res.set({
      'Content-Type': version.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalName)}"`,
      'Content-Length': version.size,
    });

    require('fs').createReadStream(version.storagePath).pipe(res);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/files/:id/versions/:versionNum/restore
 * Restore an old version as the current version.
 * This creates a NEW version (copy of the old one) and makes it current.
 */
const restoreVersion = async (req, res, next) => {
  try {
    const { userId } = req.user;

    const file = await File.findOne({ _id: req.params.id, userId, isDeleted: false });
    if (!file) throw new AppError('File not found.', 404);

    const oldVersion = await VersionHistory.findOne({
      fileId: file._id,
      versionNumber: parseInt(req.params.versionNum, 10),
    });
    if (!oldVersion) throw new AppError('Version not found.', 404);

    // Copy the old version's file to a new storage location
    const newStorageKey = uuidv4();
    const ext = path.extname(oldVersion.storagePath);
    const uploadDir = path.resolve(__dirname, '../../uploads', userId);
    const newStoragePath = path.join(uploadDir, `${newStorageKey}${ext}`);

    await fs.mkdir(uploadDir, { recursive: true });
    await fs.copyFile(oldVersion.storagePath, newStoragePath);

    const newVersionNum = file.currentVersion + 1;

    // Unmark old current version
    await VersionHistory.updateMany(
      { fileId: file._id, isCurrentVersion: true },
      { isCurrentVersion: false }
    );

    // Create new version record
    await VersionHistory.create({
      fileId: file._id,
      versionNumber: newVersionNum,
      size: oldVersion.size,
      uploadedBy: userId,
      changeNote: `Restored from version ${oldVersion.versionNumber}`,
      storagePath: newStoragePath,
      storageKey: newStorageKey,
      mimeType: oldVersion.mimeType,
      isCurrentVersion: true,
    });

    // Update file to point to restored version's data
    file.currentVersion = newVersionNum;
    file.size = oldVersion.size;
    file.mimeType = oldVersion.mimeType;
    file.storagePath = newStoragePath;
    file.storageKey = newStorageKey;
    await file.save();

    res.json({
      success: true,
      data: {
        message: `Restored to version ${oldVersion.versionNumber} as new version ${newVersionNum}.`,
        file: file.toSafeObject(),
        newVersion: newVersionNum,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { listVersions, downloadVersion, restoreVersion };
