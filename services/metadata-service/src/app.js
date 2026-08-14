const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');

const chunkRoutes = require('./routes/chunks');
const nodeRoutes = require('./routes/nodes');
const healthMonitor = require('./healthMonitor');
const replicationWorker = require('./replicationWorker');
const s3ColdTier = require('./s3ColdTier');

const app = express();

app.use(cors());
app.use(morgan('short'));
app.use(express.json());

// ── Routes ───────────────────────────────────────────────────
app.use('/api/chunks', chunkRoutes);
app.use('/api/nodes', nodeRoutes);

// ── Health Check (enhanced) ──────────────────────────────────
app.get('/health', async (req, res) => {
  const Chunk = require('./models/Chunk');
  const StorageNode = require('./models/StorageNode');

  const [totalChunks, degradedChunks, lostChunks, s3BackedChunks, nodesOnline, totalNodes] = await Promise.all([
    Chunk.countDocuments(),
    Chunk.countDocuments({ status: 'DEGRADED' }),
    Chunk.countDocuments({ status: 'LOST' }),
    Chunk.countDocuments({ s3Backed: true }),
    StorageNode.countDocuments({ status: 'ONLINE' }),
    StorageNode.countDocuments(),
  ]);

  res.json({
    status: degradedChunks > 0 ? 'degraded' : lostChunks > 0 ? 'critical' : 'ok',
    service: 'metadata-service',
    totalChunks,
    degradedChunks,
    lostChunks,
    s3BackedChunks,
    nodesOnline,
    totalNodes,
    replicationFactor: config.replicationFactor,
    chunkSize: config.chunkSize,
    uptime: process.uptime(),
    healthMonitor: healthMonitor.getStatus(),
    replicationWorker: replicationWorker.getStatus(),
    s3ColdTier: s3ColdTier.getStatus(),
  });
});

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.originalUrl} not found` });
});

// ── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status || 500).json({ success: false, error: err.message });
});

// ── Start ────────────────────────────────────────────────────
const start = async () => {
  await mongoose.connect(config.mongoUri);
  console.log(`✅ MongoDB connected: ${mongoose.connection.host}`);

  app.listen(config.port, () => {
    console.log(`\n🧠 Metadata Service running on port ${config.port}`);
    console.log(`   Chunk size: ${config.chunkSize / 1024 / 1024} MB`);
    console.log(`   Replication: ${config.replicationFactor}×`);
    console.log(`   Health: http://localhost:${config.port}/health\n`);

    // Start background workers
    healthMonitor.start();
    replicationWorker.start();
    s3ColdTier.start();
  });
};

// ── Graceful Shutdown ────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  healthMonitor.stop();
  replicationWorker.stop();
  s3ColdTier.stop();
  mongoose.connection.close();
  process.exit(0);
});

start().catch((err) => {
  console.error('Failed to start metadata service:', err);
  process.exit(1);
});

module.exports = app;

