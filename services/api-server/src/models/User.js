const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
    },
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username cannot exceed 30 characters'],
      match: [/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens'],
    },
    passwordHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    storageQuota: {
      type: Number,
      default: 5 * 1024 * 1024 * 1024, // 5 GB in bytes
    },
    storageUsed: {
      type: Number,
      default: 0,
    },
    profilePicUrl: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    refreshToken: {
      type: String,
      default: null,
    },

    // --- Extension points (future phases) ---
    encryptionPublicKey: { type: String, default: null },
    mfaSecret: { type: String, default: null },
    preferences: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true, // adds createdAt, updatedAt
  }
);

// ── Indexes ──────────────────────────────────────────────────
// email and username indexes are auto-created by { unique: true } on the schema field
userSchema.index({ role: 1 });

// ── Pre-save: hash password ──────────────────────────────────
// Only runs when password is being set/changed (not every save)
// Note: Mongoose 7+ async hooks don't receive `next` — just use async/await
userSchema.pre('save', async function () {
  if (!this.isModified('passwordHash')) return;
  this.passwordHash = await bcrypt.hash(this.passwordHash, SALT_ROUNDS);
});

// ── Instance method: verify password ─────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// ── Instance method: safe JSON (strip sensitive fields) ──────
userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.refreshToken;
  delete obj.mfaSecret;
  delete obj.__v;
  return obj;
};

const User = mongoose.model('User', userSchema);

module.exports = User;
