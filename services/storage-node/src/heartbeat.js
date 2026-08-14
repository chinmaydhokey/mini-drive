const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const METADATA_URL = process.env.METADATA_URL || 'http://localhost:4000';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '10000', 10); // 10s

let timer = null;

function getTransport(urlStr) {
  return urlStr.startsWith('https') ? https : http;
}

function register(nodeId) {
  const nodePublicUrl = process.env.PUBLIC_URL || process.env.STORAGE_NODE_URL || `http://localhost:${process.env.PORT || 5001}`;
  const regBody = JSON.stringify({
    nodeId,
    url: nodePublicUrl,
  });

  const regUrl = new URL(`${METADATA_URL}/api/nodes/register`);
  const transport = getTransport(regUrl.href);
  const regOpts = {
    hostname: regUrl.hostname,
    port: regUrl.port || (regUrl.protocol === 'https:' ? 443 : 80),
    path: regUrl.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(regBody) },
    timeout: 5000,
  };

  const regReq = transport.request(regOpts, (res) => {
    res.resume();
    if (res.statusCode === 201) {
      console.log(`💚 Auto-registered with metadata service as ${nodeId} (${nodePublicUrl})`);
    }
  });
  regReq.on('error', () => {
    // Metadata service unreachable — quiet retry on next heartbeat
  });
  regReq.write(regBody);
  regReq.end();
}

/**
 * Send a heartbeat to the metadata service with current stats.
 * @param {string} nodeId - This storage node's ID
 * @param {string} dataDir - Path to the chunk data directory
 */
function sendHeartbeat(nodeId, dataDir) {
  // Gather local stats
  let chunkCount = 0;
  let usedBytes = 0;
  try {
    const files = fs.readdirSync(dataDir).filter((f) => !f.startsWith('tmp_'));
    chunkCount = files.length;
    for (const f of files) {
      usedBytes += fs.statSync(path.join(dataDir, f)).size;
    }
  } catch {}

  const body = JSON.stringify({ chunkCount, usedBytes });

  const url = new URL(`${METADATA_URL}/api/nodes/${nodeId}/heartbeat`);
  const transport = getTransport(url.href);
  const opts = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 5000,
  };

  const req = transport.request(opts, (res) => {
    // Consume response
    res.resume();
    if (res.statusCode === 200) {
      // Heartbeat acknowledged
    } else if (res.statusCode === 404) {
      // Node not found in metadata service — auto-register now
      register(nodeId);
    } else {
      console.warn(`⚠️  Heartbeat response: ${res.statusCode}`);
    }
  });

  req.on('error', () => {
    // Metadata service unreachable — log but don't crash
    // The node keeps running; metadata service will do active polling
  });

  req.write(body);
  req.end();
}

/**
 * Start periodic heartbeats.
 */
function start(nodeId, dataDir) {
  console.log(`💓 Heartbeat started → ${METADATA_URL} (every ${HEARTBEAT_INTERVAL / 1000}s)`);

  // Auto-register on startup
  register(nodeId);

  // Start periodic heartbeat
  sendHeartbeat(nodeId, dataDir);
  timer = setInterval(() => sendHeartbeat(nodeId, dataDir), HEARTBEAT_INTERVAL);
}

/**
 * Stop heartbeats.
 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, sendHeartbeat };
