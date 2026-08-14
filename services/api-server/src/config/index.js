const dotenv = require('dotenv');
const path = require('path');

// Load .env from project root (two levels up from services/api-server/src/)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,

  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/minidrive',
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  },

  // Future: Redis, S3, internal secret
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
};

module.exports = config;
