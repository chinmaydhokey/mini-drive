const mongoose = require('mongoose');
const axios = require('axios');
const StorageNode = require('./models/StorageNode');
const config = require('./config');

// ── Configuration ────────────────────────────────────────────
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '10000', 10); // 10s
const OFFLINE_THRESHOLD = parseInt(process.env.OFFLINE_THRESHOLD || '30000', 10);   // 30s
const CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '15000', 10);  // 15s

let monitorTimer = null;
let isRunning = false;

/**
 * Health Monitor — periodically checks all registered storage nodes.
 * Marks nodes OFFLINE if they've missed heartbeats beyond threshold.
 */
async function checkNodes() {
  if (!isRunning) return;
  if (mongoose.connection.readyState !== 1) return;

  try {
    const nodes = await StorageNode.find({ status: { $ne: 'DRAINING' } });
    const now = Date.now();

    for (const node of nodes) {
      const timeSinceHeartbeat = now - new Date(node.lastHeartbeat).getTime();

      if (node.status === 'ONLINE' && timeSinceHeartbeat > OFFLINE_THRESHOLD) {
        // Node missed heartbeat — try an active health check
        try {
          const { data } = await axios.get(`${node.url}/health`, { timeout: 5000 });
          // Node responded — update heartbeat
          node.lastHeartbeat = new Date();
          node.chunkCount = data.chunkCount || node.chunkCount;
          node.usedBytes = data.usedBytes || node.usedBytes;
          await node.save();
          console.log(`💚 ${node.nodeId}: health check OK (heartbeat refreshed)`);
        } catch {
          // Node unreachable — mark OFFLINE
          node.status = 'OFFLINE';
          await node.save();
          console.warn(`🔴 ${node.nodeId}: OFFLINE (no heartbeat for ${Math.round(timeSinceHeartbeat / 1000)}s)`);
        }
      } else if (node.status === 'OFFLINE') {
        // Check if node came back
        try {
          await axios.get(`${node.url}/health`, { timeout: 5000 });
          node.status = 'ONLINE';
          node.lastHeartbeat = new Date();
          await node.save();
          console.log(`💚 ${node.nodeId}: back ONLINE`);
        } catch {
          // Still offline
        }
      }
    }
  } catch (err) {
    console.error('Health monitor error:', err.message);
  }
}

/**
 * Start the health monitor loop.
 */
function start() {
  if (isRunning) return;
  isRunning = true;
  console.log(`🏥 Health Monitor started (check every ${CHECK_INTERVAL / 1000}s, offline after ${OFFLINE_THRESHOLD / 1000}s)`);

  monitorTimer = setInterval(checkNodes, CHECK_INTERVAL);
  // Run immediately on start
  checkNodes();
}

/**
 * Stop the health monitor.
 */
function stop() {
  isRunning = false;
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  console.log('🏥 Health Monitor stopped');
}

/**
 * Get monitor status for health endpoint.
 */
function getStatus() {
  return {
    running: isRunning,
    checkIntervalMs: CHECK_INTERVAL,
    offlineThresholdMs: OFFLINE_THRESHOLD,
  };
}

module.exports = { start, stop, checkNodes, getStatus };
