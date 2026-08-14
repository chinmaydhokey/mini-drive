#!/usr/bin/env node

/**
 * Orphan Scanner — Detects and optionally cleans up orphaned file data.
 *
 * Scans:
 *   1. uploads/ directory — files with no matching File DB record
 *   2. storage-node data dirs — chunk files with no matching Chunk DB record
 *
 * Usage:
 *   node scripts/scan-orphans.js              # Report only
 *   node scripts/scan-orphans.js --cleanup    # Report and delete orphans
 */

const path = require('path');
const fs = require('fs');

// ── Resolve project root ─────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');

// ── Load .env from project root ──────────────────────────────
require('dotenv').config({ path: path.join(ROOT, '.env') });

// ── Mongoose setup (resolve from api-server) ─────────────────
const mongoose = require(path.join(ROOT, 'services', 'api-server', 'node_modules', 'mongoose'));

// ── Models ───────────────────────────────────────────────────
const File = require(path.join(ROOT, 'services', 'api-server', 'src', 'models', 'File'));

// Chunk model from metadata-service
const chunkSchemaPath = path.join(ROOT, 'services', 'metadata-service', 'src', 'models', 'Chunk');
let Chunk;
try {
  Chunk = require(chunkSchemaPath);
} catch {
  // Build inline schema if import fails
  const chunkSchema = new mongoose.Schema({
    chunkId: String,
    fileId: mongoose.Schema.Types.ObjectId,
  });
  Chunk = mongoose.model('Chunk', chunkSchema);
}

// ── Config ───────────────────────────────────────────────────
const CLEANUP = process.argv.includes('--cleanup');
const UPLOADS_DIR = path.join(ROOT, 'services', 'api-server', 'uploads');
const STORAGE_NODES = [
  path.join(ROOT, 'services', 'storage-node', 'data', 'node-1'),
  path.join(ROOT, 'services', 'storage-node', 'data', 'node-2'),
  path.join(ROOT, 'services', 'storage-node', 'data', 'node-3'),
];
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/minidrive';

// ── Helpers ──────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

async function scanDirectory(dirPath) {
  const files = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(dirPath, entry.name);
        const stat = fs.statSync(fullPath);
        files.push({ name: entry.name, path: fullPath, size: stat.size });
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`  ⚠️ Cannot scan ${dirPath}: ${err.message}`);
    }
  }
  return files;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          MiniDrive Orphan Scanner                ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Mode: ${CLEANUP ? '🧹 CLEANUP (will delete orphans)' : '🔍 REPORT ONLY'}\n`);

  // Connect to MongoDB
  console.log(`Connecting to MongoDB: ${MONGO_URI.replace(/:([^@]+)@/, ':***@')}...`);
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const report = { uploads: [], storageNodes: [], totalOrphanBytes: 0 };

  // ── Scan 1: Uploads directory ──────────────────────────────
  console.log('━━━ Scan 1: Uploads Directory ━━━');
  console.log(`Scanning: ${UPLOADS_DIR}`);

  const uploadFiles = await scanDirectory(UPLOADS_DIR);
  console.log(`  Found ${uploadFiles.length} file(s) on disk`);

  if (uploadFiles.length > 0) {
    // Get all storagePaths from the File collection
    const dbFiles = await File.find({}, 'storagePath').lean();
    const dbPaths = new Set(dbFiles.map((f) => path.resolve(f.storagePath)));

    for (const file of uploadFiles) {
      const resolved = path.resolve(file.path);
      if (!dbPaths.has(resolved)) {
        report.uploads.push(file);
        report.totalOrphanBytes += file.size;
      }
    }

    console.log(`  🔴 ${report.uploads.length} orphaned file(s) found`);
    for (const orphan of report.uploads) {
      console.log(`     - ${orphan.name} (${formatBytes(orphan.size)})`);
      if (CLEANUP) {
        try {
          fs.unlinkSync(orphan.path);
          console.log(`       🗑️ Deleted`);
        } catch (err) {
          console.error(`       ❌ Failed to delete: ${err.message}`);
        }
      }
    }
  }

  // ── Scan 2: Storage node data directories ──────────────────
  console.log('\n━━━ Scan 2: Storage Node Data Directories ━━━');

  for (const nodeDir of STORAGE_NODES) {
    const nodeName = path.basename(nodeDir);
    console.log(`\n  Scanning: ${nodeDir} (${nodeName})`);

    const chunkFiles = await scanDirectory(nodeDir);
    console.log(`  Found ${chunkFiles.length} chunk file(s) on disk`);

    if (chunkFiles.length === 0) continue;

    // Get all chunkIds from the Chunk collection
    const chunkIds = chunkFiles.map((f) => f.name);
    const dbChunks = await Chunk.find(
      { chunkId: { $in: chunkIds } },
      'chunkId'
    ).lean();
    const dbChunkIds = new Set(dbChunks.map((c) => c.chunkId));

    const nodeOrphans = [];
    for (const file of chunkFiles) {
      if (!dbChunkIds.has(file.name)) {
        nodeOrphans.push(file);
        report.totalOrphanBytes += file.size;
      }
    }

    report.storageNodes.push({ node: nodeName, orphans: nodeOrphans });
    console.log(`  🔴 ${nodeOrphans.length} orphaned chunk(s) found`);

    for (const orphan of nodeOrphans) {
      console.log(`     - ${orphan.name} (${formatBytes(orphan.size)})`);
      if (CLEANUP) {
        try {
          fs.unlinkSync(orphan.path);
          console.log(`       🗑️ Deleted`);
        } catch (err) {
          console.error(`       ❌ Failed to delete: ${err.message}`);
        }
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────
  const totalOrphans =
    report.uploads.length +
    report.storageNodes.reduce((sum, n) => sum + n.orphans.length, 0);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║                  SCAN SUMMARY                    ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Orphaned uploads:       ${String(report.uploads.length).padStart(6)}`);
  for (const { node, orphans } of report.storageNodes) {
    console.log(`║  Orphaned chunks (${node}): ${String(orphans.length).padStart(6)}`);
  }
  console.log(`║  ────────────────────────────────────────────────`);
  console.log(`║  Total orphaned items:   ${String(totalOrphans).padStart(6)}`);
  console.log(`║  Total wasted space:     ${formatBytes(report.totalOrphanBytes).padStart(10)}`);
  console.log(`║  Action taken:           ${CLEANUP ? 'CLEANED UP' : 'NONE (add --cleanup)'}`);
  console.log('╚══════════════════════════════════════════════════╝');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
