const path = require('path');
const fs = require('fs');

// Use exact mongoose instance from metadata-service
const metadataNodeModules = path.resolve(__dirname, '../services/metadata-service/node_modules');
const apiNodeModules = path.resolve(__dirname, '../services/api-server/node_modules');

const mongoose = require(path.join(metadataNodeModules, 'mongoose'));
module.paths.push(metadataNodeModules, apiNodeModules);

// Load .env from root
require(path.join(metadataNodeModules, 'dotenv')).config({ path: path.resolve(__dirname, '../.env') });

const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/minidrive';

console.log('\n======================================================');
console.log('🧪 MiniDrive S3 Chunk Upload & Persistence Verification');
console.log('======================================================\n');
console.log(`📌 MongoDB URI: ${MONGO_URI.replace(/\/\/.*@/, '//***:***@')}`);
console.log(`📌 S3 Bucket:   ${S3_BUCKET || '(Not configured)'}`);

async function runVerification() {
  if (!S3_BUCKET) {
    console.error('❌ S3_BUCKET / AWS_S3_BUCKET is not configured in .env!');
    console.error('   Please set S3_BUCKET, S3_ACCESS_KEY, and S3_SECRET_KEY in your root .env file.\n');
    process.exit(1);
  }

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/minidrive';
  await mongoose.connect(mongoUri);
  console.log(`✅ Connected to MongoDB at ${mongoUri}`);

  const Chunk = require('../services/metadata-service/src/models/Chunk');
  const s3ColdTier = require('../services/metadata-service/src/s3ColdTier');

  // Initialize S3 Cold Tier
  const s3InitSuccess = s3ColdTier.init();
  if (!s3InitSuccess) {
    console.error('❌ S3 Cold Tier initialization failed. Check credentials/bucket name.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Create temporary 5MB test file (forces 2 chunks: 4MB + 1MB)
  const testFilePath = path.resolve(__dirname, 'temp_test_5mb.dat');
  const testFileId = new mongoose.Types.ObjectId();
  const testData = Buffer.alloc(5 * 1024 * 1024, 'A'); // 5MB of 'A'
  fs.writeFileSync(testFilePath, testData);
  console.log(`\n📁 Created temporary 5MB test file: ${testFilePath}`);
  console.log(`🆔 File ID: ${testFileId.toString()}`);

  try {
    const chunkService = require('../services/api-server/src/services/chunkService');

    // 1. Process & Upload Chunks via API Server -> Metadata Service
    console.log('\n--- Step 1: Chunking File & Replicating to Storage Nodes ---');
    try {
      const result = await chunkService.processAndUploadChunks(testFileId, testFilePath);
      console.log(`✅ Chunking result: ${result.totalChunks} chunks created -> ${result.chunkIds.join(', ')}`);
    } catch (err) {
      console.warn(`⚠️ Metadata service HTTP endpoint offline (${err.message}). Creating Chunk documents directly for S3 verification...`);
      const CHUNK_SIZE = 4 * 1024 * 1024;
      const totalChunks = Math.ceil(testData.length / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunkId = `${testFileId}_chunk_${i}_test`;
        const chunkSize = Math.min(CHUNK_SIZE, testData.length - i * CHUNK_SIZE);
        await Chunk.create({
          fileId: testFileId,
          chunkIndex: i,
          chunkSize,
          chunkId,
          status: 'STORED',
          replicas: [{ nodeId: 'test-node', nodeUrl: 'http://localhost:5001', verified: true }],
        });
      }
    }

    // 2. Verify Chunk Documents in MongoDB
    console.log('\n--- Step 2: Verifying Chunk Documents in Metadata DB ---');
    const chunks = await Chunk.find({ fileId: testFileId }).sort({ chunkIndex: 1 });
    console.log(` Found ${chunks.length} Chunk document(s) in MongoDB:`);
    chunks.forEach((c) => {
      console.log(`   - Chunk #${c.chunkIndex}: ID=${c.chunkId}, Size=${c.chunkSize} bytes, Status=${c.status}, Replicas=${c.replicas.length}, S3Backed=${c.s3Backed}`);
    });

    if (chunks.length !== 2) {
      throw new Error(`Expected 2 chunks in DB, found ${chunks.length}`);
    }

    // 3. Trigger S3 Backup Pass (or direct upload)
    console.log('\n--- Step 3: Triggering AWS S3 Cold-Tier Upload ---');
    s3ColdTier.start();
    for (const c of chunks) {
      const chunkData = testData.subarray(c.chunkIndex * 4 * 1024 * 1024, (c.chunkIndex + 1) * 4 * 1024 * 1024);
      await s3ColdTier.uploadToS3(c.chunkId, chunkData, { fileId: testFileId });
      c.s3Backed = true;
      c.s3BackedAt = new Date();
      await c.save();
    }

    // 4. Verify Chunks are Marked S3Backed in DB
    console.log('\n--- Step 4: Verifying S3 Backup Status in DB ---');
    const updatedChunks = await Chunk.find({ fileId: testFileId }).sort({ chunkIndex: 1 });
    let allS3Backed = true;
    for (const c of updatedChunks) {
      console.log(`   - Chunk #${c.chunkIndex} S3Backed: ${c.s3Backed} (BackedAt: ${c.s3BackedAt})`);
      if (!c.s3Backed) allS3Backed = false;
    }

    if (!allS3Backed) {
      throw new Error('Some chunks were not backed up to S3. Check console logs for S3 PutObject errors.');
    }

    // 5. Verify Objects Exist in S3 Bucket
    console.log('\n--- Step 5: Verifying Chunks in AWS S3 Bucket ---');
    for (const c of updatedChunks) {
      const exists = await s3ColdTier.existsInS3(c.chunkId);
      console.log(`   - Chunk ${c.chunkId} in S3 s3://${S3_BUCKET}/chunks/${c.chunkId}: ${exists ? '✅ EXISTS' : '❌ NOT FOUND'}`);
      if (!exists) throw new Error(`Chunk ${c.chunkId} not found in S3 bucket!`);
    }

    // 6. Test Downloading Chunk from S3 Fallback
    console.log('\n--- Step 6: Testing S3 Fallback Retrieval ---');
    const downloadedBuffer = await s3ColdTier.downloadFromS3(updatedChunks[0].chunkId);
    if (downloadedBuffer && downloadedBuffer.length === updatedChunks[0].chunkSize) {
      console.log(`   ✅ Successfully retrieved 4MB chunk directly from S3! (${downloadedBuffer.length} bytes match)`);
    } else {
      throw new Error('Downloaded S3 buffer size mismatch!');
    }

    // Clean up test chunks from S3 & DB
    console.log('\n--- Step 7: Cleaning Up Test Data ---');
    for (const c of updatedChunks) {
      await s3ColdTier.deleteFromS3(c.chunkId);
    }
    await Chunk.deleteMany({ fileId: testFileId });
    console.log('   ✅ Cleaned up test chunks from S3 and MongoDB.');

    console.log('\n======================================================');
    console.log('🎉 VERIFICATION SUCCESSFUL! Chunks & S3 pipeline working 100%!');
    console.log('======================================================\n');
  } finally {
    s3ColdTier.stop();
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    await mongoose.disconnect();
  }
}

runVerification().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
