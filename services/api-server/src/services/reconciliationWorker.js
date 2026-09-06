const fs = require('fs').promises;
const File = require('../models/File');
const chunkService = require('./chunkService');
const cache = require('./cacheService');

const INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS || '60000', 10);
const MAX_RETRIES = parseInt(process.env.RECONCILIATION_MAX_RETRIES || '5', 10);
const BATCH_SIZE = 10;
const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes
const FAILED_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours after user downloads local copy

let intervalHandle = null;
let isRunning = false;
let stats = { lastRun: null, processed: 0, succeeded: 0, failed: 0, totalRuns: 0 };

/**
 * Compute exponential backoff delay: min(60s * 2^attempts, 30min)
 */
function backoffDelay(attempts) {
  return Math.min(60000 * Math.pow(2, attempts), MAX_BACKOFF_MS);
}

/**
 * Process a single pending file: retry chunk replication.
 */
async function processFile(fileDoc) {
  const localPath = fileDoc.storagePath;

  // Verify local file still exists
  try {
    await fs.access(localPath);
  } catch {
    console.error(`❌ [Reconciliation] Local file missing for ${fileDoc._id}: ${localPath}`);
    fileDoc.status = 'FAILED';
    fileDoc.lastReplicationError = 'Local file no longer exists on disk.';
    await fileDoc.save();
    return { success: false, reason: 'local_missing' };
  }

  try {
    console.log(`🔄 [Reconciliation] Retrying replication for file ${fileDoc._id} (attempt ${fileDoc.replicationAttempts + 1}/${MAX_RETRIES})...`);

    const { totalChunks } = await chunkService.processAndUploadChunks(fileDoc._id, localPath);

    // Success — update file record
    fileDoc.totalChunks = totalChunks;
    fileDoc.status = 'AVAILABLE';
    fileDoc.storagePath = `chunked://${fileDoc.storageKey}`;
    fileDoc.lastReplicationError = null;
    fileDoc.nextReplicationRetry = null;
    await fileDoc.save();

    // Delete local file (graceful — may already be gone)
    try {
      await fs.unlink(localPath);
      console.log(`🗑️ [Reconciliation] Deleted local file: ${localPath}`);
    } catch (unlinkErr) {
      if (unlinkErr.code !== 'ENOENT') {
        console.warn(`⚠️ [Reconciliation] Could not delete local file ${localPath}: ${unlinkErr.message}`);
      }
    }

    // Invalidate caches
    try {
      await cache.invalidateFile(
        fileDoc.userId.toString(),
        fileDoc._id.toString(),
        fileDoc.folderId?.toString()
      );
    } catch {}

    console.log(`✅ [Reconciliation] File ${fileDoc._id} replicated successfully (${totalChunks} chunks).`);
    return { success: true };
  } catch (err) {
    // Failure — increment attempts, apply backoff
    fileDoc.replicationAttempts += 1;
    fileDoc.lastReplicationError = err.message;

    if (fileDoc.replicationAttempts >= MAX_RETRIES) {
      fileDoc.status = 'FAILED';
      console.error(`💀 [Reconciliation] File ${fileDoc._id} DEAD-LETTERED after ${MAX_RETRIES} attempts: ${err.message}`);
    } else {
      fileDoc.nextReplicationRetry = new Date(Date.now() + backoffDelay(fileDoc.replicationAttempts));
      console.warn(`⚠️ [Reconciliation] File ${fileDoc._id} attempt ${fileDoc.replicationAttempts} failed. Next retry at ${fileDoc.nextReplicationRetry.toISOString()}: ${err.message}`);
    }

    await fileDoc.save();
    return { success: false, reason: 'replication_error' };
  }
}

/**
 * Clean up local files for FAILED files that the user has downloaded > 24h ago.
 */
async function cleanupDownloadedFailedFiles() {
  try {
    const cutoff = new Date(Date.now() - FAILED_FILE_TTL_MS);
    const files = await File.find({
      status: 'FAILED',
      failedFileDownloadedAt: { $ne: null, $lte: cutoff },
    }).limit(BATCH_SIZE);

    for (const fileDoc of files) {
      const localPath = fileDoc.storagePath;
      if (localPath && !localPath.startsWith('chunked://')) {
        try {
          await fs.unlink(localPath);
          console.log(`🗑️ [Reconciliation] Cleaned up expired FAILED local file: ${localPath}`);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            console.warn(`⚠️ [Reconciliation] Could not clean up ${localPath}: ${err.message}`);
          }
        }
        fileDoc.storagePath = `expired://${fileDoc.storageKey}`;
        await fileDoc.save();
      }
    }
  } catch (err) {
    console.warn(`⚠️ [Reconciliation] Cleanup sweep error: ${err.message}`);
  }
}

/**
 * Main reconciliation loop — runs every INTERVAL_MS.
 */
async function runReconciliation() {
  if (isRunning) {
    console.log('⏳ [Reconciliation] Previous run still in progress, skipping...');
    return;
  }

  isRunning = true;
  stats.totalRuns++;
  stats.lastRun = new Date().toISOString();

  try {
    const pendingFiles = await File.find({
      status: 'PENDING_REPLICATION',
      replicationAttempts: { $lt: MAX_RETRIES },
      nextReplicationRetry: { $lte: new Date() },
    })
      .sort({ nextReplicationRetry: 1 })
      .limit(BATCH_SIZE);

    if (pendingFiles.length > 0) {
      console.log(`📋 [Reconciliation] Processing ${pendingFiles.length} pending file(s)...`);
    }

    for (const fileDoc of pendingFiles) {
      stats.processed++;
      const result = await processFile(fileDoc);
      if (result.success) {
        stats.succeeded++;
      } else {
        stats.failed++;
      }
    }

    // Also run cleanup sweep for downloaded FAILED files past 24h
    await cleanupDownloadedFailedFiles();
  } catch (err) {
    console.error(`❌ [Reconciliation] Unexpected error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the reconciliation worker.
 */
function start() {
  if (intervalHandle) return;
  console.log(`🔁 [Reconciliation] Worker started (interval: ${INTERVAL_MS}ms, maxRetries: ${MAX_RETRIES})`);
  // Run once immediately, then on interval
  setTimeout(runReconciliation, 5000); // slight delay to let server finish startup
  intervalHandle = setInterval(runReconciliation, INTERVAL_MS);
}

/**
 * Stop the reconciliation worker gracefully.
 */
function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('🛑 [Reconciliation] Worker stopped.');
  }
}

/**
 * Get worker stats for the health endpoint.
 */
function getStats() {
  return {
    running: !!intervalHandle,
    inProgress: isRunning,
    intervalMs: INTERVAL_MS,
    maxRetries: MAX_RETRIES,
    ...stats,
  };
}

module.exports = { start, stop, getStats };
