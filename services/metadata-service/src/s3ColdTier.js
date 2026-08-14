/**
 * S3 Cold-Tier Service
 *
 * Provides async backup of chunks to S3 and recovery when local replicas
 * are exhausted. Works as a "cold tier" — chunks are always served from
 * local storage nodes first, and S3 is the last-resort fallback.
 *
 * Env vars:
 *   S3_BUCKET       — Bucket name (required to enable S3)
 *   S3_REGION       — AWS region (default: us-east-1)
 *   S3_ENDPOINT     — Custom endpoint (for MinIO/LocalStack)
 *   S3_ACCESS_KEY   — AWS access key
 *   S3_SECRET_KEY   — AWS secret key
 *   S3_PREFIX       — Key prefix in bucket (default: chunks/)
 *   S3_BACKUP_INTERVAL — Ms between backup runs (default: 60000)
 */

let S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand;
try {
  ({ S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
} catch (e) {
  // @aws-sdk/client-s3 not installed
}

const mongoose = require('mongoose');
const Chunk = require('./models/Chunk');
const axios = require('axios');
const { Readable } = require('stream');

let s3Client = null;
let activeConfig = { bucket: '', prefix: 'chunks/', backupInterval: 60000, batchSize: 10 };
let workerTimer = null;
let isRunning = false;
let stats = { runs: 0, chunksBackedUp: 0, chunksFailed: 0, lastRun: null };

/**
 * Initialize the S3 client. Returns false if S3 is not configured.
 */
function init() {
  // Ensure dotenv is loaded from root .env
  const path = require('path');
  const fs = require('fs');
  const envPaths = [
    path.resolve(__dirname, '../../../.env'),
    path.resolve(__dirname, '../../.env'),
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      require('dotenv').config({ path: p });
      break;
    }
  }

  const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET;
  const S3_REGION = process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1';
  const S3_PREFIX = process.env.S3_PREFIX || 'chunks/';
  const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
  const S3_SECRET_KEY = process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const BACKUP_INTERVAL = parseInt(process.env.S3_BACKUP_INTERVAL || '60000', 10);
  const BATCH_SIZE = parseInt(process.env.S3_BACKUP_BATCH || '10', 10);

  if (!S3_BUCKET) {
    console.log('ℹ️  S3 cold-tier disabled (S3_BUCKET / AWS_S3_BUCKET not set)');
    return false;
  }

  if (!S3Client) {
    console.log('⚠️  S3 cold-tier disabled (@aws-sdk/client-s3 module not installed)');
    return false;
  }

  activeConfig = {
    bucket: S3_BUCKET,
    prefix: S3_PREFIX,
    backupInterval: BACKUP_INTERVAL,
    batchSize: BATCH_SIZE,
  };
  const config = { region: S3_REGION };

  // Custom endpoint (MinIO, LocalStack)
  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
    config.forcePathStyle = true; // Required for MinIO
  }

  // Explicit credentials (optional — falls back to IAM role / env)
  if (S3_ACCESS_KEY && S3_SECRET_KEY) {
    config.credentials = {
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
    };
  }

  s3Client = new S3Client(config);
  console.log(`☁️  S3 cold-tier enabled: s3://${activeConfig.bucket}/${activeConfig.prefix}*`);
  return true;
}

/**
 * Get the S3 key for a chunk.
 */
function chunkKey(chunkId) {
  return `${activeConfig.prefix}${chunkId}`;
}

/**
 * Upload a chunk buffer to S3.
 */
async function uploadToS3(chunkId, buffer, metadata = {}) {
  if (!s3Client) {
    console.warn(`⚠️ S3 upload skipped for ${chunkId}: S3 client not initialized.`);
    return false;
  }

  try {
    const key = chunkKey(chunkId);
    const resp = await s3Client.send(new PutObjectCommand({
      Bucket: activeConfig.bucket,
      Key: key,
      Body: buffer,
      ContentType: 'application/octet-stream',
      Metadata: {
        chunkId,
        fileId: String(metadata.fileId || ''),
        uploadedAt: new Date().toISOString(),
      },
    }));

    console.log(`   ☁️ AWS S3 PutObject SUCCESS -> s3://${activeConfig.bucket}/${key} (ETag: ${resp.ETag})`);
    return true;
  } catch (err) {
    console.error(`   ❌ AWS S3 PutObject FAILED for chunk ${chunkId} [Code: ${err.name || err.code}]: ${err.message}`);
    throw err;
  }
}

/**
 * Download a chunk from S3. Returns a Buffer.
 */
async function downloadFromS3(chunkId) {
  if (!s3Client) return null;

  try {
    const key = chunkKey(chunkId);
    const resp = await s3Client.send(new GetObjectCommand({
      Bucket: activeConfig.bucket,
      Key: key,
    }));

    // Convert readable stream to buffer
    const chunks = [];
    for await (const chunk of resp.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    console.log(`   ☁️ AWS S3 GetObject SUCCESS -> s3://${activeConfig.bucket}/${key} (${buffer.length} bytes)`);
    return buffer;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.warn(`⚠️ Chunk ${chunkId} not found in S3 (404 / NoSuchKey).`);
      return null;
    }
    console.error(`❌ AWS S3 GetObject FAILED for chunk ${chunkId} [Code: ${err.name || err.code}]: ${err.message}`);
    throw err;
  }
}

/**
 * Check if a chunk exists in S3.
 */
async function existsInS3(chunkId) {
  if (!s3Client) return false;

  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: activeConfig.bucket,
      Key: chunkKey(chunkId),
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a chunk from S3.
 */
async function deleteFromS3(chunkId) {
  if (!s3Client) return false;

  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: activeConfig.bucket,
      Key: chunkKey(chunkId),
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Background worker: backup STORED chunks that aren't yet in S3.
 */
async function backupPass() {
  if (!isRunning || !s3Client) return;
  if (mongoose.connection.readyState !== 1) return; // Wait for MongoDB connection

  try {
    stats.runs++;
    stats.lastRun = new Date();

    // Find chunks that are STORED or DEGRADED but not backed up to S3
    const chunks = await Chunk.find({ status: { $in: ['STORED', 'DEGRADED'] }, s3Backed: { $ne: true } })
      .limit(activeConfig.batchSize);

    if (chunks.length === 0) return;

    console.log(`☁️  S3 backup: ${chunks.length} chunk(s) to upload`);

    for (const chunk of chunks) {
      try {
        // Download from a live replica
        const sourceReplica = chunk.replicas[0];
        if (!sourceReplica) continue;

        const { data } = await axios.get(
          `${sourceReplica.nodeUrl}/chunks/${chunk.chunkId}`,
          { responseType: 'arraybuffer', timeout: 15000 }
        );

        // Upload to S3
        await uploadToS3(chunk.chunkId, Buffer.from(data), { fileId: chunk.fileId });

        // Mark as backed up
        chunk.s3Backed = true;
        chunk.s3BackedAt = new Date();
        await chunk.save();

        stats.chunksBackedUp++;
        console.log(`   ☁️  ${chunk.chunkId} → S3 ✓`);
      } catch (err) {
        stats.chunksFailed++;
        console.warn(`   ❌ ${chunk.chunkId} S3 backup failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('S3 backup worker error:', err.message);
  }
}

/**
 * Start the S3 backup worker.
 */
function start() {
  if (!init()) return; // S3 not configured
  if (isRunning) return;

  isRunning = true;
  console.log(`☁️  S3 backup worker started (every ${activeConfig.backupInterval / 1000}s, batch ${activeConfig.batchSize})`);
  workerTimer = setInterval(backupPass, activeConfig.backupInterval);
}

/**
 * Stop the S3 backup worker.
 */
function stop() {
  isRunning = false;
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

/**
 * Get worker status.
 */
function getStatus() {
  return {
    enabled: !!activeConfig.bucket,
    running: isRunning,
    bucket: activeConfig.bucket || null,
    ...stats,
  };
}

module.exports = { init, start, stop, uploadToS3, downloadFromS3, deleteFromS3, existsInS3, getStatus, backupPass };
