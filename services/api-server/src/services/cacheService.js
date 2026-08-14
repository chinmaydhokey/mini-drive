const Redis = require('ioredis');
const config = require('../config');

// ── Redis Client ─────────────────────────────────────────────
let redis = null;
let isConnected = false;

/**
 * Initialize Redis connection. Fails gracefully — cache is optional.
 * The app works without Redis, just slower.
 */
function initRedis() {
  try {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) return null; // stop retrying after 5 attempts
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redis.on('connect', () => {
      isConnected = true;
      console.log('✅ Redis connected');
    });

    redis.on('error', (err) => {
      if (isConnected) console.warn('⚠️  Redis error:', err.message);
      isConnected = false;
    });

    redis.on('close', () => {
      isConnected = false;
    });

    redis.connect().catch(() => {
      console.warn('⚠️  Redis unavailable — running without cache');
    });
  } catch (err) {
    console.warn('⚠️  Redis init failed — running without cache:', err.message);
  }
}

// ── Cache Helpers (all fail-safe — return null on error) ─────

const TTL = {
  FILE_META: 300,       // 5 min — file metadata
  FOLDER_CONTENTS: 120, // 2 min — folder listings
  CHUNK_MAP: 600,       // 10 min — chunk locations (rarely change)
  STORAGE_STATS: 60,    // 1 min — storage dashboard
  USER_QUOTA: 30,       // 30 sec — quota (changes on upload)
};

/**
 * Get cached value. Returns parsed JSON or null.
 */
async function get(key) {
  if (!isConnected) return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

/**
 * Set cache value with TTL (in seconds).
 */
async function set(key, value, ttl) {
  if (!isConnected) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttl);
  } catch {}
}

/**
 * Delete a specific cache key.
 */
async function del(key) {
  if (!isConnected) return;
  try {
    await redis.del(key);
  } catch {}
}

/**
 * Delete all keys matching a pattern (e.g., 'file:userId:*').
 * Uses SCAN for production safety (never KEYS in prod).
 */
async function delPattern(pattern) {
  if (!isConnected) return;
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch {}
}

// ── Key Builders ─────────────────────────────────────────────

const keys = {
  fileMeta: (fileId) => `file:${fileId}`,
  folderContents: (userId, folderId) => `folder:${userId}:${folderId}`,
  chunkMap: (fileId) => `chunks:${fileId}`,
  storageStats: (userId) => `storage:${userId}`,
  userQuota: (userId) => `quota:${userId}`,
  rateLimit: (ip) => `rate:${ip}`,
  userFolders: (userId) => `folder:${userId}:*`,
  userFiles: (userId) => `file:${userId}:*`,
};

// ── Invalidation Helpers ─────────────────────────────────────

/**
 * Invalidate caches when a file is created/updated/deleted.
 */
async function invalidateFile(userId, fileId, folderId) {
  await Promise.all([
    del(keys.fileMeta(fileId)),
    del(keys.folderContents(userId, folderId || 'root')),
    del(keys.storageStats(userId)),
    del(keys.userQuota(userId)),
  ]);
}

/**
 * Invalidate folder-related caches.
 */
async function invalidateFolder(userId, folderId) {
  await Promise.all([
    del(keys.folderContents(userId, folderId || 'root')),
    del(keys.folderContents(userId, 'root')), // always invalidate root too
  ]);
}

// ── Cache-Through Pattern (for controllers) ──────────────────

/**
 * Get cached data or execute the fetch function and cache the result.
 */
async function cacheThrough(key, ttl, fetchFn) {
  const cached = await get(key);
  if (cached) return { data: cached, fromCache: true };

  const data = await fetchFn();
  await set(key, data, ttl);
  return { data, fromCache: false };
}

// ── Rate Limiter (sliding window) ────────────────────────────

/**
 * Check rate limit for an IP. Returns { allowed, remaining, resetIn }.
 * @param {string} ip - Client IP
 * @param {number} maxRequests - Max requests per window (default 100)
 * @param {number} windowSec - Window in seconds (default 60)
 */
async function checkRateLimit(ip, maxRequests = 100, windowSec = 60) {
  if (!isConnected) return { allowed: true, remaining: maxRequests, resetIn: 0 };

  const key = keys.rateLimit(ip);
  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSec);
    }

    const ttl = await redis.ttl(key);
    const remaining = Math.max(0, maxRequests - current);

    return {
      allowed: current <= maxRequests,
      remaining,
      resetIn: ttl > 0 ? ttl : windowSec,
      current,
    };
  } catch {
    return { allowed: true, remaining: maxRequests, resetIn: 0 };
  }
}

// ── Stats ────────────────────────────────────────────────────

function getStatus() {
  return {
    connected: isConnected,
    url: config.redis.url,
  };
}

module.exports = {
  initRedis,
  get, set, del, delPattern,
  keys, TTL,
  invalidateFile, invalidateFolder,
  cacheThrough,
  checkRateLimit,
  getStatus,
};
