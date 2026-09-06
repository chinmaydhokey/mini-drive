const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const config = require('./config');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const { initRedis, getStatus: redisStatus } = require('./services/cacheService');
const { apiRateLimit, authRateLimit, uploadRateLimit } = require('./middleware/rateLimiter');
const reconciliationWorker = require('./services/reconciliationWorker');

// Route imports
const authRoutes = require('./routes/auth');
const fileRoutes = require('./routes/files');
const folderRoutes = require('./routes/folders');
const shareRoutes = require('./routes/shares');
const trashRoutes = require('./routes/trash');
const adminRoutes = require('./routes/admin');
const bulkRoutes = require('./routes/bulk');

// ── Initialize Express ───────────────────────────────────────
const app = express();

// ── Global Middleware ────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  frameguard: false, // Allow embedding in preview iframes on frontend origin
}));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      origin === config.cors.origin ||
      origin === 'http://localhost:5173' ||
      origin === 'http://localhost:3000' ||
      origin.endsWith('.onrender.com')
    ) {
      return callback(null, true);
    }
    return callback(null, origin);
  },
  credentials: true,                        // Allow cookies
}));
app.use(morgan('dev'));                      // Request logging
app.use(express.json({ limit: '10mb' }));   // JSON body parser
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());                     // Parse cookies (for refresh token)

// ── Rate Limiting ────────────────────────────────────────────
app.use('/api', apiRateLimit);              // 100 req/min for all API routes

// ── Health Check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'api-server',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    redis: redisStatus(),
    reconciliation: reconciliationWorker.getStats(),
  });
});

// ── API Routes ───────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/shares', shareRoutes);
app.use('/api/trash', trashRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/bulk', bulkRoutes);

// ── 404 Handler ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { message: `Route ${req.method} ${req.originalUrl} not found` },
  });
});

// ── Global Error Handler ─────────────────────────────────────
app.use(errorHandler);

// ── Start Server ─────────────────────────────────────────────
const startServer = async () => {
  await connectDB();
  initRedis(); // Non-blocking — app works without Redis
  reconciliationWorker.start(); // Start background replication retries

  const server = app.listen(config.port, () => {
    console.log(`\n🚀 API Server running in ${config.env} mode on port ${config.port}`);
    console.log(`   Health check: http://localhost:${config.port}/health`);
    console.log(`   Auth API:     http://localhost:${config.port}/api/auth\n`);
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    reconciliationWorker.stop();
    server.close(() => {
      console.log('👋 Server closed.');
      process.exit(0);
    });
    // Force exit after 10 seconds if connections don't close
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
