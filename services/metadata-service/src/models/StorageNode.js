const mongoose = require('mongoose');

const storageNodeSchema = new mongoose.Schema(
  {
    nodeId: {
      type: String,
      required: true,
      unique: true,
    },
    url: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['ONLINE', 'OFFLINE', 'DRAINING'],
      default: 'ONLINE',
    },
    lastHeartbeat: {
      type: Date,
      default: Date.now,
    },
    chunkCount: {
      type: Number,
      default: 0,
    },
    usedBytes: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

const StorageNode = mongoose.model('StorageNode', storageNodeSchema);
module.exports = StorageNode;
