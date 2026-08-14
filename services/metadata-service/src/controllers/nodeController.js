const axios = require('axios');
const StorageNode = require('../models/StorageNode');

/**
 * POST /api/nodes/register
 * Register or update a storage node.
 */
const registerNode = async (req, res) => {
  try {
    const { nodeId, url } = req.body;
    if (!nodeId || !url) {
      return res.status(400).json({ success: false, error: 'nodeId and url are required.' });
    }

    // Verify node is reachable
    let health;
    try {
      const { data } = await axios.get(`${url}/health`, { timeout: 5000 });
      health = data;
    } catch {
      return res.status(400).json({
        success: false,
        error: `Cannot reach storage node at ${url}. Make sure it's running.`,
      });
    }

    const node = await StorageNode.findOneAndUpdate(
      { nodeId },
      {
        url,
        status: 'ONLINE',
        lastHeartbeat: new Date(),
        chunkCount: health.chunkCount || 0,
        usedBytes: health.usedBytes || 0,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ success: true, data: { node } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/nodes
 * List all registered storage nodes with their status.
 */
const listNodes = async (req, res) => {
  try {
    const nodes = await StorageNode.find().sort({ nodeId: 1 }).select('-__v');
    res.json({
      success: true,
      data: {
        nodes,
        online: nodes.filter((n) => n.status === 'ONLINE').length,
        total: nodes.length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/nodes/:nodeId/heartbeat
 * Update node heartbeat and stats.
 */
const heartbeat = async (req, res) => {
  try {
    const node = await StorageNode.findOneAndUpdate(
      { nodeId: req.params.nodeId },
      {
        lastHeartbeat: new Date(),
        status: 'ONLINE',
        ...(req.body.chunkCount !== undefined ? { chunkCount: req.body.chunkCount } : {}),
        ...(req.body.usedBytes !== undefined ? { usedBytes: req.body.usedBytes } : {}),
      },
      { new: true }
    );

    if (!node) return res.status(404).json({ success: false, error: 'Node not found.' });

    res.json({ success: true, data: { nodeId: node.nodeId, status: node.status } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/nodes/:nodeId/drain
 * Gracefully drain a node — mark DRAINING, trigger re-replication of its chunks.
 */
const drainNode = async (req, res) => {
  try {
    const node = await StorageNode.findOne({ nodeId: req.params.nodeId });
    if (!node) return res.status(404).json({ success: false, error: 'Node not found.' });

    node.status = 'DRAINING';
    await node.save();

    // Mark all chunks on this node as DEGRADED to trigger re-replication
    const replicationWorker = require('../replicationWorker');
    const degradedCount = await replicationWorker.markNodeChunksDegraded(node.nodeId);

    res.json({
      success: true,
      data: {
        nodeId: node.nodeId,
        status: 'DRAINING',
        chunksToMigrate: degradedCount,
        message: `Node marked for drain. ${degradedCount} chunks will be re-replicated.`,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = { registerNode, listNodes, heartbeat, drainNode };
