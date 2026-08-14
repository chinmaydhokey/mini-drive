const path = require('path');
const fs = require('fs').promises;
const File = require('../models/File');
const User = require('../models/User');
const VersionHistory = require('../models/VersionHistory');
const AppError = require('../utils/AppError');
const cache = require('../services/cacheService');
const chunkService = require('../services/chunkService');

/*
 * POST /api/files/upload
 * Upload a single file. Multer middleware handles the actual file write.
 */
const uploadFile = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const file = req.file;

    // Check storage quota
    const user = await User.findById(userId);
    if (user.storageUsed + file.size > user.storageQuota) {
      // Remove the uploaded file since we can't accept it
      await fs.unlink(file.path).catch(() => {});
      throw new AppError(
        `Storage quota exceeded. Used: ${File.formatSize(user.storageUsed)}, ` +
        `Quota: ${File.formatSize(user.storageQuota)}, ` +
        `File: ${File.formatSize(file.size)}`,
        400
      );
    }

    // Create file record
    const fileDoc = await File.create({
      userId,
      folderId: req.body.folderId || null,
      filename: file.originalname,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      storagePath: file.path,
      storageKey: req.storageKey,
      status: 'AVAILABLE',
    });

    // Create initial version record (version 1)
    await VersionHistory.create({
      fileId: fileDoc._id,
      versionNumber: 1,
      size: file.size,
      uploadedBy: userId,
      changeNote: 'Initial upload',
      storagePath: file.path,
      storageKey: req.storageKey,
      mimeType: file.mimetype,
      isCurrentVersion: true,
    });

    // Split file into 4MB chunks and upload to Metadata Service (replicates to storage nodes & S3)
    try {
      const { totalChunks } = await chunkService.processAndUploadChunks(fileDoc._id, file.path);
      fileDoc.totalChunks = totalChunks;
      await fileDoc.save();
    } catch (chunkErr) {
      console.warn(`⚠️ Chunking error for file ${fileDoc._id} (falling back to local file): ${chunkErr.message}`);
    }
    
    // Update user's storage usage
    user.storageUsed += file.size;
    await user.save();

    // Invalidate caches
    await cache.invalidateFile(userId, fileDoc._id.toString(), fileDoc.folderId?.toString());

    res.status(201).json({
      success: true,
      data: {
        file: fileDoc.toSafeObject(),
        storageUsed: user.storageUsed,
        storageQuota: user.storageQuota,
      },
    });
  } catch (error) {
    // Clean up uploaded file on any error
    if (req.file) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    next(error);
  }
};

/**
 * GET /api/files
 * List all files for the authenticated user (not deleted).
 */
const listFiles = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { folderId, sort = '-createdAt', page = 1, limit = 20 } = req.query;

    const filter = {
      userId,
      isDeleted: false,
      status: 'AVAILABLE',
    };

    // Filter by folder (null = root)
    if (folderId) {
      filter.folderId = folderId;
    } else if (folderId === undefined) {
      // If no folderId specified, show all files (not filtered by folder)
      // To get root-level files only, pass folderId=null explicitly
    }
    
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [files, total] = await Promise.all([
      File.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .select('-storagePath -storageKey -__v'),
      File.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        files,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/files/:id
 * Get single file metadata.
 */
const getFile = async (req, res, next) => {
  try {
    const cacheKey = cache.keys.fileMeta(req.params.id);
    const { data: cached, fromCache } = await cache.cacheThrough(cacheKey, cache.TTL.FILE_META, async () => {
      let file = await File.findOne({
        _id: req.params.id,
        userId: req.user.userId,
        isDeleted: false,
      });

      // If not owner, check if shared
      if (!file) {
        const ShareLink = require('../models/ShareLink');
        let shareAccess = await ShareLink.findOne({
          fileId: req.params.id,
          shareType: 'PRIVATE',
          isRevoked: false,
          'sharedWith.userId': req.user.userId,
        });

        if (!shareAccess) {
          const candidate = await File.findOne({ _id: req.params.id, isDeleted: false });
          if (candidate && candidate.folderId) {
            shareAccess = await ShareLink.findOne({
              folderId: candidate.folderId,
              shareType: 'PRIVATE',
              isRevoked: false,
              'sharedWith.userId': req.user.userId,
            });
          }
        }

        if (shareAccess && shareAccess.isAccessible().valid) {
          file = await File.findOne({ _id: req.params.id, isDeleted: false });
        }
      }

      if (!file) return null;
      return file.toSafeObject();
    });

    if (!cached) {
      throw new AppError('File not found.', 404);
    }

    if (fromCache) res.set('X-Cache', 'HIT');

    res.json({
      success: true,
      data: { file: cached },
    });
  } catch (error) {
    next(error);
  }
};

// ── Helper: verify shared file access for a user ───────────────
async function checkSharedFileAccess(fileId, userId, requiredPermissions = ['VIEW', 'DOWNLOAD']) {
  const ShareLink = require('../models/ShareLink');
  
  // 1. Direct file or batch share
  let share = await ShareLink.findOne({
    $or: [{ fileId }, { fileIds: fileId }],
    shareType: 'PRIVATE',
    isRevoked: false,
    'sharedWith.userId': userId,
  });

  // 2. Folder share (direct or recursive)
  if (!share) {
    const candidateFile = await File.findOne({ _id: fileId, isDeleted: false, status: 'AVAILABLE' });
    if (candidateFile && candidateFile.folderId) {
      const fileFolder = await Folder.findById(candidateFile.folderId);
      if (fileFolder) {
        const sharedFolders = await ShareLink.find({
          shareType: 'PRIVATE',
          isRevoked: false,
          'sharedWith.userId': userId,
          $or: [
            { folderId: { $ne: null } },
            { folderIds: { $exists: true, $not: { $size: 0 } } },
          ],
        }).populate('folderId').populate('folderIds');

        for (const sf of sharedFolders) {
          const allSharedFolderObjects = [
            ...(sf.folderId ? [sf.folderId] : []),
            ...(sf.folderIds || []),
          ];
          for (const sharedF of allSharedFolderObjects) {
            if (
              sharedF &&
              (sharedF._id.toString() === fileFolder._id.toString() ||
               (sharedF.path && fileFolder.path && fileFolder.path.startsWith(sharedF.path)))
            ) {
              share = sf;
              break;
            }
          }
          if (share) break;
        }
      }
    }
  }

  if (share && share.isAccessible().valid) {
    const userEntry = share.sharedWith.find(
      (sw) => sw.userId.toString() === userId.toString()
    );
    if (userEntry && requiredPermissions.includes(userEntry.permission)) {
      return true;
    }
  }
  return false;
}

/**
 * GET /api/files/:id/download
 * Download file content.
 */
const downloadFile = async (req, res, next) => {
  try {
    // First try as owner
    let file = await File.findOne({
      _id: req.params.id,
      userId: req.user.userId,
      isDeleted: false,
      status: 'AVAILABLE',
    });

    // If not owner, check if user has DOWNLOAD permission via private share
    if (!file) {
      const hasAccess = await checkSharedFileAccess(req.params.id, req.user.userId, ['DOWNLOAD']);
      if (hasAccess) {
        file = await File.findOne({
          _id: req.params.id,
          isDeleted: false,
          status: 'AVAILABLE',
        });
      }
    }

    if (!file) {
      throw new AppError('File not found or access denied.', 404);
    }

    // Verify file exists on disk (for non-chunked files)
    if (file.totalChunks === 0) {
      try {
        await fs.access(file.storagePath);
      } catch {
        throw new AppError('File data not found on storage. It may have been corrupted.', 500);
      }
    }

    // Increment download counter
    file.downloadCount = (file.downloadCount || 0) + 1;
    await file.save();

    // Set headers
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalName || file.filename)}"`,
      'Content-Length': file.size,
    });

    // If file is chunked, stream chunks in sequence (from storage nodes or S3 fallback)
    if (file.totalChunks > 0) {
      for (let i = 0; i < file.totalChunks; i++) {
        const chunkStream = await chunkService.getChunkStream(file._id, i);
        await new Promise((resolve, reject) => {
          chunkStream.pipe(res, { end: i === file.totalChunks - 1 });
          chunkStream.on('end', resolve);
          chunkStream.on('error', reject);
        });
      }
      return;
    }

    // Fallback for non-chunked legacy files: stream from local disk
    const fileStream = require('fs').createReadStream(file.storagePath);
    fileStream.pipe(res);

    fileStream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) {
        next(new AppError('Error reading file.', 500));
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/files/:id
 * Rename a file or move it to a different folder.
 */
const updateFile = async (req, res, next) => {
  try {
    const { filename, folderId } = req.body;

    const file = await File.findOne({
      _id: req.params.id,
      userId: req.user.userId,
      isDeleted: false,
    });

    if (!file) {
      throw new AppError('File not found.', 404);
    }

    if (filename !== undefined) {
      if (!filename || filename.trim().length === 0) {
        throw new AppError('Filename cannot be empty.', 400);
      }
      file.filename = filename.trim();
      file.originalName = filename.trim();
    }

    if (folderId !== undefined) {
      file.folderId = folderId || null; // null = move to root
    }

    await file.save();

    // Invalidate caches
    await cache.invalidateFile(req.user.userId, file._id.toString(), file.folderId?.toString());

    res.json({
      success: true,
      data: { file: file.toSafeObject() },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/files/:id
 * Soft delete — moves to recycle bin.
 */
const deleteFile = async (req, res, next) => {
  try {
    const file = await File.findOne({
      _id: req.params.id,
      userId: req.user.userId,
      isDeleted: false,
    });

    if (!file) {
      throw new AppError('File not found.', 404);
    }

    file.isDeleted = true;
    file.deletedAt = new Date();
    file.status = 'DELETED';
    await file.save();

    // Invalidate caches
    await cache.invalidateFile(req.user.userId, file._id.toString(), file.folderId?.toString());

    // Note: Storage quota is NOT freed on soft delete.
    // Quota is only freed on permanent delete (Phase 4: trash empty).

    res.json({
      success: true,
      data: {
        message: 'File moved to trash.',
        fileId: file._id,
        restoreDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/files/search
 * Search files by name (regex-based for partial matches).
 */
const searchFiles = async (req, res, next) => {
  try {
    const { q, type, page = 1, limit = 20 } = req.query;

    if (!q || q.trim().length === 0) {
      throw new AppError('Search query "q" is required.', 400);
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    // Escape special regex characters in user input
    const escapedQuery = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const filter = {
      userId: req.user.userId,
      isDeleted: false,
      status: 'AVAILABLE',
      filename: { $regex: escapedQuery, $options: 'i' },
    };

    // Optional: filter by MIME type prefix (e.g., type=image, type=video)
    if (type) {
      filter.mimeType = { $regex: `^${type}/`, $options: 'i' };
    }

    const [files, total] = await Promise.all([
      File.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .select('-storagePath -storageKey -__v'),
      File.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        files,
        query: q,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/files/storage
 * Get storage usage dashboard data.
 */
const getStorageStats = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId).select('storageUsed storageQuota');
    if (!user) throw new AppError('User not found.', 404);

    // Get breakdown by file type
    const typeBreakdown = await File.aggregate([
      { $match: { userId: user._id, isDeleted: false, status: 'AVAILABLE' } },
      {
        $group: {
          _id: {
            $switch: {
              branches: [
                { case: { $regexMatch: { input: '$mimeType', regex: /^image\// } }, then: 'Images' },
                { case: { $regexMatch: { input: '$mimeType', regex: /^video\// } }, then: 'Videos' },
                { case: { $regexMatch: { input: '$mimeType', regex: /^audio\// } }, then: 'Audio' },
                { case: { $regexMatch: { input: '$mimeType', regex: /^application\/pdf/ } }, then: 'PDFs' },
                { case: { $regexMatch: { input: '$mimeType', regex: /^text\// } }, then: 'Text' },
              ],
              default: 'Other',
            },
          },
          totalSize: { $sum: '$size' },
          count: { $sum: 1 },
        },
      },
      { $sort: { totalSize: -1 } },
    ]);

    // Count files in trash
    const trashStats = await File.aggregate([
      { $match: { userId: user._id, isDeleted: true } },
      { $group: { _id: null, totalSize: { $sum: '$size' }, count: { $sum: 1 } } },
    ]);

    res.json({
      success: true,
      data: {
        storageUsed: user.storageUsed,
        storageQuota: user.storageQuota,
        usagePercent: (user.storageQuota > 0 ? ((user.storageUsed / user.storageQuota) * 100).toFixed(1) : '0.0'),
        storageUsedFormatted: File.formatSize(user.storageUsed),
        storageQuotaFormatted: File.formatSize(user.storageQuota),
        breakdown: typeBreakdown.map((t) => ({
          type: t._id,
          size: t.totalSize,
          sizeFormatted: File.formatSize(t.totalSize),
          count: t.count,
        })),
        trash: trashStats[0] || { totalSize: 0, count: 0 },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/files/:id/versions
 * Upload a new version of an existing file.
 * Uses multer — same middleware chain as regular upload.
 */
const uploadNewVersion = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const uploadedFile = req.file;

    const file = await File.findOne({ _id: req.params.id, userId, isDeleted: false });
    if (!file) {
      await fs.unlink(uploadedFile.path).catch(() => {});
      throw new AppError('File not found.', 404);
    }

    // Check quota for the size difference
    const user = await User.findById(userId);
    if (user.storageUsed + uploadedFile.size > user.storageQuota) {
      await fs.unlink(uploadedFile.path).catch(() => {});
      throw new AppError('Storage quota exceeded.', 400);
    }

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
      size: uploadedFile.size,
      uploadedBy: userId,
      changeNote: req.body.changeNote || '',
      storagePath: uploadedFile.path,
      storageKey: req.storageKey,
      mimeType: uploadedFile.mimetype,
      isCurrentVersion: true,
    });

    // Update file document to point to new version
    file.currentVersion = newVersionNum;
    file.size = uploadedFile.size;
    file.mimeType = uploadedFile.mimetype;
    file.storagePath = uploadedFile.path;
    file.storageKey = req.storageKey;
    await file.save();

    // Update storage
    user.storageUsed += uploadedFile.size;
    await user.save();

    // Invalidate caches
    await cache.invalidateFile(userId, file._id.toString(), file.folderId?.toString());

    res.status(201).json({
      success: true,
      data: {
        file: file.toSafeObject(),
        version: newVersionNum,
        storageUsed: user.storageUsed,
      },
    });
  } catch (error) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    next(error);
  }
};

/**
 * GET /api/files/:id/view
 * View/stream file content inline for in-browser preview (owner or user with VIEW/DOWNLOAD permission in private share).
 */
const viewFile = async (req, res, next) => {
  try {
    // 1. Try finding as owner
    let file = await File.findOne({
      _id: req.params.id,
      userId: req.user.userId,
      isDeleted: false,
      status: 'AVAILABLE',
    });

    // 2. If not owner, check if user has VIEW or DOWNLOAD permission via private share
    if (!file) {
      const hasAccess = await checkSharedFileAccess(req.params.id, req.user.userId, ['VIEW', 'DOWNLOAD']);
      if (hasAccess) {
        file = await File.findOne({
          _id: req.params.id,
          isDeleted: false,
          status: 'AVAILABLE',
        });
      }
    }

    if (!file) {
      throw new AppError('File not found or access denied.', 404);
    }

    // Verify file exists on disk (for non-chunked files)
    if (file.totalChunks === 0) {
      try {
        await fs.access(file.storagePath);
      } catch {
        throw new AppError('File data not found on storage.', 500);
      }
    }

    // Set headers for inline preview
    res.set({
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.originalName || file.filename)}"`,
      'Content-Length': file.size,
      'X-Content-Type-Options': 'nosniff',
    });

    // If file is chunked, stream chunks in sequence
    if (file.totalChunks > 0) {
      for (let i = 0; i < file.totalChunks; i++) {
        const chunkStream = await chunkService.getChunkStream(file._id, i);
        await new Promise((resolve, reject) => {
          chunkStream.pipe(res, { end: i === file.totalChunks - 1 });
          chunkStream.on('end', resolve);
          chunkStream.on('error', reject);
        });
      }
      return;
    }

    // Fallback for non-chunked files: stream from local disk
    const fileStream = require('fs').createReadStream(file.storagePath);
    fileStream.pipe(res);

    fileStream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) {
        next(new AppError('Error streaming file.', 500));
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  uploadFile,
  uploadNewVersion,
  listFiles,
  getFile,
  downloadFile,
  viewFile,
  updateFile,
  deleteFile,
  searchFiles,
  getStorageStats,
};
