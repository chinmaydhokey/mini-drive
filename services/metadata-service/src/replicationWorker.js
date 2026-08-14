const mongoose = require('mongoose');
const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
const Chunk = require('./models/Chunk');
const StorageNode = require('./models/StorageNode');
const config = require('./config');

// ── Configuration ────────────────────────────────────────────
const REPLICATION_INTERVAL = parseInt(process.env.REPLICATION_INTERVAL || '20000', 10); // 20s
const BATCH_SIZE = parseInt(process.env.REPLICATION_BATCH || '5', 10);

let workerTimer = null;
let isRunning = false;
let stats = { runs: 0, chunksRepaired: 0, chunksFailed: 0, lastRun: null };

/**
 * Re-replication Worker
 *
 * When a storage node goes offline, chunks stored only on that node
 * become DEGRADED. This worker:
 * 1. Finds DEGRADED chunks (replica count < replicationFactor)
 * 2. Downloads chunk data from a surviving replica
 * 3. Uploads to a new healthy node
 * 4. Updates the chunk metadata
 */
async function replicatePass() {
  if (!isRunning) return;
  if (mongoose.connection.readyState !== 1) return;

  try {
    stats.runs++;
    stats.lastRun = new Date();

    // Find chunks that need more replicas
    const degradedChunks = await Chunk.find({ status: 'DEGRADED' })
      .limit(BATCH_SIZE);

    if (degradedChunks.length === 0) return;

    console.log(`🔄 Re-replication: ${degradedChunks.length} degraded chunk(s) found`);

    // Get healthy nodes
    const onlineNodes = await StorageNode.find({ status: 'ONLINE' });

    for (const chunk of degradedChunks) {
      try {
        await repairChunk(chunk, onlineNodes);
        stats.chunksRepaired++;
      } catch (err) {
        console.error(`   ❌ Failed to repair chunk ${chunk.chunkId}: ${err.message}`);
        stats.chunksFailed++;

        // If no replicas remain, mark as LOST
        const liveReplicas = chunk.replicas.filter((r) =>
          onlineNodes.some((n) => n.nodeId === r.nodeId)
        );
        if (liveReplicas.length === 0) {
          chunk.status = 'LOST';
          await chunk.save();
          console.error(`   💀 Chunk ${chunk.chunkId} marked LOST — no surviving replicas`);
        }
      }
    }
  } catch (err) {
    console.error('Re-replication worker error:', err.message);
  }
}

/**
 * Repair a single degraded chunk:
 * 1. Find a live replica to read from
 * 2. Find a node that doesn't have this chunk yet
 * 3. Copy the chunk to the new node
 * 4. Update chunk metadata
 */
async function repairChunk(chunk, onlineNodes) {
  // Find nodes that currently hold this chunk
  const currentNodeIds = new Set(chunk.replicas.map((r) => r.nodeId));

  // Find a live replica to read from
  const sourceReplica = chunk.replicas.find((r) =>
    onlineNodes.some((n) => n.nodeId === r.nodeId)
  );

  if (!sourceReplica) {
    throw new Error('No live replica available to copy from');
  }

  // Find target nodes (online, don't already have this chunk)
  const targetNodes = onlineNodes.filter((n) => !currentNodeIds.has(n.nodeId));

  if (targetNodes.length === 0) {
    throw new Error('No available target nodes for re-replication');
  }

  // Calculate how many new replicas we need
  const liveReplicaCount = chunk.replicas.filter((r) =>
    onlineNodes.some((n) => n.nodeId === r.nodeId)
  ).length;
  const neededReplicas = config.replicationFactor - liveReplicaCount;

  if (neededReplicas <= 0) {
    // Already has enough live replicas — just update status
    chunk.status = 'STORED';
    // Remove dead replicas
    chunk.replicas = chunk.replicas.filter((r) =>
      onlineNodes.some((n) => n.nodeId === r.nodeId)
    );
    await chunk.save();
    console.log(`   ✅ Chunk ${chunk.chunkId}: cleaned dead replicas, status → STORED`);
    return;
  }

  // Sort targets by least-loaded
  targetNodes.sort((a, b) => a.chunkCount - b.chunkCount);

  const newReplicas = [];
  const targets = targetNodes.slice(0, neededReplicas);

  // Download chunk from source
  const { data: chunkData } = await axios.get(
    `${sourceReplica.nodeUrl}/chunks/${chunk.chunkId}`,
    { responseType: 'arraybuffer', timeout: 15000 }
  );

  // Upload to each target
  for (const target of targets) {
    try {
      const form = new FormData();
      const stream = Readable.from(Buffer.from(chunkData));
      form.append('chunk', stream, { filename: chunk.chunkId, contentType: 'application/octet-stream' });
      form.append('chunkId', chunk.chunkId);

      await axios.post(`${target.url}/chunks`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000,
      });

      newReplicas.push({
        nodeId: target.nodeId,
        nodeUrl: target.url,
        storedAt: new Date(),
        verified: true,
      });

      // Update node stats
      await StorageNode.updateOne(
        { _id: target._id },
        { $inc: { chunkCount: 1, usedBytes: chunk.chunkSize } }
      );

      console.log(`   ✅ Chunk ${chunk.chunkId}: replicated to ${target.nodeId}`);
    } catch (err) {
      console.warn(`   ⚠️  Failed to replicate to ${target.nodeId}: ${err.message}`);
    }
  }

  if (newReplicas.length > 0) {
    // Remove dead replicas and add new ones
    chunk.replicas = [
      ...chunk.replicas.filter((r) => onlineNodes.some((n) => n.nodeId === r.nodeId)),
      ...newReplicas,
    ];
    chunk.status = chunk.replicas.length >= config.replicationFactor ? 'STORED' : 'DEGRADED';
    await chunk.save();
  }
}

/**
 * Mark all chunks on a specific node as degraded.
 * Called when a node goes offline.
 */
async function markNodeChunksDegraded(nodeId) {
  const result = await Chunk.updateMany(
    { 'replicas.nodeId': nodeId, status: 'STORED' },
    { status: 'DEGRADED' }
  );
  if (result.modifiedCount > 0) {
    console.log(`⚠️  Marked ${result.modifiedCount} chunks as DEGRADED (node ${nodeId} offline)`);
  }
  return result.modifiedCount;
}

/**
 * Start the re-replication worker loop.
 */
function start() {
  if (isRunning) return;
  isRunning = true;
  console.log(`🔄 Re-replication Worker started (every ${REPLICATION_INTERVAL / 1000}s, batch ${BATCH_SIZE})`);
  workerTimer = setInterval(replicatePass, REPLICATION_INTERVAL);
}

/**
 * Stop the re-replication worker.
 */
function stop() {
  isRunning = false;
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  console.log('🔄 Re-replication Worker stopped');
}

/**
 * Get worker status for health endpoint.
 */
function getStatus() {
  return {
    running: isRunning,
    intervalMs: REPLICATION_INTERVAL,
    batchSize: BATCH_SIZE,
    ...stats,
  };
}

module.exports = { start, stop, replicatePass, markNodeChunksDegraded, getStatus };
