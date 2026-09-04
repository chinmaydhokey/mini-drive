const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
const Chunk = require('../models/Chunk');
const StorageNode = require('../models/StorageNode');
const config = require('../config');

/**
 * Select N healthy storage nodes for replica placement.
 * Strategy: least-loaded first (by chunk count).
 */
async function selectNodes(count) {
  const nodes = await StorageNode.find({ status: 'ONLINE' })
    .sort({ chunkCount: 1 })
    .limit(count);

  if (nodes.length < count) {
    throw new Error(
      `Not enough online storage nodes. Need ${count}, have ${nodes.length}. ` +
      `Register more nodes via POST /api/nodes/register.`
    );
  }
  return nodes;
}

/**
 * POST /api/chunks/upload
 * Receives a chunk buffer, replicates to N storage nodes, records metadata.
 * Expects multipart: file field 'chunk', plus fields fileId, chunkIndex.
 */
const uploadChunk = async (req, res) => {
  try {
    const { fileId, chunkIndex } = req.body;
    if (!fileId || chunkIndex === undefined) {
      return res.status(400).json({ success: false, error: 'fileId and chunkIndex are required.' });
    }

    const chunkBuffer = req.file.buffer;
    const chunkSize = chunkBuffer.length;
    const chunkHash = req.body.chunkHash || crypto.createHash('sha256').update(chunkBuffer).digest('hex');

    // CAS Dedup: check if a chunk with this hash already exists
    const existingChunk = await Chunk.findOne({ chunkHash });
    if (existingChunk) {
      // Increment refCount — this chunk is shared
      existingChunk.refCount = (existingChunk.refCount || 1) + 1;
      await existingChunk.save();
      
      // Create a mapping record for this fileId+chunkIndex pointing to existing chunk
      // We create a new Chunk doc that references the same physical storage
      const mappedChunk = await Chunk.create({
        fileId,
        chunkIndex: parseInt(chunkIndex, 10),
        chunkSize: existingChunk.chunkSize,
        chunkHash,
        chunkId: existingChunk.chunkId, // same physical chunk
        replicas: existingChunk.replicas,
        status: existingChunk.status,
        s3Backed: existingChunk.s3Backed,
        s3BackedAt: existingChunk.s3BackedAt,
        refCount: 0, // not the primary owner
        isDedupRef: true, // marks this as a reference, not primary
      });
      
      return res.status(201).json({
        success: true,
        data: {
          chunkId: existingChunk.chunkId,
          chunkIndex: mappedChunk.chunkIndex,
          chunkSize: existingChunk.chunkSize,
          chunkHash,
          replicaCount: existingChunk.replicas.length,
          status: 'DEDUPED',
          deduplicated: true,
          bytesSaved: existingChunk.chunkSize,
        },
      });
    }

    const chunkId = `${fileId}_chunk_${chunkIndex}_${uuidv4().slice(0, 8)}`;

    // Select target nodes
    const replicationFactor = Math.min(config.replicationFactor,
      await StorageNode.countDocuments({ status: 'ONLINE' }));
    const targetNodes = await selectNodes(Math.max(replicationFactor, 1));

    // Replicate to each node
    const replicas = [];
    const failedNodes = [];

    for (const node of targetNodes) {
      try {
        const form = new FormData();
        // Create a fresh readable stream from buffer for each node
        const stream = Readable.from(chunkBuffer);
        form.append('chunk', stream, { filename: chunkId, contentType: 'application/octet-stream' });
        form.append('chunkId', chunkId);

        await axios.post(`${node.url}/chunks`, form, {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 30000,
        });

        replicas.push({
          nodeId: node.nodeId,
          nodeUrl: node.url,
          storedAt: new Date(),
          verified: true,
        });

        // Update node stats
        await StorageNode.updateOne(
          { _id: node._id },
          { $inc: { chunkCount: 1, usedBytes: chunkSize } }
        );
      } catch (err) {
        console.error(`Failed to replicate to ${node.nodeId}: ${err.message}`);
        failedNodes.push(node.nodeId);
      }
    }

    if (replicas.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'Failed to store chunk on any storage node.',
        failedNodes,
      });
    }

    // Create chunk metadata record
    const chunk = await Chunk.create({
      fileId,
      chunkIndex: parseInt(chunkIndex, 10),
      chunkSize,
      chunkHash,
      chunkId,
      replicas,
      status: replicas.length >= config.replicationFactor ? 'STORED' : 'DEGRADED',
    });

    res.status(201).json({
      success: true,
      data: {
        chunkId: chunk.chunkId,
        chunkIndex: chunk.chunkIndex,
        chunkSize: chunk.chunkSize,
        chunkHash: chunk.chunkHash,
        replicaCount: replicas.length,
        status: chunk.status,
        replicas: replicas.map((r) => ({ nodeId: r.nodeId })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/chunks/:fileId
 * Get the chunk map for a file — all chunks sorted by index with replica locations.
 */
const getChunkMap = async (req, res) => {
  try {
    const chunks = await Chunk.find({ fileId: req.params.fileId })
      .sort({ chunkIndex: 1 })
      .select('-__v');

    res.json({
      success: true,
      data: {
        fileId: req.params.fileId,
        totalChunks: chunks.length,
        chunks: chunks.map((c) => ({
          chunkId: c.chunkId,
          chunkIndex: c.chunkIndex,
          chunkSize: c.chunkSize,
          chunkHash: c.chunkHash,
          status: c.status,
          replicas: c.replicas.map((r) => ({
            nodeId: r.nodeId,
            nodeUrl: r.nodeUrl,
            verified: r.verified,
          })),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/chunks/:fileId/:chunkIndex/download
 * Download a specific chunk — tries replicas in order until one succeeds.
 */
const downloadChunk = async (req, res) => {
  try {
    const chunk = await Chunk.findOne({
      fileId: req.params.fileId,
      chunkIndex: parseInt(req.params.chunkIndex, 10),
    });

    if (!chunk) {
      return res.status(404).json({ success: false, error: 'Chunk not found.' });
    }

    // Try each replica until one works
    for (const replica of chunk.replicas) {
      try {
        const response = await axios.get(`${replica.nodeUrl}/chunks/${chunk.chunkId}`, {
          responseType: 'stream',
          timeout: 15000,
        });
        res.set({
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunk.chunkSize,
          'X-Chunk-Hash': chunk.chunkHash,
          'X-Source-Node': replica.nodeId,
        });
        response.data.pipe(res);
        return;
      } catch {
        console.warn(`Replica on ${replica.nodeId} failed, trying next...`);
      }
    }

    // Fallback: If all storage node replicas fail, retrieve chunk from AWS S3 cold tier
    if (chunk.s3Backed) {
      try {
        const s3ColdTier = require('../s3ColdTier');
        console.log(`☁️ Replicas unavailable. Retrieving chunk ${chunk.chunkId} from AWS S3 cold tier...`);
        const s3Buffer = await s3ColdTier.downloadFromS3(chunk.chunkId);
        if (s3Buffer) {
          res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': chunk.chunkSize,
            'X-Chunk-Hash': chunk.chunkHash,
            'X-Source-Node': 'AWS-S3-COLD-TIER',
          });
          res.send(s3Buffer);
          return;
        }
      } catch (s3Err) {
        console.error(`❌ S3 cold-tier recovery failed for chunk ${chunk.chunkId}: ${s3Err.message}`);
      }
    }

    res.status(500).json({ success: false, error: 'All storage node replicas and S3 recovery failed.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * DELETE /api/chunks/:fileId
 * Delete all chunks for a file from storage nodes, AWS S3 cold-tier, and metadata DB.
 */
const deleteChunks = async (req, res) => {
  const { fileId } = req.params;
  console.log(`[PERMANENT DELETE] Initiating chunk data cleanup for fileId: ${fileId}`);

  try {
    const s3ColdTier = require('../s3ColdTier');
    const chunks = await Chunk.find({ fileId });

    if (chunks.length === 0) {
      console.log(`[PERMANENT DELETE] No chunk metadata records found for fileId: ${fileId}`);
      return res.json({
        success: true,
        data: { fileId, deletedChunks: 0, deletedReplicas: 0, s3ObjectsDeleted: 0 },
      });
    }

    let deletedReplicas = 0;
    let s3ObjectsDeleted = 0;
    const errors = [];

    for (const chunk of chunks) {
      // 1. Delete chunk from all registered storage node replicas
      const otherRefsCount = await Chunk.countDocuments({ chunkId: chunk.chunkId, _id: { $ne: chunk._id } });
      if (otherRefsCount > 0) {
        console.log(`  🔗 [Dedup] Skipping physical deletion for chunk ${chunk.chunkId} (used by ${otherRefsCount} other files)`);
        await Chunk.updateOne({ chunkId: chunk.chunkId, isDedupRef: false }, { $inc: { refCount: -1 } });
        continue;
      }

      for (const replica of chunk.replicas) {
        try {
          await axios.delete(`${replica.nodeUrl}/chunks/${chunk.chunkId}`, { timeout: 5000 });
          deletedReplicas++;
          await StorageNode.updateOne(
            { nodeId: replica.nodeId },
            { $inc: { chunkCount: -1, usedBytes: -chunk.chunkSize } }
          );
          console.log(`  ✅ [Storage Node] Deleted chunk ${chunk.chunkId} from node ${replica.nodeId}`);
        } catch (err) {
          const warnMsg = `Failed to delete chunk ${chunk.chunkId} from node ${replica.nodeId}: ${err.message}`;
          console.warn(`  ⚠️ [Storage Node] ${warnMsg}`);
          errors.push(warnMsg);
        }
      }

      // 2. Delete chunk from AWS S3 Cold Tier
      try {
        const s3Success = await s3ColdTier.deleteFromS3(chunk.chunkId);
        if (s3Success) {
          s3ObjectsDeleted++;
          console.log(`  ☁️ [AWS S3] Deleted object s3://${chunk.chunkId}`);
        }
      } catch (s3Err) {
        const s3Warn = `Failed to delete S3 object for ${chunk.chunkId}: ${s3Err.message}`;
        console.warn(`  ⚠️ [AWS S3] ${s3Warn}`);
        errors.push(s3Warn);
      }
    }

    // 3. Delete Chunk metadata records from MongoDB after physical cleanup
    const deleteResult = await Chunk.deleteMany({ fileId });
    console.log(`[PERMANENT DELETE] Completed cleanup for fileId ${fileId}: ${deleteResult.deletedCount} chunks, ${deletedReplicas} node replicas, ${s3ObjectsDeleted} S3 objects deleted.`);

    res.json({
      success: true,
      data: {
        fileId,
        deletedChunks: deleteResult.deletedCount,
        deletedReplicas,
        s3ObjectsDeleted,
        errors,
      },
    });
  } catch (err) {
    console.error(`[PERMANENT DELETE FAILED] Error cleaning chunks for fileId ${fileId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/chunks/check-dedup
 * Check which chunk hashes already exist in the system.
 * Body: { hashes: ['sha256hash1', 'sha256hash2', ...] }
 * Returns: { existing: { 'sha256hash1': { chunkId, chunkSize }, ... }, missing: ['sha256hash3'] }
 */
const checkDedup = async (req, res) => {
  try {
    const { hashes } = req.body;
    if (!Array.isArray(hashes)) {
      return res.status(400).json({ success: false, error: 'hashes must be an array' });
    }
    
    const existing = {};
    const missing = [];
    
    const chunks = await Chunk.find({ chunkHash: { $in: hashes } }).select('chunkHash chunkId chunkSize replicas status s3Backed s3BackedAt');
    const hashMap = new Map();
    for (const c of chunks) {
      if (!hashMap.has(c.chunkHash)) {
        hashMap.set(c.chunkHash, c);
      }
    }
    
    for (const hash of hashes) {
      if (hashMap.has(hash)) {
        const c = hashMap.get(hash);
        existing[hash] = { chunkId: c.chunkId, chunkSize: c.chunkSize };
      } else {
        missing.push(hash);
      }
    }
    
    res.json({ success: true, data: { existing, missing } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = { uploadChunk, getChunkMap, downloadChunk, deleteChunks, checkDedup };
