# Distributed File Storage System — "Mini Google Drive"
## Part 3: Infrastructure, Security, Deployment & Extensibility

---

## 7. Load Balancing & Fault Tolerance

### 7.1 Nginx Configuration Approach

Nginx serves as both **reverse proxy** and **L7 load balancer**, sitting in front of all API server instances.

```nginx
upstream api_servers {
    least_conn;                    # Route to instance with fewest active connections
    server api-server-1:3000 max_fails=3 fail_timeout=30s weight=1;
    server api-server-2:3000 max_fails=3 fail_timeout=30s weight=1;
    server api-server-3:3000 max_fails=3 fail_timeout=30s weight=1;
}

upstream metadata_service {
    server metadata-service:4000;
    server metadata-service-standby:4000 backup;  # Hot standby
}

server {
    listen 443 ssl http2;
    server_name drive.example.com;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    client_max_body_size 5G;       # Support large file uploads
    proxy_request_buffering off;   # Stream uploads, don't buffer in Nginx

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;
    limit_req_zone $binary_remote_addr zone=upload:10m rate=5r/s;

    location /api/ {
        limit_req zone=api burst=50 nodelay;
        proxy_pass http://api_servers;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_next_upstream error timeout http_502 http_503;  # Auto-retry on failure
        proxy_next_upstream_tries 2;
        proxy_connect_timeout 5s;
        proxy_read_timeout 300s;   # Long timeout for large downloads
    }

    location /api/files/upload {
        limit_req zone=upload burst=10 nodelay;
        proxy_pass http://api_servers;
        proxy_read_timeout 600s;   # 10 min for large uploads
    }

    location /health {
        access_log off;
        return 200 'OK';
    }
}
```

**Key decisions**:
- `least_conn` over `round_robin`: Upload/download requests have vastly different durations. Least-connections prevents one instance from getting overloaded with several long-running uploads while others are idle.
- `proxy_request_buffering off`: Streams uploads directly to the API server without buffering the entire file in Nginx's memory. Critical for multi-GB files.
- `proxy_next_upstream`: If an API server returns 502/503 or times out, Nginx transparently retries on the next server — clients never see transient failures.

### 7.2 Health Check Mechanism

**Three-tier health checking:**

| Tier | What | How | Interval | Threshold |
|---|---|---|---|---|
| **Nginx → API Servers** | HTTP health | `GET /health` returns 200 | Built-in (`max_fails`) | 3 failures → remove from pool for 30s |
| **Metadata Service → Storage Nodes** | Heartbeat | Nodes push heartbeat every 5s | 5 seconds | 3 missed → mark DOWN |
| **Metadata Service → Self** | Liveness | Standby monitors primary via TCP | 3 seconds | 5 failures → standby promotes |

**Storage Node health probe** (active check, supplements passive heartbeats):
```javascript
// Metadata Service — active probe (runs if heartbeat is late)
async function probeNode(node) {
  try {
    const res = await axios.get(`http://${node.host}:${node.port}/internal/health`, { timeout: 3000 });
    return res.data.status === 'ok' && res.data.diskFreePercent > 5;
  } catch {
    return false;
  }
}
```

### 7.3 Retry & Circuit Breaker Logic

**API Server → Storage Node circuit breaker** (per-node):

```
States: CLOSED (normal) → OPEN (failing) → HALF-OPEN (testing)

CLOSED: All requests pass through.
  → If 5 failures in 30 seconds → switch to OPEN

OPEN: All requests immediately fail (skip this node, use replica).
  → After 15 seconds → switch to HALF-OPEN

HALF-OPEN: Allow 1 test request through.
  → If success → switch to CLOSED
  → If failure → switch back to OPEN (reset timer)
```

This prevents a slow/failing storage node from degrading every download that has a chunk on it. Instead, after 5 failures, the system immediately routes to replicas and only re-tests the node periodically.

### 7.4 Dead Node Recovery

```
Detection (15 sec) → Isolation → Re-replication → Recovery

1. Detection: 3 missed heartbeats (see workflow 6.4 in Part 2)
2. Isolation: Node removed from healthy_list cache, circuit breaker OPEN,
   Nginx marking equivalent for internal traffic
3. Re-replication: Priority queue processes under-replicated chunks
   (detailed in Part 1, Section 3.6)
4. Recovery: When node returns, inventory check → rejoin → gradual rebalance
```

---

## 8. Security Design

### 8.1 JWT Authentication Flow

```
┌────────┐         ┌───────────┐         ┌─────────┐
│ Client │         │ API Server│         │ MongoDB │
└───┬────┘         └─────┬─────┘         └────┬────┘
    │  POST /auth/login   │                    │
    │  {email, password}  │                    │
    │────────────────────>│                    │
    │                     │  Find user by email│
    │                     │───────────────────>│
    │                     │  { user doc }      │
    │                     │<───────────────────│
    │                     │                    │
    │                     │ bcrypt.compare(    │
    │                     │   password,        │
    │                     │   user.passwordHash│
    │                     │ )                  │
    │                     │                    │
    │  { accessToken,     │                    │
    │    refreshToken }   │                    │
    │<────────────────────│                    │
    │                     │                    │
    │  GET /api/files     │                    │
    │  Auth: Bearer <AT>  │                    │
    │────────────────────>│                    │
    │                     │ jwt.verify(AT,     │
    │                     │   ACCESS_SECRET)   │
    │                     │ → { userId, role } │
    │  { files: [...] }   │                    │
    │<────────────────────│                    │
```

**Token configuration**:

| Token | Secret | Expiry | Storage | Contains |
|---|---|---|---|---|
| Access Token | `ACCESS_TOKEN_SECRET` (env var) | 15 minutes | Client memory (not localStorage) | `{ userId, role, iat, exp }` |
| Refresh Token | `REFRESH_TOKEN_SECRET` (env var) | 7 days | HttpOnly secure cookie + hashed in DB | `{ userId, tokenVersion, iat, exp }` |

**Why short-lived access tokens?** If an access token leaks, the damage window is 15 minutes max. The refresh token is stored in an HttpOnly cookie (not accessible to JavaScript), preventing XSS theft.

**Token rotation**: Every refresh request issues both a new access token AND a new refresh token. The old refresh token is invalidated. This ensures a stolen refresh token can only be used once before detection (the real user's next refresh will fail, signaling compromise).

### 8.2 Bcrypt Usage

```javascript
const SALT_ROUNDS = 12; // ~250ms on modern hardware — slow enough to resist brute force

// Registration
const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

// Login
const isValid = await bcrypt.compare(submittedPassword, user.passwordHash);
```

12 rounds is chosen as the sweet spot: slow enough that brute-forcing is impractical (~4 hashes/second/core), fast enough that login doesn't feel sluggish to legitimate users.

### 8.3 Signed & Expiring Share URLs

Share URLs contain a token, **not** the fileId. This prevents enumeration attacks.

```
URL format: https://drive.example.com/share/{token}
Token: crypto.randomBytes(32).toString('base64url')  → 43 characters, 256 bits of entropy
```

**Security properties**:
- Token is unguessable (256-bit random)
- Indexed in MongoDB for O(1) lookup
- Optional password adds a second factor (bcrypt-hashed, same as user passwords)
- `expiresAt` enforced server-side — expired tokens are rejected even if the URL is bookmarked
- `maxDownloads` prevents unlimited redistribution
- `isRevoked` allows immediate link killing without waiting for expiry

### 8.4 Access Control on Files & Folders

```javascript
// Middleware: requireFileAccess
async function requireFileAccess(req, res, next) {
  const file = await File.findById(req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  // Owner always has access
  if (file.userId.equals(req.user.userId)) {
    req.file = file;
    return next();
  }

  // Admin override
  if (req.user.role === 'admin') {
    req.file = file;
    return next();
  }

  // Check share link (if accessing via share token)
  if (req.shareToken) {
    const share = await ShareLink.findOne({ token: req.shareToken, fileId: file._id });
    if (share && !share.isRevoked && share.expiresAt > new Date()) {
      req.file = file;
      req.sharePermission = share.permission;
      return next();
    }
  }

  // Future RBAC extension point: check role-based permissions here

  return res.status(403).json({ error: 'Access denied' });
}
```

**Defense in depth**:
- Input validation with `express-validator` on all endpoints
- Helmet.js for security headers (CSP, HSTS, X-Frame-Options)
- CORS restricted to frontend origin only
- Rate limiting per IP (Nginx) + per user (Redis) — prevents brute-force and abuse
- File type validation (both MIME type and magic bytes) — prevents disguised executables
- MongoDB injection prevention: Mongoose schemas with strict types, no raw query construction

---

## 9. Docker & Deployment Architecture

### 9.1 Container Breakdown

| Container | Image Base | Ports | Volumes | Replicas |
|---|---|---|---|---|
| `nginx` | `nginx:alpine` | 80, 443 | `./nginx/nginx.conf`, SSL certs | 1 (+ keepalived standby) |
| `api-server` | `node:20-alpine` | 3000 | — (stateless) | 2–3 |
| `metadata-service` | `node:20-alpine` | 4000 | — | 1 + 1 standby |
| `storage-node` | `node:20-alpine` | 5000 | `/data/chunks` (persistent volume) | 3+ |
| `mongodb` | `mongo:7` | 27017 | `/data/db` | 3 (replica set) |
| `redis` | `redis:7-alpine` | 6379 | `/data` (AOF persistence) | 1 + sentinel |
| `frontend` | `node:20-alpine` (build) → `nginx:alpine` (serve) | 80 | — | 1 (served by main Nginx) |

### 9.2 Docker Compose Layout

```yaml
version: '3.8'

services:
  nginx:
    image: nginx:alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
      - frontend-build:/usr/share/nginx/html:ro
    depends_on: [api-server-1, api-server-2]
    restart: always

  api-server-1:
    build: ./backend
    environment:
      - NODE_ENV=production
      - MONGO_URI=mongodb://mongo1:27017,mongo2:27017,mongo3:27017/minidrive?replicaSet=rs0
      - REDIS_URL=redis://redis:6379
      - JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}
      - JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
      - METADATA_SERVICE_URL=http://metadata-service:4000
      - AWS_S3_BUCKET=${S3_BUCKET}
      - AWS_ACCESS_KEY_ID=${AWS_KEY}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET}
    depends_on: [mongo1, redis, metadata-service]
    restart: always

  api-server-2:
    <<: *api-server-1  # YAML anchor (same config)

  metadata-service:
    build: ./metadata-service
    environment:
      - MONGO_URI=mongodb://mongo1:27017,mongo2:27017,mongo3:27017/minidrive?replicaSet=rs0
      - REDIS_URL=redis://redis:6379
      - INTERNAL_SECRET=${INTERNAL_SECRET}
    depends_on: [mongo1, redis]
    restart: always

  storage-node-a:
    build: ./storage-node
    environment:
      - NODE_ID=storage-node-a
      - RACK=rack-1
      - REGION=us-east-1
      - METADATA_URL=http://metadata-service:4000
      - INTERNAL_SECRET=${INTERNAL_SECRET}
    volumes:
      - storage-a-data:/data/chunks
    restart: always

  storage-node-b:
    build: ./storage-node
    environment:
      - NODE_ID=storage-node-b
      - RACK=rack-2
      - REGION=us-east-1
      - METADATA_URL=http://metadata-service:4000
      - INTERNAL_SECRET=${INTERNAL_SECRET}
    volumes:
      - storage-b-data:/data/chunks
    restart: always

  storage-node-c:
    build: ./storage-node
    environment:
      - NODE_ID=storage-node-c
      - RACK=rack-1
      - REGION=us-east-1
      - METADATA_URL=http://metadata-service:4000
      - INTERNAL_SECRET=${INTERNAL_SECRET}
    volumes:
      - storage-c-data:/data/chunks
    restart: always

  mongo1:
    image: mongo:7
    command: mongod --replSet rs0 --bind_ip_all
    volumes: [mongo1-data:/data/db]
  mongo2:
    image: mongo:7
    command: mongod --replSet rs0 --bind_ip_all
    volumes: [mongo2-data:/data/db]
  mongo3:
    image: mongo:7
    command: mongod --replSet rs0 --bind_ip_all
    volumes: [mongo3-data:/data/db]

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    volumes: [redis-data:/data]

  frontend:
    build: ./frontend
    volumes: [frontend-build:/app/build]

volumes:
  mongo1-data:
  mongo2-data:
  mongo3-data:
  redis-data:
  storage-a-data:
  storage-b-data:
  storage-c-data:
  frontend-build:
```

### 9.3 EC2/Azure VM Deployment Topology

```
Production: 3 VMs minimum (can scale to 5+)

VM 1 — "Gateway + App" (t3.large / Standard_B2ms)
  ├── Nginx (Docker)
  ├── API Server × 2 (Docker)
  ├── Metadata Service (Docker)
  └── Redis (Docker)

VM 2 — "Database" (r6g.large / Standard_E2s_v3 — memory-optimized)
  ├── MongoDB Primary (Docker)
  ├── MongoDB Secondary (Docker)
  └── MongoDB Arbiter (Docker, lightweight)

VM 3 — "Storage" (i3.xlarge / Standard_L8s_v2 — storage-optimized)
  ├── Storage Node A (Docker, 500 GB NVMe)
  ├── Storage Node B (Docker, 500 GB NVMe)
  └── Storage Node C (Docker, 500 GB NVMe)

Scaling path:
  → Add VM 4: More storage nodes (when disk fills)
  → Add VM 5: Separate Redis + more API servers (when traffic grows)
  → Split MongoDB to dedicated VMs per replica member
  → Add VM 6: Dedicated Metadata Service (when chunk count exceeds 10M)
```

**Why co-locate storage nodes on one VM initially?** For a portfolio/early-stage project, running 3 "virtual" storage nodes on one machine demonstrates the architecture without the cost of 3 separate VMs. Each storage node uses a separate Docker volume, simulating independent disks. When scaling, you simply move each storage node container to its own VM — no code changes needed.

---

## 10. Extensibility — Future Features

Each subsection describes **where** the feature plugs into the current architecture, **what** schema/API changes it requires, and **why** the current design already accommodates it.

### 10.1 File Deduplication via SHA-256

**Where it plugs in**: Upload pipeline, between file receipt and chunk storage (step 2–3 of upload workflow).

**How it works**: Before storing, compute SHA-256 of the full file. Query `files` collection on the `sha256Hash` index. If a match exists with status `AVAILABLE`, skip storage — create a new File document pointing to the existing chunks (reference counting).

**Schema already prepared**: `files.sha256Hash` field + index exists. **New**: Add `refCount: Number` to chunks collection to track how many files reference each chunk. Permanent delete must decrement refCount and only delete chunk data when it hits 0.

**API change**: None externally. Internal upload logic adds a dedup check step.

### 10.2 End-to-End Encryption

**Where it plugs in**: Client-side (before upload) and client-side (after download). The server never sees plaintext.

**How it works**: Client generates AES-256 key per file, encrypts file before chunking, stores encrypted chunks. The encryption key is encrypted with the user's public key and stored alongside the file.

**Schema already prepared**: `users.encryptionPublicKey`, `files.isEncrypted`. **New**: Add `files.encryptedKey: String` (the per-file key, encrypted with user's public key). Share flow needs key re-encryption with recipient's public key.

**API change**: Add `GET /api/auth/me/publicKey` and `PUT /api/auth/me/publicKey`. Upload/download endpoints remain the same (they handle opaque bytes).

### 10.3 Role-Based Access Control (RBAC)

**Where it plugs in**: Auth middleware, between JWT verification and route handler execution.

**How it works**: Expand `users.role` from `"user" | "admin"` to a reference to a roles collection. Middleware checks `requiredPermissions` against the user's role's permissions array.

**Schema already prepared**: `users.role` field exists. **New**: Add `roles` collection: `{ _id, name, permissions: ["file:read", "file:write", "admin:users", ...] }`. Add `files.sharedWith: [{ userId, permission }]` for user-level file sharing (beyond link sharing).

**API change**: Add `POST /api/admin/roles`, `GET /api/admin/roles`, `PATCH /api/admin/roles/:id`. Modify admin middleware to check granular permissions.

### 10.4 File Compression Before Upload

**Where it plugs in**: Upload pipeline, after file receipt but before chunking (between steps 1 and 3 of upload workflow).

**How it works**: API server (or client) compresses file with gzip/zstd before chunking. `files.compressionAlgo` records the algorithm. On download, decompress after reassembly.

**Schema already prepared**: `files.compressionAlgo` field exists. **New**: Add `files.originalSize: Number` (pre-compression) alongside existing `size` (post-compression, actual storage used).

**API change**: Add optional `compress: true` flag to upload init request. Download response includes `X-Original-Size` header for progress accuracy.

### 10.5 Real-Time Upload Progress via WebSockets

**Where it plugs in**: API Server, emitting events during the upload workflow steps 5–7.

**How it works**: Client opens WebSocket connection to `/ws/upload/:uploadId`. As each chunk is received and stored, the API server emits progress events through the WebSocket. Redis Pub/Sub bridges events if the WebSocket and upload handler are on different API server instances.

**Schema change**: None. **Infrastructure**: Add `ws` (or `socket.io`) to API server dependencies. Use Redis Pub/Sub channel `upload:progress:{uploadId}` for cross-instance events.

**API change**: Add WebSocket endpoint `ws://drive.example.com/ws/upload/:uploadId`. Events: `{ type: "chunk_received", chunkIndex, progress: 0.33 }`, `{ type: "complete" }`, `{ type: "error" }`.

### 10.6 Virus Scanning Before Storage

**Where it plugs in**: Upload pipeline, between chunk storage and status transition to `AVAILABLE` (between steps 7 and 9 of upload workflow).

**How it works**: After chunks are written, file status is set to `SCANNING` instead of `AVAILABLE`. A virus scan worker (ClamAV in a Docker container) picks up the file, scans it. Clean files → `AVAILABLE`. Infected files → `QUARANTINED`, chunks are isolated, user is notified.

**Schema already prepared**: `files.virusScanStatus` field exists. **New**: Add `quarantine` status to `files.status` enum. Add a `scanResults` collection for detailed scan reports.

**API change**: Add `GET /api/files/:id/scan-status`. Modify upload response to include `scanStatus: "pending"`. Add admin endpoint `GET /api/admin/quarantined`.

### 10.7 Audit Logs

**Where it plugs in**: Express middleware (after route handler, before response) and critical business logic points.

**How it works**: An `auditLog()` middleware/helper captures: who, what, when, where (IP), and the resource affected. Writes to the `auditLogs` collection (schema already defined in Part 1, Section 2.8).

**Schema already prepared**: Full `auditLogs` collection schema with indexes. **No new schema needed.**

**Events to log**: `LOGIN`, `LOGOUT`, `LOGIN_FAILED`, `FILE_UPLOAD`, `FILE_DOWNLOAD`, `FILE_DELETE`, `FILE_RESTORE`, `SHARE_CREATE`, `SHARE_REVOKE`, `SHARE_ACCESS`, `FOLDER_CREATE`, `FOLDER_DELETE`, `ADMIN_USER_UPDATE`, `NODE_DOWN`, `NODE_RECOVERED`.

**API change**: Add `GET /api/admin/audit-logs` with filters: `userId`, `action`, `resourceType`, `dateRange`. Add `GET /api/files/:id/activity` for per-file audit trail.

### 10.8 Email Notifications for Shared Files

**Where it plugs in**: Share creation workflow (step 2–3 of sharing workflow), triggered after ShareLink document is saved.

**How it works**: Add optional `recipientEmail` field to share creation request. After creating the share link, push a job to a notification queue (Redis/Bull queue). A notification worker picks it up and sends email via SendGrid/SES with the share URL.

**Schema change**: Add `shareLinks.recipientEmail: String` (optional). Add `shareLinks.notifyOnAccess: Boolean`. **New**: Add `notificationQueue` (managed by Bull/BullMQ, backed by Redis).

**API change**: Extend `POST /api/shares` request body with optional `recipientEmail` and `notifyOnAccess` fields.

### 10.9 QR Code for File Sharing

**Where it plugs in**: After share link creation, as an optional add-on to the share response.

**How it works**: When creating a share link, optionally generate a QR code image encoding the share URL. Use a library like `qrcode` (npm). Store the generated image as a static asset (or encode as data URI). Return QR code URL in share creation response.

**Schema already prepared**: `shareLinks.qrCodeUrl` field exists. **No additional schema.**

**API change**: Add optional `generateQr: true` flag to `POST /api/shares`. Add `GET /api/shares/:shareId/qr` to retrieve/regenerate QR code image.

### 10.10 Expiring Share Links — Cleanup Job

**Where it plugs in**: Background job scheduler (node-cron or Bull repeatable job).

**Current design already supports** `expiresAt` field and server-side expiry enforcement. This extension adds proactive cleanup to prevent database bloat.

**How it works**:
```javascript
// Runs every hour
cron.schedule('0 * * * *', async () => {
  // Delete expired + fully consumed share links older than 7 days
  const result = await ShareLink.deleteMany({
    $or: [
      { expiresAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      { isRevoked: true, updatedAt: { $lt: sevenDaysAgo } }
    ]
  });
  logger.info(`Cleaned up ${result.deletedCount} expired share links`);
});
```

**Schema change**: None — `expiresAt` TTL index already defined. MongoDB's native TTL indexes can handle auto-deletion, but the cron job approach gives more control (e.g., 7-day grace period after expiry, audit logging of deletions).

**API change**: Add `GET /api/admin/shares/expired` for admin visibility into cleanup candidates.

---

## Summary of Extension Points in Current Design

| Future Feature | Schema Fields Already Present | Middleware Hook | Service Boundary |
|---|---|---|---|
| Deduplication | `files.sha256Hash` + index | Upload pipeline (pre-chunk) | API Server |
| E2E Encryption | `users.encryptionPublicKey`, `files.isEncrypted` | Client-side + upload/download | Client + API Server |
| RBAC | `users.role` | Auth middleware | API Server |
| Compression | `files.compressionAlgo` | Upload pipeline (pre-chunk) | API Server |
| WebSocket Progress | — | Upload handler events | API Server + Redis Pub/Sub |
| Virus Scanning | `files.virusScanStatus` | Upload pipeline (post-store) | New: Scan Worker container |
| Audit Logs | Full `auditLogs` collection | Express middleware | API Server |
| Email Notifications | `shareLinks.notifyOnAccess` | Share creation handler | New: Notification Worker |
| QR Codes | `shareLinks.qrCodeUrl` | Share creation handler | API Server |
| Expiring Link Cleanup | `shareLinks.expiresAt` (TTL index) | Cron job | API Server / Background Worker |
