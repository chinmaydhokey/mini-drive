const mongoose = require('mongoose');
const crypto = require('crypto');

const shareLinkSchema = new mongoose.Schema(
  {
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
      required: false,
      default: null,
    },
    fileIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
    }],
    folderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Folder',
      default: null,
    },
    folderIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Folder',
    }],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // URL-safe random token — this IS the access credential
    token: {
      type: String,
      unique: true,
      required: true,
      default: () => crypto.randomBytes(32).toString('base64url'),
    },
    permission: {
      type: String,
      enum: ['VIEW', 'DOWNLOAD'],
      default: 'DOWNLOAD',
    },
    isPasswordProtected: {
      type: Boolean,
      default: false,
    },
    passwordHash: {
      type: String,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null, // null = never expires
    },
    maxDownloads: {
      type: Number,
      default: null, // null = unlimited
    },
    downloadCount: {
      type: Number,
      default: 0,
    },
    isRevoked: {
      type: Boolean,
      default: false,
    },
    // --- Extension points ---
    qrCodeUrl: { type: String, default: null },       // Phase 19: QR codes
    notifyOnAccess: { type: Boolean, default: false }, // Phase 18: email notifications
    recipientEmail: { type: String, default: null },   // Phase 18: email notifications
    // --- Private & Public Sharing (Phase C) ---
    shareType: {
      type: String,
      enum: ['PUBLIC', 'PRIVATE'],
      default: 'PUBLIC',
    },
    sharedWith: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      email: { type: String },
      permission: { type: String, enum: ['VIEW', 'DOWNLOAD'], default: 'VIEW' },
      addedAt: { type: Date, default: Date.now },
    }],
    resourceType: {
      type: String,
      enum: ['file', 'folder', 'batch'],
      default: 'file',
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ──────────────────────────────────────────────────
// token index auto-created by { unique: true } on the schema field
shareLinkSchema.index({ fileId: 1 });                   // all shares for a file
shareLinkSchema.index({ fileIds: 1 });                  // all batch shares containing a file
shareLinkSchema.index({ folderIds: 1 });                // all batch shares containing a folder
shareLinkSchema.index({ createdBy: 1 });                // user's shared links
shareLinkSchema.index({ 'sharedWith.userId': 1 });      // shared-with-me queries
shareLinkSchema.index({ expiresAt: 1 }, {               // TTL cleanup
  expireAfterSeconds: 7 * 24 * 60 * 60, // cleanup 7 days after expiry
  partialFilterExpression: { expiresAt: { $exists: true, $ne: null } },
});

shareLinkSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.__v;
  return obj;
};

/**
 * Check if this share link is currently valid for access.
 */
shareLinkSchema.methods.isAccessible = function () {
  if (this.isRevoked) return { valid: false, reason: 'This share link has been revoked.' };
  if (this.expiresAt && this.expiresAt < new Date()) return { valid: false, reason: 'This share link has expired.' };
  if (this.maxDownloads !== null && this.downloadCount >= this.maxDownloads) {
    return { valid: false, reason: 'Download limit reached for this share link.' };
  }
  return { valid: true };
};

const ShareLink = mongoose.model('ShareLink', shareLinkSchema);
module.exports = ShareLink;
