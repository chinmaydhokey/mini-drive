const mongoose = require('mongoose');

const replicaSchema = new mongoose.Schema({
  nodeId: { type: String, required: true },
  nodeUrl: { type: String, required: true },
  storedAt: { type: Date, default: Date.now },
  verified: { type: Boolean, default: true },
}, { _id: false });

const chunkSchema = new mongoose.Schema(
  {
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
      required: true,
    },
    chunkIndex: {
      type: Number,
      required: true,
    },
    chunkSize: {
      type: Number,
      required: true,
    },
    chunkHash: {
      type: String, // SHA-256 of chunk data for integrity verification
      default: null,
    },
    chunkId: {
      type: String, // Unique ID used as filename on storage nodes
      required: true,
    },
    refCount: { type: Number, default: 1 },
    isDedupRef: { type: Boolean, default: false },
    replicas: [replicaSchema],
    status: {
      type: String,
      enum: ['STORED', 'DEGRADED', 'LOST'],
      default: 'STORED',
    },
    s3Backed: {
      type: Boolean,
      default: false,
    },
    s3BackedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────
chunkSchema.index({ fileId: 1, chunkIndex: 1 }, { unique: true });
chunkSchema.index({ status: 1 });
chunkSchema.index({ 'replicas.nodeId': 1 });
chunkSchema.index({ chunkHash: 1 });
chunkSchema.index({ chunkId: 1 });

const Chunk = mongoose.model('Chunk', chunkSchema);
module.exports = Chunk;
