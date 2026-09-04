const crypto = require('crypto');
const File = require('../models/File');
const User = require('../models/User');
const VersionHistory = require('../models/VersionHistory');
const AppError = require('../utils/AppError');
const cache = require('../services/cacheService');
const chunkService = require('../services/chunkService');
const { v4: uuidv4 } = require('uuid');

/**
 * POST /api/files/upload/init
 * Initialize a resumable upload session.
 */
const initUpload = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { filename, mimeType, size, totalChunks, folderId, isEncrypted, encryptionSalt } = req.body;

    if (!filename || !mimeType || !size || !totalChunks) {
      throw new AppError('filename, mimeType, size, and totalChunks are required.', 400);
    }

    // Check storage quota
    const user = await User.findById(userId);
    if (user.storageUsed + size > user.storageQuota) {
      throw new AppError(
        `Storage quota exceeded. Used: ${File.formatSize(user.storageUsed)}, ` +
        `Quota: ${File.formatSize(user.storageQuota)}, ` +
        `File: ${File.formatSize(size)}`,
        400
      );
    }

    const storageKey = uuidv4();

    // Create file record with UPLOADING status
    const fileDoc = await File.create({
      userId,
      folderId: folderId || null,
      filename,
      originalName: filename,
      mimeType,
      size,
      storagePath: `chunked://${storageKey}`, // virtual path for chunked files
      storageKey,
      status: 'UPLOADING',
      totalChunks: parseInt(totalChunks, 10),
      isEncrypted: isEncrypted || false,
      encryptionSalt: encryptionSalt || null,
    });

    res.status(201).json({
      success: true,
      data: {
        fileId: fileDoc._id,
        uploadId: fileDoc._id, // uploadId === fileId for simplicity
        totalChunks: fileDoc.totalChunks,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/files/upload/chunk
 * Upload a single chunk of a resumable upload.
 * Expects multipart: field 'chunk' (binary), plus fields fileId, chunkIndex, chunkHash.
 */
const uploadChunk = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { fileId, chunkIndex, chunkHash } = req.body;

    if (!fileId || chunkIndex === undefined) {
      throw new AppError('fileId and chunkIndex are required.', 400);
    }

    // Verify the file belongs to the user and is in UPLOADING state
    const file = await File.findOne({ _id: fileId, userId, status: 'UPLOADING' });
    if (!file) {
      throw new AppError('Upload session not found or not in UPLOADING state.', 404);
    }

    // Forward chunk to metadata service (which handles CAS dedup + storage node replication)
    const FormData = require('form-data');
    const axios = require('axios');
    const METADATA_URL = process.env.METADATA_URL || 'http://localhost:4000';

    const form = new FormData();
    form.append('fileId', fileId);
    form.append('chunkIndex', chunkIndex.toString());
    if (chunkHash) form.append('chunkHash', chunkHash);
    form.append('chunk', req.file.buffer, {
      filename: `chunk_${chunkIndex}.bin`,
      contentType: 'application/octet-stream',
    });

    const response = await axios.post(`${METADATA_URL}/api/chunks/upload`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000,
    });

    if (!response.data?.success) {
      throw new AppError(response.data?.error || 'Chunk upload failed at metadata service.', 500);
    }

    const chunkData = response.data.data;

    res.status(201).json({
      success: true,
      data: {
        chunkIndex: parseInt(chunkIndex, 10),
        chunkId: chunkData.chunkId,
        chunkHash: chunkData.chunkHash,
        status: chunkData.deduplicated ? 'DEDUPED' : 'STORED',
        deduplicated: chunkData.deduplicated || false,
        bytesSaved: chunkData.bytesSaved || 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/files/upload/complete
 * Finalize a resumable upload — verify all chunks present, mark file AVAILABLE.
 */
const completeUpload = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { fileId, chunkIVs } = req.body;

    if (!fileId) {
      throw new AppError('fileId is required.', 400);
    }

    const file = await File.findOne({ _id: fileId, userId, status: 'UPLOADING' });
    if (!file) {
      throw new AppError('Upload session not found or already completed.', 404);
    }

    // Verify all chunks are present
    const chunkMap = await chunkService.getChunkMap(fileId);
    if (chunkMap.length < file.totalChunks) {
      throw new AppError(
        `Upload incomplete. Expected ${file.totalChunks} chunks, found ${chunkMap.length}.`,
        400
      );
    }

    // Compute file-level hash from chunk hashes
    const hashConcat = chunkMap.map(c => c.chunkHash).join('');
    const fileHash = crypto.createHash('sha256').update(hashConcat).digest('hex');

    // Calculate dedup savings
    let dedupSavings = 0;
    // We can infer from chunk statuses or check metadata
    // For now, calculate from chunk responses stored during upload

    // Update file document
    file.status = 'AVAILABLE';
    file.sha256Hash = fileHash;
    if (chunkIVs && Array.isArray(chunkIVs)) {
      file.chunkIVs = chunkIVs;
    }
    await file.save();

    // Create initial version record
    await VersionHistory.create({
      fileId: file._id,
      versionNumber: 1,
      size: file.size,
      uploadedBy: userId,
      changeNote: 'Initial upload (chunked)',
      storagePath: file.storagePath,
      storageKey: file.storageKey,
      mimeType: file.mimeType,
      isCurrentVersion: true,
    });

    // Update user storage
    const user = await User.findById(userId);
    user.storageUsed += file.size;
    await user.save();

    // Invalidate caches
    await cache.invalidateFile(userId, file._id.toString(), file.folderId?.toString());

    res.json({
      success: true,
      data: {
        file: file.toSafeObject(),
        storageUsed: user.storageUsed,
        storageQuota: user.storageQuota,
        dedupSavings,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/files/upload/status/:fileId
 * Get upload progress — which chunks have been uploaded.
 */
const getUploadStatus = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, userId });
    if (!file) {
      throw new AppError('Upload session not found.', 404);
    }

    let uploadedChunks = [];
    try {
      const chunkMap = await chunkService.getChunkMap(fileId);
      uploadedChunks = chunkMap.map(c => c.chunkIndex);
    } catch {
      // No chunks yet
    }

    res.json({
      success: true,
      data: {
        fileId: file._id,
        filename: file.filename,
        status: file.status,
        totalChunks: file.totalChunks,
        uploadedChunks,
        uploadedCount: uploadedChunks.length,
        isComplete: uploadedChunks.length >= file.totalChunks,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { initUpload, uploadChunk, completeUpload, getUploadStatus };
