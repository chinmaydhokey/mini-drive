const mongoose = require('mongoose');

const versionHistorySchema = new mongoose.Schema(
  {
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
      required: true,
    },
    versionNumber: {
      type: Number,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    changeNote: {
      type: String,
      default: '',
      maxlength: 500,
    },
    // Local storage path for this version's data
    storagePath: {
      type: String,
      required: true,
    },
    storageKey: {
      type: String,
      required: true,
    },
    mimeType: {
      type: String,
      required: true,
    },
    isCurrentVersion: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ──────────────────────────────────────────────────
versionHistorySchema.index({ fileId: 1, versionNumber: -1 }); // latest first
versionHistorySchema.index({ fileId: 1, isCurrentVersion: 1 }); // quick current lookup

versionHistorySchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.storagePath;
  delete obj.storageKey;
  delete obj.__v;
  return obj;
};

const VersionHistory = mongoose.model('VersionHistory', versionHistorySchema);
module.exports = VersionHistory;
