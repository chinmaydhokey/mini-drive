const path = require('path');
const fs = require('fs');

const envPaths = [
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../.env'),
];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    break;
  }
}

module.exports = {
  port: parseInt(process.env.METADATA_PORT || '4000', 10),
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/minidrive',
  replicationFactor: parseInt(process.env.REPLICATION_FACTOR || '3', 10),
  chunkSize: parseInt(process.env.CHUNK_SIZE || String(4 * 1024 * 1024), 10), // 4 MB
  storageNodes: JSON.parse(
    process.env.STORAGE_NODES ||
      '["http://localhost:5001","http://localhost:5002","http://localhost:5003"]'
  ),
};
