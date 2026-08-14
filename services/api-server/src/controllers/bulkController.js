const fs = require('fs').promises;
const fsSync = require('fs');
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

// ── Helper: deleteFileData (same logic as trashController) ───
async function deleteFileData(file) {
  const fileId = file._id.toString();
  console.log(`[BULK DELETE] Cleaning up file ${fileId} (${file.filename})`);

  // Step 1: Delete distributed chunks
  if (file.totalChunks > 0) {
    try {
      await chunkService.deleteChunks(fileId);
    } catch (err) {
      console.error(`  ❌ [Chunks] ${fileId}: ${err.message}`);
    }
  }

  // Step 1b: For non-chunked files, delete S3 backup if present
  if (file.totalChunks === 0 && file.storageKey) {
    await deleteFileFromS3(file.storageKey);
  }

  // Step 2: Delete local assembled file
  if (file.storagePath) {
    try {
      await fs.unlink(file.storagePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`  ❌ [Local] ${file.storagePath}: ${err.message}`);
      }
    }
  }

  // Step 3: Delete version files
  const versions = await VersionHistory.find({ fileId: file._id });
  for (const v of versions) {
    if (v.storagePath) {
      try { await fs.unlink(v.storagePath); } catch {}
    }
  }

  // Step 4: Delete DB records (LAST)
  await Promise.all([
    VersionHistory.deleteMany({ fileId: file._id }),
    ShareLink.deleteMany({ fileId: file._id }),
  ]);
  await File.deleteOne({ _id: file._id });
}

/**
 * POST /api/bulk/delete
 * Soft-delete multiple files and/or folders.
 */
const bulkSoftDelete = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { ids } = req.body; // [{ id, type: 'file'|'folder' }]

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids array is required and must not be empty.', 400);
    }
    if (ids.length > 100) {
      throw new AppError('Maximum 100 items per bulk operation.', 400);
    }

    const succeeded = [];
    const failed = [];

    for (const { id, type } of ids) {
      try {
        if (type === 'folder') {
          const folder = await Folder.findOneAndUpdate(
            { _id: id, userId, isDeleted: false },
            { $set: { isDeleted: true, deletedAt: new Date() } },
            { new: true }
          );
          if (!folder) {
            failed.push({ id, type, error: 'Folder not found' });
            continue;
          }

          // Also soft-delete all descendant folders
          await Folder.updateMany(
            { userId, path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }, isDeleted: false },
            { $set: { isDeleted: true, deletedAt: new Date() } }
          );

          // Soft-delete all files in folder tree
          const allFolderIds = [folder._id];
          const descendants = await Folder.find({
            userId, path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }
          }).select('_id');
          allFolderIds.push(...descendants.map((f) => f._id));

          await File.updateMany(
            { userId, folderId: { $in: allFolderIds }, isDeleted: false },
            { $set: { isDeleted: true, deletedAt: new Date(), status: 'DELETED' } }
          );

          succeeded.push({ id, type, status: 'trashed' });
        } else {
          const file = await File.findOneAndUpdate(
            { _id: id, userId, isDeleted: false },
            { $set: { isDeleted: true, deletedAt: new Date(), status: 'DELETED' } },
            { new: true }
          );
          if (!file) {
            failed.push({ id, type: 'file', error: 'File not found' });
            continue;
          }
          succeeded.push({ id, type: 'file', status: 'trashed' });
        }
      } catch (err) {
        failed.push({ id, type, error: err.message });
      }
    }

    res.json({
      success: true,
      data: {
        succeeded,
        failed,
        summary: { total: ids.length, succeeded: succeeded.length, failed: failed.length },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/bulk/restore
 * Restore multiple items from trash.
 */
const bulkRestore = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids array is required and must not be empty.', 400);
    }
    if (ids.length > 100) {
      throw new AppError('Maximum 100 items per bulk operation.', 400);
    }

    const succeeded = [];
    const failed = [];

    for (const { id, type } of ids) {
      try {
        if (type === 'folder') {
          const folder = await Folder.findOneAndUpdate(
            { _id: id, userId, isDeleted: true },
            { $set: { isDeleted: false, deletedAt: null } },
            { new: true }
          );
          if (!folder) {
            failed.push({ id, type, error: 'Folder not found in trash' });
            continue;
          }

          // Restore descendant folders
          await Folder.updateMany(
            { userId, path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }, isDeleted: true },
            { $set: { isDeleted: false, deletedAt: null } }
          );

          // Restore files
          const allFolderIds = [folder._id];
          const descendants = await Folder.find({
            userId, path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }
          }).select('_id');
          allFolderIds.push(...descendants.map((f) => f._id));

          await File.updateMany(
            { userId, folderId: { $in: allFolderIds }, isDeleted: true },
            { $set: { isDeleted: false, deletedAt: null, status: 'AVAILABLE' } }
          );

          succeeded.push({ id, type, status: 'restored' });
        } else {
          const file = await File.findOneAndUpdate(
            { _id: id, userId, isDeleted: true },
            { $set: { isDeleted: false, deletedAt: null, status: 'AVAILABLE' } },
            { new: true }
          );
          if (!file) {
            failed.push({ id, type: 'file', error: 'File not found in trash' });
            continue;
          }
          succeeded.push({ id, type: 'file', status: 'restored' });
        }
      } catch (err) {
        failed.push({ id, type, error: err.message });
      }
    }

    res.json({
      success: true,
      data: {
        succeeded,
        failed,
        summary: { total: ids.length, succeeded: succeeded.length, failed: failed.length },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/bulk/permanent-delete
 * Permanently delete multiple items with full cleanup.
 */
const bulkPermanentDelete = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids array is required and must not be empty.', 400);
    }
    if (ids.length > 100) {
      throw new AppError('Maximum 100 items per bulk operation.', 400);
    }

    const succeeded = [];
    const failed = [];
    let totalFreedBytes = 0;

    for (const { id, type } of ids) {
      try {
        if (type === 'folder') {
          const folder = await Folder.findOne({ _id: id, userId, isDeleted: true });
          if (!folder) {
            failed.push({ id, type, error: 'Folder not found in trash' });
            continue;
          }

          // Find all descendant folders
          const allFolderIds = [folder._id];
          const descendants = await Folder.find({
            userId, path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }
          }).select('_id');
          allFolderIds.push(...descendants.map((f) => f._id));

          // Permanently delete files
          const files = await File.find({ userId, folderId: { $in: allFolderIds } });
          let freedBytes = 0;
          for (const file of files) {
            freedBytes += file.size;
            await deleteFileData(file);
          }

          // Delete folders
          await Folder.deleteMany({ _id: { $in: allFolderIds } });

          totalFreedBytes += freedBytes;
          succeeded.push({ id, type, status: 'permanently_deleted', freedBytes });
        } else {
          const file = await File.findOne({ _id: id, userId, isDeleted: true });
          if (!file) {
            failed.push({ id, type: 'file', error: 'File not found in trash' });
            continue;
          }

          const freedBytes = file.size;
          await deleteFileData(file);
          totalFreedBytes += freedBytes;
          succeeded.push({ id, type: 'file', status: 'permanently_deleted', freedBytes });
        }
      } catch (err) {
        failed.push({ id, type, error: err.message });
      }
    }

    // Update storage quota
    if (totalFreedBytes > 0) {
      await User.findByIdAndUpdate(userId, { $inc: { storageUsed: -totalFreedBytes } });
    }

    res.json({
      success: true,
      data: {
        succeeded,
        failed,
        summary: {
          total: ids.length,
          succeeded: succeeded.length,
          failed: failed.length,
          totalFreedBytes,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/bulk/download
 * Download multiple files as a ZIP archive.
 */
const bulkDownloadZip = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { fileIds } = req.body;

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      throw new AppError('fileIds array is required and must not be empty.', 400);
    }
    if (fileIds.length > 50) {
      throw new AppError('Maximum 50 files per ZIP download.', 400);
    }

    // Fetch all files and verify ownership or shared access
    const files = await File.find({
      _id: { $in: fileIds },
      isDeleted: false,
      status: 'AVAILABLE',
      $or: [
        { userId },
        // Also allow files accessible to this user
      ]
    });

    if (files.length === 0) {
      throw new AppError('No accessible files found.', 404);
    }

    // Verify all files exist on disk or in chunk storage
    const accessibleFiles = [];
    for (const file of files) {
      if (file.totalChunks > 0) {
        accessibleFiles.push(file);
      } else {
        try {
          await fs.access(file.storagePath);
          accessibleFiles.push(file);
        } catch {
          console.warn(`[BULK ZIP] File not on disk: ${file.storagePath}`);
        }
      }
    }

    if (accessibleFiles.length === 0) {
      throw new AppError('No files are available on disk for download.', 404);
    }

    // Set response headers for ZIP
    const zipName = `MiniDrive_${accessibleFiles.length}_files_${Date.now()}.zip`;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
    });

    // Create ZIP archive and stream to response
    let archiverModule;
    try {
      archiverModule = require('archiver');
    } catch {
      throw new AppError('ZIP downloads are not available. Install archiver: npm install archiver', 500);
    }
    
    const createArchive = (options) => {
      if (archiverModule.ZipArchive) return new archiverModule.ZipArchive(options);
      if (typeof archiverModule === 'function') return archiverModule('zip', options);
      if (typeof archiverModule.default === 'function') return archiverModule.default('zip', options);
      if (archiverModule.Archiver) return new archiverModule.Archiver('zip', options);
      const archiverFactory = archiverModule.default || archiverModule;
      if (typeof archiverFactory === 'function') return archiverFactory('zip', options);
      throw new AppError('Unsupported archiver format', 500);
    };

    const archive = createArchive({ zlib: { level: 5 } });

    archive.on('error', (err) => {
      console.error('[BULK ZIP] Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: { message: 'ZIP creation failed' } });
      }
    });

    archive.pipe(res);

    // Track duplicate filenames
    const usedNames = {};
    for (const file of accessibleFiles) {
      let name = file.originalName || file.filename;
      if (usedNames[name]) {
        const ext = name.lastIndexOf('.') !== -1 ? name.slice(name.lastIndexOf('.')) : '';
        const base = name.lastIndexOf('.') !== -1 ? name.slice(0, name.lastIndexOf('.')) : name;
        name = `${base} (${usedNames[name]})${ext}`;
      }
      usedNames[file.originalName || file.filename] = (usedNames[file.originalName || file.filename] || 0) + 1;

      if (file.totalChunks > 0) {
        try {
          await fs.access(file.storagePath);
          archive.file(file.storagePath, { name });
        } catch {
          for (let i = 0; i < file.totalChunks; i++) {
            const stream = await chunkService.getChunkStream(file._id, i);
            archive.append(stream, { name: `${name}.part${i}` });
          }
        }
      } else {
        archive.file(file.storagePath, { name });
      }
    }

    await archive.finalize();
    console.log(`[BULK ZIP] Streamed ${accessibleFiles.length} files as ${zipName}`);
  } catch (error) {
    if (!res.headersSent) next(error);
  }
};

module.exports = { bulkSoftDelete, bulkRestore, bulkPermanentDelete, bulkDownloadZip };
