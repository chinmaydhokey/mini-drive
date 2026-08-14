const mongoose = require('mongoose');
const config = require('./index');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(config.mongo.uri);
    console.log(`✅ MongoDB connected: ${conn.connection.host}:${conn.connection.port}/${conn.connection.name}`);
  } catch (error) {
    console.error(`❌ MongoDB connection error: ${error.message}`);
    process.exit(1);
  }
};

// Log connection events
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  console.error(`❌ MongoDB error: ${err.message}`);
});

module.exports = connectDB;
