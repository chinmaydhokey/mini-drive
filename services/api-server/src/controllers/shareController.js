const bcrypt = require('bcryptjs');
const ShareLink = require('../models/ShareLink');
const File = require('../models/File');
const Folder = require('../models/Folder');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const fs = require('fs');

function buildContentDisposition(dispositionType, filename) {
  const cleanName = (filename || 'download')
    .replace(/["\r\n\\]/g, '_')
    .replace(/\s+\./g, '.')
    .trim();
  const asciiFallback = cleanName.replace(/[^\x20-\x7E]/g, '_');
  const encodedName = encodeURIComponent(cleanName);
  return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`;
}

/**
 * POST /api/shares
 * Create a public share link for a file or folder.
 */
const createShare = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { fileId, folderId, resourceType, permission, expiresIn, password, maxDownloads } = req.body;

    const type = resourceType || 'file';

    if (type === 'folder') {
      if (!folderId) throw new AppError('folderId is required for folder sharing.', 400);
      const folder = await Folder.findOne({ _id: folderId, userId, isDeleted: false });
      if (!folder) throw new AppError('Folder not found.', 404);
    } else {
      if (!fileId) throw new AppError('fileId is required.', 400);
      const file = await File.findOne({ _id: fileId, userId, isDeleted: false, status: 'AVAILABLE' });
      if (!file) throw new AppError('File not found.', 404);
    }

    // Build share link data
    const shareData = {
      createdBy: userId,
      permission: permission || 'DOWNLOAD',
      shareType: 'PUBLIC',
      resourceType: type,
    };

    if (type === 'folder') {
      shareData.folderId = folderId;
      // fileId is not set for folder shares
    } else {
      shareData.fileId = fileId;
    }

    // Expiry (in seconds)
    if (expiresIn) {
      shareData.expiresAt = new Date(Date.now() + parseInt(expiresIn, 10) * 1000);
    }

    // Password protection
    if (password) {
      shareData.isPasswordProtected = true;
      shareData.passwordHash = await bcrypt.hash(password, 10);
    }

    // Download limit
    if (maxDownloads) {
      shareData.maxDownloads = parseInt(maxDownloads, 10);
    }

    const share = await ShareLink.create(shareData);

    res.status(201).json({
      success: true,
      data: {
        share: share.toSafeObject(),
        url: `${req.protocol}://${req.get('host')}/api/shares/${share.token}`,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/shares/batch
 * Create a single public share link for multiple files/folders at once.
 */
const createBatchShare = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { fileIds = [], folderIds = [], permission, expiresIn, password, maxDownloads } = req.body;

    if (fileIds.length === 0 && folderIds.length === 0) {
      throw new AppError('At least one fileId or folderId is required.', 400);
    }

    // Validate ownership for all files
    if (fileIds.length > 0) {
      const files = await File.find({ _id: { $in: fileIds }, userId, isDeleted: false, status: 'AVAILABLE' });
      if (files.length !== fileIds.length) {
        throw new AppError(`Some files not found. Found ${files.length} of ${fileIds.length}.`, 404);
      }
    }

    // Validate ownership for all folders
    if (folderIds.length > 0) {
      const folders = await Folder.find({ _id: { $in: folderIds }, userId, isDeleted: false });
      if (folders.length !== folderIds.length) {
        throw new AppError(`Some folders not found. Found ${folders.length} of ${folderIds.length}.`, 404);
      }
    }

    // Create a single unified ShareLink representing the collection
    const shareData = {
      createdBy: userId,
      permission: permission || 'DOWNLOAD',
      shareType: 'PUBLIC',
      resourceType: 'batch',
      fileIds,
      folderIds,
      fileId: fileIds[0] || null,
      folderId: folderIds[0] || null,
    };

    if (expiresIn) shareData.expiresAt = new Date(Date.now() + parseInt(expiresIn, 10) * 1000);
    if (password) {
      shareData.isPasswordProtected = true;
      shareData.passwordHash = await bcrypt.hash(password, 10);
    }
    if (maxDownloads) shareData.maxDownloads = parseInt(maxDownloads, 10);

    const share = await ShareLink.create(shareData);
    const url = `${req.protocol}://${req.get('host')}/shared/${share.token}`;

    res.status(201).json({
      success: true,
      data: {
        share: share.toSafeObject(),
        shares: [{
          shareId: share._id,
          token: share.token,
          resourceType: 'batch',
          url,
        }],
        url,
        token: share.token,
        totalItems: fileIds.length + folderIds.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/shares/private
 * Create a private share for specific users by email.
 */
const createPrivateShare = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { fileId, folderId, resourceType, users } = req.body;

    const type = resourceType || 'file';

    if (!Array.isArray(users) || users.length === 0) {
      throw new AppError('users array is required with at least one entry.', 400);
    }

    // Validate resource ownership
    if (type === 'folder') {
      if (!folderId) throw new AppError('folderId is required for folder sharing.', 400);
      const folder = await Folder.findOne({ _id: folderId, userId, isDeleted: false });
      if (!folder) throw new AppError('Folder not found.', 404);
    } else {
      if (!fileId) throw new AppError('fileId is required.', 400);
      const file = await File.findOne({ _id: fileId, userId, isDeleted: false, status: 'AVAILABLE' });
      if (!file) throw new AppError('File not found.', 404);
    }

    // Resolve emails to user IDs
    const sharedWith = [];
    const notFound = [];

    for (const { email, permission } of users) {
      const targetUser = await User.findOne({ email: email.toLowerCase().trim() });
      if (!targetUser) {
        notFound.push(email);
        continue;
      }
      if (targetUser._id.toString() === userId) {
        continue; // Skip sharing with self
      }
      sharedWith.push({
        userId: targetUser._id,
        email: targetUser.email,
        permission: permission || 'VIEW',
        addedAt: new Date(),
      });
    }

    if (sharedWith.length === 0 && notFound.length > 0) {
      throw new AppError(`No registered users found for: ${notFound.join(', ')}`, 404);
    }

    // Build share link data
    const shareData = {
      createdBy: userId,
      shareType: 'PRIVATE',
      resourceType: type,
      permission: 'DOWNLOAD', // Base permission for the share
      sharedWith,
    };

    if (type === 'folder') {
      shareData.folderId = folderId;
    } else {
      shareData.fileId = fileId;
    }

    const share = await ShareLink.create(shareData);

    res.status(201).json({
      success: true,
      data: {
        share: share.toSafeObject(),
        sharedWithCount: sharedWith.length,
        notFoundEmails: notFound,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/shares/batch-private
 * Create a single private share link for multiple files/folders to specific users.
 */
const createBatchPrivateShare = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { fileIds = [], folderIds = [], users } = req.body;

    if (fileIds.length === 0 && folderIds.length === 0) {
      throw new AppError('At least one fileId or folderId is required.', 400);
    }
    if (!Array.isArray(users) || users.length === 0) {
      throw new AppError('users array is required with at least one entry.', 400);
    }

    // Validate ownership
    if (fileIds.length > 0) {
      const files = await File.find({ _id: { $in: fileIds }, userId, isDeleted: false, status: 'AVAILABLE' });
      if (files.length !== fileIds.length) throw new AppError('Some files not found.', 404);
    }
    if (folderIds.length > 0) {
      const folders = await Folder.find({ _id: { $in: folderIds }, userId, isDeleted: false });
      if (folders.length !== folderIds.length) throw new AppError('Some folders not found.', 404);
    }

    // Resolve user emails
    const sharedWith = [];
    const notFound = [];
    for (const { email, permission } of users) {
      const targetUser = await User.findOne({ email: email.toLowerCase().trim() });
      if (!targetUser) { notFound.push(email); continue; }
      if (targetUser._id.toString() === userId) continue;
      sharedWith.push({
        userId: targetUser._id,
        email: targetUser.email,
        permission: permission || 'VIEW',
        addedAt: new Date(),
      });
    }

    if (sharedWith.length === 0 && notFound.length > 0) {
      throw new AppError(`No registered users found for: ${notFound.join(', ')}`, 404);
    }

    // Single unified private share
    const share = await ShareLink.create({
      createdBy: userId,
      shareType: 'PRIVATE',
      resourceType: 'batch',
      fileIds,
      folderIds,
      fileId: fileIds[0] || null,
      folderId: folderIds[0] || null,
      permission: 'DOWNLOAD',
      sharedWith,
    });

    res.status(201).json({
      success: true,
      data: {
        share: share.toSafeObject(),
        totalItems: fileIds.length + folderIds.length,
        sharedWithCount: sharedWith.length,
        notFoundEmails: notFound,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/shares/shared-with-me
 * List items shared with the current user.
 */
const listSharedWithMe = async (req, res, next) => {
  try {
    const { userId } = req.user;

    const shares = await ShareLink.find({
      'sharedWith.userId': userId,
      shareType: 'PRIVATE',
      isRevoked: false,
    })
      .populate('fileId', 'filename originalName mimeType size createdAt isEncrypted encryptionSalt chunkIVs totalChunks')
      .populate('fileIds', 'filename originalName mimeType size createdAt isEncrypted encryptionSalt chunkIVs totalChunks')
      .populate('folderId', 'name path depth createdAt')
      .populate('folderIds', 'name path depth createdAt')
      .populate('createdBy', 'email name')
      .sort({ createdAt: -1 });

    // Filter out expired shares and enhance with user-specific permission
    const items = shares
      .filter((share) => {
        const check = share.isAccessible();
        return check.valid;
      })
      .map((share) => {
        const userEntry = share.sharedWith.find(
          (sw) => sw.userId.toString() === userId
        );
        return {
          shareId: share._id,
          token: share.token,
          resourceType: share.resourceType,
          file: share.fileId || (share.fileIds && share.fileIds[0]) || null,
          files: share.fileIds || [],
          folder: share.folderId || (share.folderIds && share.folderIds[0]) || null,
          folders: share.folderIds || [],
          sharedBy: share.createdBy,
          myPermission: userEntry?.permission || 'VIEW',
          sharedAt: userEntry?.addedAt || share.createdAt,
        };
      });

    res.json({
      success: true,
      data: { items, total: items.length },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/shares/:shareId/permissions
 * Update a user's permission on a private share (owner only).
 */
const updateSharePermissions = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { shareId } = req.params;
    const { targetUserId, permission } = req.body;

    if (!targetUserId || !permission) {
      throw new AppError('targetUserId and permission are required.', 400);
    }
    if (!['VIEW', 'DOWNLOAD'].includes(permission)) {
      throw new AppError('permission must be VIEW or DOWNLOAD.', 400);
    }

    const share = await ShareLink.findOne({ _id: shareId, createdBy: userId });
    if (!share) throw new AppError('Share link not found.', 404);

    const userEntry = share.sharedWith.find(
      (sw) => sw.userId.toString() === targetUserId
    );
    if (!userEntry) {
      throw new AppError('User not found in this share.', 404);
    }

    userEntry.permission = permission;
    await share.save();

    res.json({
      success: true,
      data: {
        message: 'Permissions updated.',
        userId: targetUserId,
        permission,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/shares/:shareId/users/:targetUserId
 * Remove a user's access from a private share (owner only).
 */
const removeSharedUser = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { shareId, targetUserId } = req.params;

    const share = await ShareLink.findOne({ _id: shareId, createdBy: userId });
    if (!share) throw new AppError('Share link not found.', 404);

    const initialLength = share.sharedWith.length;
    share.sharedWith = share.sharedWith.filter(
      (sw) => sw.userId.toString() !== targetUserId
    );

    if (share.sharedWith.length === initialLength) {
      throw new AppError('User was not shared on this link.', 404);
    }

    // If no users left, revoke the share
    if (share.sharedWith.length === 0) {
      share.isRevoked = true;
    }

    await share.save();

    res.json({
      success: true,
      data: {
        message: 'User access removed.',
        remainingUsers: share.sharedWith.length,
        isRevoked: share.isRevoked,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/shares/file/:fileId
 * Get all active shares for a specific file (owner only).
 */
const getSharesForFile = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, userId });
    if (!file) throw new AppError('File not found.', 404);

    const shares = await ShareLink.find({
      $or: [{ fileId }, { fileIds: fileId }],
      createdBy: userId,
      isRevoked: false,
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        shares: shares.map((s) => s.toSafeObject()),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/shares/:token
 * Access a shared file, folder, or batch collection by token.
 */
const accessShare = async (req, res, next) => {
  try {
    const { token } = req.params;

    const share = await ShareLink.findOne({ token });
    if (!share) throw new AppError('Share link not found.', 404);

    // Validate accessibility
    const check = share.isAccessible();
    if (!check.valid) throw new AppError(check.reason, 403);

    // Private share: verify authenticated user is in sharedWith[]
    if (share.shareType === 'PRIVATE') {
      if (!req.user) {
        throw new AppError('Authentication required to access this private share.', 401);
      }
      const isInList = share.sharedWith.some(
        (sw) => sw.userId.toString() === req.user.userId
      );
      const isOwner = share.createdBy.toString() === req.user.userId;
      if (!isInList && !isOwner) {
        throw new AppError('You do not have access to this private share.', 403);
      }
    }

    // Password check (for public shares)
    if (share.isPasswordProtected) {
      const password = req.query.password || req.body?.password;
      if (!password) {
        return res.status(401).json({
          success: false,
          error: { message: 'This shared file is password protected.', passwordRequired: true },
        });
      }
      const valid = await bcrypt.compare(password, share.passwordHash);
      if (!valid) throw new AppError('Incorrect password.', 401);
    }

    // 1. Batch Collection Share
    if (share.resourceType === 'batch') {
      const directFiles = await File.find({
        _id: { $in: share.fileIds || [] },
        isDeleted: false,
        status: 'AVAILABLE',
      }).select('filename originalName mimeType size createdAt isEncrypted encryptionSalt chunkIVs totalChunks');

      let folderFiles = [];
      let subfolders = [];
      if (share.folderIds && share.folderIds.length > 0) {
        const topFolders = await Folder.find({
          _id: { $in: share.folderIds },
          isDeleted: false,
        }).select('_id name path');

        subfolders = topFolders;
        for (const folder of topFolders) {
          const descendants = await Folder.find({
            userId: folder.userId,
            path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
            isDeleted: false,
          }).select('_id name path');
          const allFolderIds = [folder._id, ...descendants.map((f) => f._id)];

          const fFiles = await File.find({
            folderId: { $in: allFolderIds },
            isDeleted: false,
            status: 'AVAILABLE',
          }).select('filename originalName mimeType size createdAt folderId isEncrypted encryptionSalt chunkIVs totalChunks');
          folderFiles.push(...fFiles);
        }
      }

      const allFiles = [...directFiles, ...folderFiles];
      const totalSize = allFiles.reduce((acc, f) => acc + (f.size || 0), 0);

      return res.json({
        success: true,
        data: {
          resourceType: 'batch',
          files: allFiles,
          subfolders,
          totalFiles: allFiles.length,
          totalSize,
          permission: share.permission,
          expiresAt: share.expiresAt,
        },
      });
    }

    // 2. Folder Share
    if (share.resourceType === 'folder' && share.folderId) {
      const folder = await Folder.findById(share.folderId);
      if (!folder || folder.isDeleted) {
        throw new AppError('The shared folder is no longer available.', 404);
      }

      const descendants = await Folder.find({
        userId: folder.userId,
        path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
        isDeleted: false,
      }).select('_id name path');
      const allFolderIds = [folder._id, ...descendants.map((f) => f._id)];

      const files = await File.find({
        folderId: { $in: allFolderIds },
        isDeleted: false,
        status: 'AVAILABLE',
      }).select('filename originalName mimeType size createdAt folderId isEncrypted encryptionSalt chunkIVs totalChunks');

      const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);

      return res.json({
        success: true,
        data: {
          resourceType: 'folder',
          folder: { _id: folder._id, name: folder.name },
          subfolders: descendants,
          files,
          totalFiles: files.length,
          totalSize,
          permission: share.permission,
          expiresAt: share.expiresAt,
        },
      });
    }

    // 3. Single File Share
    const file = await File.findById(share.fileId);
    if (!file || file.isDeleted) throw new AppError('The shared file is no longer available.', 404);

    res.json({
      success: true,
      data: {
        resourceType: 'file',
        file: {
          _id: file._id,
          filename: file.filename,
          originalName: file.originalName,
          mimeType: file.mimeType,
          size: file.size,
          createdAt: file.createdAt,
          isEncrypted: file.isEncrypted,
          encryptionSalt: file.encryptionSalt,
          chunkIVs: file.chunkIVs,
          totalChunks: file.totalChunks,
        },
        permission: share.permission,
        expiresAt: share.expiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/shares/:token/download
 * Download a shared file or entire batch/folder collection as ZIP.
 */
const downloadShare = async (req, res, next) => {
  try {
    const { token } = req.params;

    const share = await ShareLink.findOne({ token });
    if (!share) throw new AppError('Share link not found.', 404);

    const check = share.isAccessible();
    if (!check.valid) throw new AppError(check.reason, 403);

    if (share.permission === 'VIEW') {
      throw new AppError('This share link only allows viewing, not downloading.', 403);
    }

    // Private share: verify access
    if (share.shareType === 'PRIVATE') {
      if (!req.user) {
        throw new AppError('Authentication required to download from this private share.', 401);
      }
      const isInList = share.sharedWith.some(
        (sw) => sw.userId.toString() === req.user.userId
      );
      const isOwner = share.createdBy.toString() === req.user.userId;
      if (!isInList && !isOwner) {
        throw new AppError('You do not have access to this private share.', 403);
      }
    }

    // Password check
    if (share.isPasswordProtected) {
      const password = req.query.password;
      if (!password) throw new AppError('Password required.', 401);
      const valid = await bcrypt.compare(password, share.passwordHash);
      if (!valid) throw new AppError('Incorrect password.', 401);
    }

    // Batch or Folder ZIP Download
    if (share.resourceType === 'batch' || share.resourceType === 'folder') {
      let allFiles = [];
      if (share.resourceType === 'batch') {
        const directFiles = await File.find({
          _id: { $in: share.fileIds || [] },
          isDeleted: false,
          status: 'AVAILABLE',
        });
        allFiles.push(...directFiles);

        if (share.folderIds && share.folderIds.length > 0) {
          for (const folderId of share.folderIds) {
            const folder = await Folder.findById(folderId);
            if (folder && !folder.isDeleted) {
              const descendants = await Folder.find({
                userId: folder.userId,
                path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
                isDeleted: false,
              }).select('_id');
              const folderIds = [folder._id, ...descendants.map((f) => f._id)];
              const fFiles = await File.find({ folderId: { $in: folderIds }, isDeleted: false, status: 'AVAILABLE' });
              allFiles.push(...fFiles);
            }
          }
        }
      } else if (share.resourceType === 'folder' && share.folderId) {
        const folder = await Folder.findById(share.folderId);
        if (folder && !folder.isDeleted) {
          const descendants = await Folder.find({
            userId: folder.userId,
            path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
            isDeleted: false,
          }).select('_id');
          const folderIds = [folder._id, ...descendants.map((f) => f._id)];
          allFiles = await File.find({ folderId: { $in: folderIds }, isDeleted: false, status: 'AVAILABLE' });
        }
      }

      if (allFiles.length === 0) {
        throw new AppError('No files found in this shared collection.', 404);
      }

      const zipName = `MiniDrive_Shared_${allFiles.length}_files_${Date.now()}.zip`;
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
      });

      let archiverModule;
      try {
        archiverModule = require('archiver');
      } catch {
        throw new AppError('ZIP downloads are not available.', 500);
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
        console.error('[BATCH SHARE ZIP] Archive error:', err);
        if (!res.headersSent) res.status(500).json({ success: false, error: { message: 'ZIP creation failed' } });
      });

      archive.pipe(res);

      const chunkService = require('../services/chunkService');
      const usedNames = {};
      for (const file of allFiles) {
        let rawName = (file.originalName || file.filename || 'file').replace(/\s+\./g, '.').trim();
        let name = rawName;
        if (usedNames[rawName]) {
          const ext = rawName.lastIndexOf('.') !== -1 ? rawName.slice(rawName.lastIndexOf('.')) : '';
          const base = rawName.lastIndexOf('.') !== -1 ? rawName.slice(0, rawName.lastIndexOf('.')) : rawName;
          name = `${base} (${usedNames[rawName]})${ext}`;
        }
        usedNames[rawName] = (usedNames[rawName] || 0) + 1;

        if (file.totalChunks > 0) {
          let streamedFromDisk = false;
          if (file.storagePath && !file.storagePath.startsWith('chunked://')) {
            try {
              await require('fs').promises.access(file.storagePath);
              archive.file(file.storagePath, { name });
              streamedFromDisk = true;
            } catch {}
          }
          if (!streamedFromDisk) {
            const { PassThrough } = require('stream');
            const passThrough = new PassThrough();
            archive.append(passThrough, { name });
            for (let i = 0; i < file.totalChunks; i++) {
              const chunkStream = await chunkService.getChunkStream(file._id, i);
              await new Promise((resolve, reject) => {
                chunkStream.pipe(passThrough, { end: i === file.totalChunks - 1 });
                chunkStream.on('end', resolve);
                chunkStream.on('error', (err) => {
                  passThrough.destroy(err);
                  reject(err);
                });
              });
            }
          }
        } else if (file.storagePath && !file.storagePath.startsWith('chunked://')) {
          archive.file(file.storagePath, { name });
        } else {
          archive.append(Buffer.alloc(0), { name });
        }
      }

      await ShareLink.updateOne({ _id: share._id }, { $inc: { downloadCount: 1 } });
      await archive.finalize();
      return;
    }

    // Single File Download
    const file = await File.findById(share.fileId);
    if (!file || file.isDeleted) throw new AppError('The shared file is no longer available.', 404);

    if (file.totalChunks === 0) {
      try {
        await require('fs').promises.access(file.storagePath);
      } catch {
        throw new AppError('File data not found on storage.', 500);
      }
    }

    // Increment download count atomically
    await ShareLink.updateOne({ _id: share._id }, { $inc: { downloadCount: 1 } });

    const streamLength = file.isEncrypted && file.totalChunks > 0
      ? file.size + (file.totalChunks * 16)
      : file.size;
    res.set({
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': buildContentDisposition('attachment', file.originalName || file.filename),
      'Content-Length': streamLength,
      'Accept-Ranges': 'bytes',
    });

    if (file.totalChunks > 0) {
      const chunkService = require('../services/chunkService');
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

    fs.createReadStream(file.storagePath).pipe(res);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/shares/:token/view
 * View a shared file inline (for VIEW and DOWNLOAD permission).
 */
const viewShare = async (req, res, next) => {
  try {
    const { token } = req.params;

    const share = await ShareLink.findOne({ token });
    if (!share) throw new AppError('Share link not found.', 404);

    const check = share.isAccessible();
    if (!check.valid) throw new AppError(check.reason, 403);

    // Private share: verify access
    if (share.shareType === 'PRIVATE') {
      if (!req.user) {
        throw new AppError('Authentication required to view this private share.', 401);
      }
      const isInList = share.sharedWith.some(
        (sw) => sw.userId.toString() === req.user.userId
      );
      const isOwner = share.createdBy.toString() === req.user.userId;
      if (!isInList && !isOwner) {
        throw new AppError('You do not have access to this private share.', 403);
      }
    }

    // Password check
    if (share.isPasswordProtected) {
      const password = req.query.password;
      if (!password) throw new AppError('Password required.', 401);
      const valid = await bcrypt.compare(password, share.passwordHash);
      if (!valid) throw new AppError('Incorrect password.', 401);
    }

    const targetFileId = share.fileId || (share.fileIds && share.fileIds[0]);
    const file = await File.findById(targetFileId);
    if (!file || file.isDeleted) throw new AppError('The shared file is no longer available.', 404);

    if (file.totalChunks === 0) {
      try {
        await require('fs').promises.access(file.storagePath);
      } catch {
        throw new AppError('File data not found on storage.', 500);
      }
    }

    const streamLength = file.isEncrypted && file.totalChunks > 0
      ? file.size + (file.totalChunks * 16)
      : file.size;
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.set({
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': buildContentDisposition('inline', file.originalName || file.filename),
      'Content-Length': streamLength,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Embedder-Policy': 'unsafe-none',
      'Accept-Ranges': 'bytes',
    });

    if (file.totalChunks > 0) {
      const chunkService = require('../services/chunkService');
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

    fs.createReadStream(file.storagePath).pipe(res);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/shares/:token/files/:fileId/download
 * Download a specific file from a batch share.
 */
const downloadBatchFile = async (req, res, next) => {
  try {
    const { token, fileId } = req.params;

    const share = await ShareLink.findOne({ token });
    if (!share) throw new AppError('Share link not found.', 404);

    const check = share.isAccessible();
    if (!check.valid) throw new AppError(check.reason, 403);
    if (share.permission === 'VIEW') {
      throw new AppError('This share link only allows viewing, not downloading.', 403);
    }

    if (share.shareType === 'PRIVATE') {
      if (!req.user) throw new AppError('Authentication required.', 401);
      const isInList = share.sharedWith.some((sw) => sw.userId.toString() === req.user.userId);
      const isOwner = share.createdBy.toString() === req.user.userId;
      if (!isInList && !isOwner) throw new AppError('Access denied.', 403);
    }

    if (share.isPasswordProtected) {
      const password = req.query.password;
      if (!password) throw new AppError('Password required.', 401);
      const valid = await bcrypt.compare(password, share.passwordHash);
      if (!valid) throw new AppError('Incorrect password.', 401);
    }

    const file = await File.findOne({ _id: fileId, isDeleted: false, status: 'AVAILABLE' });
    if (!file) throw new AppError('File not found.', 404);

    if (file.totalChunks === 0) {
      try {
        await require('fs').promises.access(file.storagePath);
      } catch {
        throw new AppError('File data not found on storage.', 500);
      }
    }

    await ShareLink.updateOne({ _id: share._id }, { $inc: { downloadCount: 1 } });

    const streamLength = file.isEncrypted && file.totalChunks > 0
      ? file.size + (file.totalChunks * 16)
      : file.size;
    res.set({
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': buildContentDisposition('attachment', file.originalName || file.filename),
      'Content-Length': streamLength,
      'Accept-Ranges': 'bytes',
    });

    if (file.totalChunks > 0) {
      const chunkService = require('../services/chunkService');
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

    fs.createReadStream(file.storagePath).pipe(res);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/shares/:token/files/:fileId/view
 * View/preview a specific file from a batch share inline.
 */
const viewBatchFile = async (req, res, next) => {
  try {
    const { token, fileId } = req.params;

    const share = await ShareLink.findOne({ token });
    if (!share) throw new AppError('Share link not found.', 404);

    const check = share.isAccessible();
    if (!check.valid) throw new AppError(check.reason, 403);

    if (share.shareType === 'PRIVATE') {
      if (!req.user) throw new AppError('Authentication required.', 401);
      const isInList = share.sharedWith.some((sw) => sw.userId.toString() === req.user.userId);
      const isOwner = share.createdBy.toString() === req.user.userId;
      if (!isInList && !isOwner) throw new AppError('Access denied.', 403);
    }

    if (share.isPasswordProtected) {
      const password = req.query.password;
      if (!password) throw new AppError('Password required.', 401);
      const valid = await bcrypt.compare(password, share.passwordHash);
      if (!valid) throw new AppError('Incorrect password.', 401);
    }

    const file = await File.findOne({ _id: fileId, isDeleted: false, status: 'AVAILABLE' });
    if (!file) throw new AppError('File not found.', 404);

    if (file.totalChunks === 0) {
      try {
        await require('fs').promises.access(file.storagePath);
      } catch {
        throw new AppError('File data not found on storage.', 500);
      }
    }

    const streamLength = file.isEncrypted && file.totalChunks > 0
      ? file.size + (file.totalChunks * 16)
      : file.size;
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.set({
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': buildContentDisposition('inline', file.originalName || file.filename),
      'Content-Length': streamLength,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Embedder-Policy': 'unsafe-none',
      'Accept-Ranges': 'bytes',
    });

    if (file.totalChunks > 0) {
      const chunkService = require('../services/chunkService');
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

    fs.createReadStream(file.storagePath).pipe(res);
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/shares/:shareId
 * Revoke a share link (owner only, requires auth).
 */
const revokeShare = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const share = await ShareLink.findOne({ _id: req.params.shareId, createdBy: userId });
    if (!share) throw new AppError('Share link not found.', 404);

    share.isRevoked = true;
    await share.save();

    res.json({
      success: true,
      data: { message: 'Share link revoked.', shareId: share._id },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createShare,
  createBatchShare,
  createPrivateShare,
  createBatchPrivateShare,
  listSharedWithMe,
  updateSharePermissions,
  removeSharedUser,
  getSharesForFile,
  accessShare,
  downloadShare,
  viewShare,
  downloadBatchFile,
  viewBatchFile,
  revokeShare,
};
