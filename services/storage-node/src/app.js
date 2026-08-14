const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const PORT = parseInt(process.env.PORT || '5001', 10);
const NODE_ID = process.env.NODE_ID || 'node-1';
const DATA_DIR = path.resolve(__dirname, '../data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(morgan('short'));
app.use(express.json());

// ── Multer — write chunks directly to data dir ──────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DATA_DIR),
  filename: (req, file, cb) => {
    // Use chunkId from the body (set by metadata-service)
    // multer processes file before body, so we use a temp name and rename after
    const tempName = `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    req._tempChunkFile = tempName;
    cb(null, tempName);
  },
});
const upload = multer({ storage });

// ── POST /chunks — Store a chunk ─────────────────────────────
app.post('/chunks', upload.single('chunk'), (req, res) => {
  try {
    const chunkId = req.body.chunkId;
    if (!chunkId) {
      // Clean up temp file
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'chunkId is required' });
    }

    const finalPath = path.join(DATA_DIR, chunkId);

    // Rename temp file to chunkId
    fs.renameSync(req.file.path, finalPath);

    const stat = fs.statSync(finalPath);

    res.status(201).json({
      success: true,
      data: {
        chunkId,
        nodeId: NODE_ID,
        size: stat.size,
        storedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /chunks/:chunkId — Download a chunk ──────────────────
app.get('/chunks/:chunkId', (req, res) => {
  const chunkPath = path.join(DATA_DIR, req.params.chunkId);
  if (!fs.existsSync(chunkPath)) {
    return res.status(404).json({ success: false, error: 'Chunk not found' });
  }

  const stat = fs.statSync(chunkPath);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'X-Node-Id': NODE_ID,
  });
  fs.createReadStream(chunkPath).pipe(res);
});

// ── DELETE /chunks/:chunkId — Delete a chunk ─────────────────
app.delete('/chunks/:chunkId', (req, res) => {
  const chunkPath = path.join(DATA_DIR, req.params.chunkId);
  try {
    if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
    res.json({ success: true, data: { chunkId: req.params.chunkId, deleted: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /chunks — List all stored chunks ─────────────────────
app.get('/chunks', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter((f) => !f.startsWith('tmp_'));
    const chunks = files.map((f) => {
      const stat = fs.statSync(path.join(DATA_DIR, f));
      return { chunkId: f, size: stat.size };
    });
    res.json({ success: true, data: { nodeId: NODE_ID, chunks, count: chunks.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /health — Health check ───────────────────────────────
app.get('/health', (req, res) => {
  const files = fs.readdirSync(DATA_DIR).filter((f) => !f.startsWith('tmp_'));
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += fs.statSync(path.join(DATA_DIR, f)).size;
  }

  res.json({
    status: 'ok',
    nodeId: NODE_ID,
    port: PORT,
    chunkCount: files.length,
    usedBytes: totalBytes,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n📦 Storage Node [${NODE_ID}] running on port ${PORT}`);
  console.log(`   Data dir: ${DATA_DIR}`);
  console.log(`   Health:   http://localhost:${PORT}/health\n`);

  // Start heartbeat (auto-register + periodic stats)
  const heartbeat = require('./heartbeat');
  heartbeat.start(NODE_ID, DATA_DIR);
});

module.exports = app;
