const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const AppError = require('../utils/AppError');

const METADATA_URL = process.env.METADATA_URL || 'http://localhost:4000';
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || String(4 * 1024 * 1024), 10); // 4 MB default

/**
 * Split a local file into 4MB chunks and upload each chunk to the Metadata Service.
 * Metadata service replicates each chunk to storage nodes and triggers S3 cold-tier backup.
 *
 * @param {string} fileId - MongoDB _id of the File document
 * @param {string} filePath - Path to local file on disk
 * @returns {Promise<{ totalChunks: number, chunkIds: string[] }>}
 */
async function processAndUploadChunks(fileId, filePath) {
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;

  if (fileSize === 0) {
    return { totalChunks: 0, chunkIds: [] };
  }

  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const chunkIds = [];

  console.log(`📦 Chunking file ${fileId} (${fileSize} bytes) into ${totalChunks} chunk(s) of size ${CHUNK_SIZE} bytes...`);

  const fileHandle = await fs.promises.open(filePath, 'r');

  try {
    for (let index = 0; index < totalChunks; index++) {
      const start = index * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      const chunkSize = end - start;

      const buffer = Buffer.alloc(chunkSize);
      await fileHandle.read(buffer, 0, chunkSize, start);

      const form = new FormData();
      form.append('fileId', fileId.toString());
      form.append('chunkIndex', index.toString());
      form.append('chunk', buffer, {
        filename: `chunk_${index}.bin`,
        contentType: 'application/octet-stream',
      });

      console.log(`Uploading chunk ${index + 1}/${totalChunks} (${chunkSize} bytes) to Metadata Service...`);

      try {
        const response = await axios.post(`${METADATA_URL}/api/chunks/upload`, form, {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 60000,
        });

        if (response.data?.success) {
          chunkIds.push(response.data.data.chunkId);
          console.log(`   ✅ Chunk ${index + 1}/${totalChunks} uploaded & replicated -> chunkId: ${response.data.data.chunkId}`);
        } else {
          throw new Error(response.data?.error || 'Metadata service returned failure');
        }
      } catch (err) {
        const errMsg = err.response?.data?.error || err.message;
        console.error(`   ❌ Failed to upload chunk ${index} for file ${fileId}: ${errMsg}`);
        throw new AppError(`Chunk upload failed at part ${index + 1}/${totalChunks}: ${errMsg}`, 500);
      }
    }
  } finally {
    await fileHandle.close().catch(() => {});
  }

  return { totalChunks, chunkIds };
}

/**
 * Fetch the chunk map for a file from the Metadata Service.
 * @param {string} fileId
 * @returns {Promise<Array<{ chunkId: string, chunkIndex: number, chunkSize: number, replicas: Array }>>}
 */
async function getChunkMap(fileId) {
  try {
    const response = await axios.get(`${METADATA_URL}/api/chunks/${fileId}`, { timeout: 10000 });
    if (response.data?.success) {
      return response.data.data.chunks;
    }
    throw new Error(response.data?.error || 'Failed to fetch chunk map');
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error(`❌ Error fetching chunk map for file ${fileId}: ${errMsg}`);
    throw new AppError(`Metadata service error: ${errMsg}`, 500);
  }
}

/**
 * Download a specific chunk stream from the Metadata Service.
 * @param {string} fileId
 * @param {number} chunkIndex
 * @returns {Promise<import('stream').Readable>}
 */
async function getChunkStream(fileId, chunkIndex) {
  try {
    const response = await axios.get(`${METADATA_URL}/api/chunks/${fileId}/${chunkIndex}/download`, {
      responseType: 'stream',
      timeout: 30000,
    });
    return response.data;
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error(`❌ Error downloading chunk ${chunkIndex} for file ${fileId}: ${errMsg}`);
    throw new AppError(`Failed to retrieve chunk ${chunkIndex}: ${errMsg}`, 500);
  }
}

/**
 * Delete all chunks for a file from Metadata Service and Storage Nodes.
 * @param {string} fileId
 */
async function deleteChunks(fileId) {
  try {
    await axios.delete(`${METADATA_URL}/api/chunks/${fileId}`, { timeout: 10000 });
    console.log(`🗑️ Deleted all chunks for file ${fileId} from metadata service`);
  } catch (err) {
    console.warn(`⚠️ Failed to delete chunks for file ${fileId}: ${err.message}`);
  }
}

/**
 * Check which chunk hashes already exist in the metadata service (for CAS dedup).
 * @param {string[]} hashes - Array of SHA-256 hex strings
 * @returns {Promise<{ existing: Object, missing: string[] }>}
 */
async function checkDedup(hashes) {
  try {
    const response = await axios.post(`${METADATA_URL}/api/chunks/check-dedup`, { hashes }, { timeout: 10000 });
    if (response.data?.success) {
      return response.data.data;
    }
    throw new Error(response.data?.error || 'Failed to check dedup');
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error(`❌ Error checking dedup: ${errMsg}`);
    throw new AppError(`Dedup check failed: ${errMsg}`, 500);
  }
}

module.exports = {
  processAndUploadChunks,
  getChunkMap,
  getChunkStream,
  deleteChunks,
  checkDedup,
  CHUNK_SIZE,
};
