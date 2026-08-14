const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    folderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Folder',
      default: null, // null = root directory
    },
    filename: {
      type: String,
      required: [true, 'Filename is required'],
      trim: true,
      maxlength: [255, 'Filename cannot exceed 255 characters'],
    },
    originalName: {
      type: String,
      required: true, // original name from user's machine
    },
    mimeType: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
      min: [0, 'File size cannot be negative'],
    },
    // Local storage path (Phase 2–5). In Phase 6+, replaced by chunk references.
    storagePath: {
      type: String,
      required: true,
    },
    // Unique storage key (UUID-based). Decouples internal path from user-facing name.
    storageKey: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['UPLOADING', 'AVAILABLE', 'FAILED', 'DELETED'],
      default: 'UPLOADING',
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    currentVersion: {
      type: Number,
      default: 1,
    },
    downloadCount: {
      type: Number,
      default: 0,
    },

    // --- Phase 6: Chunking fields (unused until then) ---
    totalChunks: { type: Number, default: 0 },

    // --- Extension points (future phases) ---
    sha256Hash: { type: String, default: null },      // Phase 14: dedup
    isEncrypted: { type: Boolean, default: false },    // Phase 21: E2E encryption
    compressionAlgo: { type: String, default: null },  // Phase 15: compression
    virusScanStatus: { type: String, default: null },  // Phase 20: virus scan
    tags: { type: [String], default: [] },             // future: tagging
  },
  {
    timestamps: true,
  }
);

// ── Indexes ──────────────────────────────────────────────────
fileSchema.index({ userId: 1, folderId: 1 });             // list files in folder
fileSchema.index({ userId: 1, isDeleted: 1 });             // recycle bin queries
fileSchema.index({ userId: 1, status: 1 });                // filter by status
fileSchema.index({ filename: 'text', tags: 'text' });      // full-text search
fileSchema.index({ sha256Hash: 1 });                       // future: dedup lookup
fileSchema.index({ deletedAt: 1 }, {
  expireAfterSeconds: 30 * 24 * 60 * 60, // auto-purge after 30 days (TTL index)
  partialFilterExpression: { isDeleted: true },
});

// ── Instance method: safe JSON ───────────────────────────────
fileSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.storagePath;  // don't expose internal storage path to client
  delete obj.storageKey;
  delete obj.__v;
  return obj;
};

// ── Static: format file size for display ─────────────────────
fileSchema.statics.formatSize = function (bytes) {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 Bytes';
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
};

const File = mongoose.model('File', fileSchema);

module.exports = File;
