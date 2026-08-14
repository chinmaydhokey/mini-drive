const mongoose = require('mongoose');

const folderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'Folder name is required'],
      trim: true,
      maxlength: [255, 'Folder name cannot exceed 255 characters'],
    },
    parentFolderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Folder',
      default: null, // null = root level
    },
    // Materialized path: "/parentId/grandparentId/thisId"
    // Enables fast ancestor/descendant queries via prefix regex
    path: {
      type: String,
      default: '/',
    },
    depth: {
      type: Number,
      default: 0, // 0 = root level
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ──────────────────────────────────────────────────
folderSchema.index({ userId: 1, parentFolderId: 1 });  // list subfolders
folderSchema.index({ userId: 1, path: 1 });            // path-based lookups
folderSchema.index({ userId: 1, isDeleted: 1 });       // recycle bin

// ── Instance method: safe JSON ───────────────────────────────
folderSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

const Folder = mongoose.model('Folder', folderSchema);

module.exports = Folder;
