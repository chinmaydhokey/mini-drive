const fs = require('fs').promises;
const File = require('../models/File');
const Folder = require('../models/Folder');
const User = require('../models/User');
const VersionHistory = require('../models/VersionHistory');
const ShareLink = require('../models/ShareLink');
const AppError = require('../utils/AppError');
const chunkService = require('../services/chunkService');

// S3 cleanup helper for single-file mode
async function deleteFileFromS3(storageKey) {
  if (!storageKey) return;
  try {
    let S3Client, DeleteObjectCommand;
    try {
      ({ S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
    } catch {
      return; // S3 SDK not installed
    }
    const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET;
    if (!S3_BUCKET) return; // S3 not configured

    const config = { region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1' };
    if (process.env.S3_ENDPOINT) {
      config.endpoint = process.env.S3_ENDPOINT;
      config.forcePathStyle = true;
    }
    const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
    const S3_SECRET_KEY = process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    if (S3_ACCESS_KEY && S3_SECRET_KEY) {
      config.credentials = { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY };
    }

    const client = new S3Client(config);
    const prefix = process.env.S3_PREFIX || 'files/';
    await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `${prefix}${storageKey}` }));
    console.log(`  ☁️ [S3] Deleted single-file object: s3://${S3_BUCKET}/${prefix}${storageKey}`);
  } catch (err) {
    console.warn(`  ⚠️ [S3] Failed to delete single-file object ${storageKey}: ${err.message}`);
  }
}

/**
 * GET /api/trash
 * List all deleted items (files + folders) for current user.
 */
const listTrash = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [files, folders, totalFiles, totalFolders] = await Promise.all([
      File.find({ userId, isDeleted: true })
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .select('-storagePath -storageKey -__v'),
      Folder.find({ userId, isDeleted: true, parentFolderId: null }) // only top-level deleted folders
        .sort({ deletedAt: -1 })
        .select('-__v'),
      File.countDocuments({ userId, isDeleted: true }),
      Folder.countDocuments({ userId, isDeleted: true }),
    ]);

    res.json({
      success: true,
      data: {
        files,
        folders,
        totalFiles,
        totalFolders,
        pagination: { page: pageNum, limit: limitNum, total: totalFiles, pages: Math.ceil(totalFiles / limitNum) },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/trash/:id/restore
 * Restore a file or folder from trash.
 */
const restoreItem = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { id } = req.params;
    const { type = 'file' } = req.query; // ?type=file or ?type=folder

    if (type === 'folder') {
      const folder = await Folder.findOne({ _id: id, userId, isDeleted: true });
      if (!folder) throw new AppError('Folder not found in trash.', 404);

      // Check if parent still exists
      if (folder.parentFolderId) {
        const parent = await Folder.findById(folder.parentFolderId);
        if (!parent || parent.isDeleted) {
          folder.parentFolderId = null;
          folder.path = `/${folder._id}/`;
          folder.depth = 0;
        }
      }

      folder.isDeleted = false;
      folder.deletedAt = null;
      await folder.save();

      // Restore descendant folders
      await Folder.updateMany(
        { userId, path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }, isDeleted: true },
        { $set: { isDeleted: false, deletedAt: null } }
      );

      // Restore files in this folder and descendants
      const restoredFolderIds = [folder._id];
      const descendants = await Folder.find({
        userId,
        path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
      }).select('_id');
      restoredFolderIds.push(...descendants.map((f) => f._id));

      await File.updateMany(
        { userId, folderId: { $in: restoredFolderIds }, isDeleted: true },
        { $set: { isDeleted: false, deletedAt: null, status: 'AVAILABLE' } }
      );

      return res.json({
        success: true,
        data: { message: 'Folder and contents restored.', folder: folder.toSafeObject() },
      });
    }

    // Default: restore file
    const file = await File.findOne({ _id: id, userId, isDeleted: true });
    if (!file) throw new AppError('File not found in trash.', 404);

    // Check if original folder still exists
    if (file.folderId) {
      const folder = await Folder.findById(file.folderId);
      if (!folder || folder.isDeleted) {
        file.folderId = null; // restore to root if parent gone
      }
    }

    file.isDeleted = false;
    file.deletedAt = null;
    file.status = 'AVAILABLE';
    await file.save();

    res.json({
      success: true,
      data: { message: 'File restored.', file: file.toSafeObject() },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/trash/:id
 * Permanently delete a file (remove from disk + DB).
 */
const permanentDelete = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { id } = req.params;
    const { type = 'file' } = req.query;

    if (type === 'folder') {
      const folder = await Folder.findOne({ _id: id, userId, isDeleted: true });
      if (!folder) throw new AppError('Folder not found in trash.', 404);

      // Find all descendant folders
      const allFolderIds = [folder._id];
      const descendants = await Folder.find({
        userId,
        path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
      }).select('_id');
      allFolderIds.push(...descendants.map((f) => f._id));

      // Permanently delete files in these folders
      const files = await File.find({ userId, folderId: { $in: allFolderIds } });
      let freedBytes = 0;
      for (const file of files) {
        freedBytes += file.size;
        await deleteFileData(file);
      }

      // Delete folders
      await Folder.deleteMany({ _id: { $in: allFolderIds } });

      // Update storage quota
      if (freedBytes > 0) {
        await User.findByIdAndUpdate(userId, { $inc: { storageUsed: -freedBytes } });
      }

      return res.json({
        success: true,
        data: { message: 'Folder permanently deleted.', freedBytes },
      });
    }

    // Default: permanently delete file
    const file = await File.findOne({ _id: id, userId, isDeleted: true });
    if (!file) throw new AppError('File not found in trash.', 404);

    const freedBytes = file.size;
    await deleteFileData(file);

    // Update storage
    await User.findByIdAndUpdate(userId, { $inc: { storageUsed: -freedBytes } });

    res.json({
      success: true,
      data: { message: 'File permanently deleted.', freedBytes, freedFormatted: File.formatSize(freedBytes) },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/trash
 * Empty entire trash.
 */
const emptyTrash = async (req, res, next) => {
  try {
    const { userId } = req.user;

    // Find all trashed files
    const files = await File.find({ userId, isDeleted: true });
    let freedBytes = 0;

    for (const file of files) {
      freedBytes += file.size;
      await deleteFileData(file);
    }

    // Delete all trashed folders
    await Folder.deleteMany({ userId, isDeleted: true });

    // Update storage
    if (freedBytes > 0) {
      await User.findByIdAndUpdate(userId, { $inc: { storageUsed: -freedBytes } });
    }

    res.json({
      success: true,
      data: {
        message: 'Trash emptied.',
        deletedFiles: files.length,
        freedBytes,
        freedFormatted: File.formatSize(freedBytes),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── Helper ───────────────────────────────────────────────────

/**
 * Delete a file's data from disk, its versions, share links, and the DB record.
 * Deletion order: physical data FIRST (chunks → local files), DB records LAST.
 */
async function deleteFileData(file) {
  const fileId = file._id.toString();
  console.log(`[PERMANENT DELETE] Starting cleanup for file ${fileId} (${file.filename})`);

  // Step 1: Delete distributed chunks (storage nodes + S3 cold tier + chunk metadata)
  if (file.totalChunks > 0) {
    try {
      await chunkService.deleteChunks(fileId);
      console.log(`  ✅ [Chunks] Deleted ${file.totalChunks} chunk(s) for file ${fileId}`);
    } catch (err) {
      console.error(`  ❌ [Chunks] Failed to delete chunks for file ${fileId}: ${err.message}`);
    }
  }

  // Step 1b: For non-chunked files, delete S3 backup if present
  if (file.totalChunks === 0 && file.storageKey) {
    await deleteFileFromS3(file.storageKey);
  }

  // Step 2: Delete local assembled file from disk
  if (file.storagePath) {
    try {
      await fs.unlink(file.storagePath);
      console.log(`  ✅ [Local File] Deleted ${file.storagePath}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(`  ⚠️ [Local File] Already gone: ${file.storagePath}`);
      } else {
        console.error(`  ❌ [Local File] Failed to delete ${file.storagePath}: ${err.message}`);
      }
    }
  }

  // Step 3: Delete all version files from disk
  const versions = await VersionHistory.find({ fileId: file._id });
  for (const v of versions) {
    if (v.storagePath) {
      try {
        await fs.unlink(v.storagePath);
        console.log(`  ✅ [Version ${v.versionNumber}] Deleted ${v.storagePath}`);
      } catch (err) {
        if (err.code === 'ENOENT') {
          console.log(`  ⚠️ [Version ${v.versionNumber}] Already gone: ${v.storagePath}`);
        } else {
          console.error(`  ❌ [Version ${v.versionNumber}] Failed to delete ${v.storagePath}: ${err.message}`);
        }
      }
    }
  }

  // Step 4: Delete DB records (LAST — after all physical cleanup)
  const [versionResult, shareResult] = await Promise.all([
    VersionHistory.deleteMany({ fileId: file._id }),
    ShareLink.deleteMany({ fileId: file._id }),
  ]);
  await File.deleteOne({ _id: file._id });

  console.log(`  ✅ [DB] Cleaned up: ${versionResult.deletedCount} versions, ${shareResult.deletedCount} shares, 1 file record`);
  console.log(`[PERMANENT DELETE] Completed cleanup for file ${fileId}`);
}

module.exports = { listTrash, restoreItem, permanentDelete, emptyTrash };
