# Distributed File Storage System — "Mini Google Drive"
## Part 1: Architecture, Schema & Replication

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            CLIENTS                                      │
│                  React.js SPA  /  REST API consumers                    │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ HTTPS
                           ▼
                ┌─────────────────────┐
                │   Nginx (L7 LB)     │  ← TLS termination, rate limiting
                │   + API Gateway     │     round-robin / least-conn
                └────┬───────────┬────┘
                     │           │
          ┌──────────▼──┐  ┌────▼──────────┐
          │ API Server  │  │  API Server   │   ← N stateless Express.js
          │  (Node 1)   │  │  (Node 2)     │      instances behind LB
          └──┬──┬──┬────┘  └──┬──┬──┬──────┘
             │  │  │          │  │  │
     ┌───────┘  │  └────┐    │  │  │
     ▼          ▼       ▼    ▼  ▼  ▼
┌────────┐ ┌────────┐ ┌──────────────┐
│ MongoDB│ │ Redis  │ │  Metadata    │  ← Metadata Service tracks chunk
│ (RS)   │ │ Cache  │ │  Service     │    locations, node health, replicas
└────────┘ └────────┘ └──────┬───────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Storage  │  │ Storage  │  │ Storage  │   ← Distributed chunk
        │ Node A   │  │ Node B   │  │ Node C   │     storage (local disk
        │ (+ S3)   │  │ (+ S3)   │  │ (+ S3)   │     + S3 cold tier)
        └──────────┘  └──────────┘  └──────────┘
```

### Component Responsibilities

| Component | Role | Scaling |
|---|---|---|
| **Nginx** | TLS termination, L7 load balancing, rate limiting, static asset serving | Active-passive pair |
| **API Server** (Express.js) | Auth, business logic, REST endpoints, orchestrates uploads/downloads | Horizontal (add instances) |
| **Metadata Service** | Tracks chunk→node mappings, replica status, node health, triggers re-replication | Single-leader + hot standby |
| **MongoDB** (Replica Set) | Persistent store for users, files, folders, chunks, share links, versions | 3-node replica set |
| **Redis** | Session cache, metadata cache, rate-limit counters, pub/sub for events | Sentinel for HA |
| **Storage Nodes** | Store actual file chunks on local disk; async-replicate to S3 cold tier | Horizontal (add nodes) |
| **AWS S3** | Durable cold/archive tier; disaster recovery backup of all chunks | Managed, infinite scale |

### Why This Separation?

- **Metadata vs. Storage split**: The classic GFS/HDFS pattern. Metadata is small and hot (cached in Redis); chunk data is large and distributed. Separating them lets each scale independently.
- **Stateless API servers**: Any instance can handle any request — Nginx round-robins freely. JWT auth means no server-side sessions.
- **S3 as durability backstop**: Local storage nodes provide low-latency reads; S3 provides 11-nines durability as a safety net.

---

### 1.1 Upload Request Flow

```
1. Client → Nginx → API Server: POST /api/files/upload (multipart, JWT in header)
2. API Server: Validates JWT, checks storage quota
3. API Server: Splits file into chunks (64 MB default)
4. API Server → Metadata Service: "Allocate chunks for file X, N chunks"
5. Metadata Service: Selects target nodes per chunk (rack-aware, load-balanced)
   Returns chunk allocation map: { chunk_0: [NodeA, NodeC], chunk_1: [NodeB, NodeA], ... }
6. API Server → Storage Nodes: Streams each chunk to primary node
7. Primary Storage Node: Writes to local disk, ACKs API Server
8. Primary Storage Node → Replica Nodes: Async replicates chunk (pipeline)
9. API Server → Metadata Service: Confirms chunk writes, updates file status to "AVAILABLE"
10. API Server → MongoDB: Creates File document, Chunk documents, Version record
11. API Server → Client: 200 OK { fileId, url, version }
```

**Key decision — Step 6/7/8**: The API server waits only for the primary write ACK before responding to the client (step 7). Replication to secondary nodes happens asynchronously (step 8). This gives fast upload response times at the cost of a brief window where only one copy exists. The Metadata Service marks replicas as `PENDING` until confirmed, and the health monitor ensures re-replication if the primary dies before replication completes.

### 1.2 Download Request Flow

```
1. Client → Nginx → API Server: GET /api/files/:id/download (JWT in header)
2. API Server: Validates JWT + ownership/share permissions
3. API Server → Redis: Check cached chunk-map for this file
4. If cache miss → Metadata Service: Get chunk locations for file
5. Metadata Service returns: { chunk_0: [NodeA(healthy), NodeC(healthy)], ... }
6. API Server: For each chunk, selects nearest/least-loaded healthy node
7. API Server → Storage Nodes: Streams chunks in order
8. API Server → Client: Pipes reassembled file as download stream
9. If a node fails mid-stream → retry that chunk from replica node (transparent to client)
```

**Key decision — Step 6**: Node selection uses a scoring formula: `score = 0.4 * (1 - loadPct) + 0.3 * latency_score + 0.3 * locality_score`. This balances load distribution with proximity. The fallback path (step 9) makes downloads resilient without client awareness.

---

## 2. Database Schema (MongoDB)

### Why MongoDB Over SQL?

| Concern | MongoDB Advantage |
|---|---|
| **Schema flexibility** | File metadata varies wildly (images have EXIF, docs have page counts). Schemaless documents avoid ALTER TABLE migrations. |
| **Hierarchical data** | Folder trees map naturally to `materialized path` patterns in documents. No recursive CTEs needed. |
| **Chunk/replica tracking** | Embedded arrays of replica locations in chunk documents — single read gets everything. In SQL this is 3 JOINs. |
| **Horizontal scaling** | Native sharding on `userId` distributes data as user base grows. |
| **JSON-native** | Node.js/Express work with JSON natively. No ORM impedance mismatch. |

**Trade-off acknowledged**: MongoDB's eventual consistency in replica sets means a brief window where reads after writes might hit a secondary. For this system, that's acceptable — file metadata is written once and rarely updated. For critical paths (auth, quota checks), we read from the primary.

---

### 2.1 Users Collection

```javascript
// Collection: users
// Shard key: _id
{
  _id: ObjectId,
  email: String,              // unique
  username: String,           // unique
  passwordHash: String,       // bcrypt, 12 rounds
  role: String,               // "user" | "admin" — RBAC extension point
  storageQuota: Number,       // bytes, default 5 GB
  storageUsed: Number,        // bytes, updated on upload/delete
  profilePicUrl: String,      // optional
  isActive: Boolean,          // soft-disable accounts
  refreshToken: String,       // hashed, for JWT refresh flow
  // --- Extension points ---
  encryptionPublicKey: String, // future: E2E encryption
  mfaSecret: String,          // future: 2FA
  preferences: Object,        // future: notification settings, theme, etc.
  createdAt: Date,
  updatedAt: Date
}

// Indexes:
// { email: 1 }               — unique, login lookup
// { username: 1 }            — unique, profile lookup
// { role: 1 }                — admin queries
```

### 2.2 Files Collection

```javascript
// Collection: files
// Shard key: { userId: 1, _id: 1 }
{
  _id: ObjectId,
  userId: ObjectId,           // ref → users
  folderId: ObjectId,         // ref → folders (null = root)
  filename: String,
  mimeType: String,
  size: Number,               // bytes (original file)
  totalChunks: Number,
  status: String,             // "UPLOADING" | "AVAILABLE" | "FAILED" | "DELETED"
  isDeleted: Boolean,         // soft delete (recycle bin)
  deletedAt: Date,            // for auto-purge after 30 days
  currentVersion: Number,     // latest version number
  // --- Extension points ---
  sha256Hash: String,         // future: deduplication
  isEncrypted: Boolean,       // future: E2E encryption
  compressionAlgo: String,    // future: "gzip" | "zstd" | null
  virusScanStatus: String,    // future: "pending" | "clean" | "quarantined"
  tags: [String],             // future: tagging/categorization
  createdAt: Date,
  updatedAt: Date
}

// Indexes:
// { userId: 1, folderId: 1 }           — list files in folder
// { userId: 1, isDeleted: 1 }          — recycle bin queries
// { filename: "text", tags: "text" }   — full-text search
// { status: 1 }                        — admin: find stuck uploads
// { sha256Hash: 1 }                    — future: dedup lookup
// { deletedAt: 1 }                     — TTL index candidate for auto-purge
```

### 2.3 Folders Collection

```javascript
// Collection: folders
{
  _id: ObjectId,
  userId: ObjectId,           // ref → users
  name: String,
  parentFolderId: ObjectId,   // null = root
  path: String,               // materialized path: "/root/documents/work"
  depth: Number,              // 0 = root, for query optimization
  isDeleted: Boolean,
  deletedAt: Date,
  createdAt: Date,
  updatedAt: Date
}

// Indexes:
// { userId: 1, parentFolderId: 1 }  — list subfolders
// { userId: 1, path: 1 }           — unique, path-based navigation
// { userId: 1, isDeleted: 1 }      — recycle bin
```

**Materialized path** rationale: Querying all ancestors or all descendants becomes a simple regex/prefix match on the `path` field (`/^\/root\/documents/`). This avoids recursive lookups and is well-suited to MongoDB's indexing.

### 2.4 Chunks Collection

```javascript
// Collection: chunks
// Shard key: { fileId: 1, index: 1 }
{
  _id: ObjectId,
  fileId: ObjectId,           // ref → files
  versionNumber: Number,      // which file version this chunk belongs to
  index: Number,              // 0-based position in file
  size: Number,               // bytes (may be < 64MB for last chunk)
  checksum: String,           // SHA-256 of chunk data — integrity verification
  status: String,             // "STORED" | "REPLICATING" | "DEGRADED" | "LOST"
  replicas: [{                // embedded — avoids joins
    nodeId: String,           // ref → nodes
    storageKey: String,       // path/key on that node's disk or S3
    status: String,           // "ACTIVE" | "PENDING" | "FAILED"
    verifiedAt: Date          // last integrity check
  }],
  s3BackupKey: String,        // S3 key for cold-tier backup
  createdAt: Date
}

// Indexes:
// { fileId: 1, index: 1 }              — ordered chunk retrieval
// { fileId: 1, versionNumber: 1 }      — version-specific chunks
// { "replicas.nodeId": 1 }             — find all chunks on a specific node
// { status: 1 }                        — find degraded/lost chunks
```

### 2.5 Nodes Collection (Health Status)

```javascript
// Collection: nodes
{
  _id: String,                // node identifier: "storage-node-a"
  host: String,               // IP or hostname
  port: Number,
  region: String,             // "us-east-1" — for locality-aware placement
  rack: String,               // "rack-1" — for rack-aware replication
  status: String,             // "HEALTHY" | "SUSPECT" | "DOWN" | "DRAINING"
  diskTotal: Number,          // bytes
  diskUsed: Number,           // bytes
  diskFreePercent: Number,    // computed
  activeConnections: Number,
  lastHeartbeat: Date,        // updated every 5 seconds
  consecutiveFailures: Number,// health check fail counter
  joinedAt: Date,
  updatedAt: Date
}

// Indexes:
// { status: 1 }                        — healthy node selection
// { lastHeartbeat: 1 }                 — stale heartbeat detection
// { region: 1, rack: 1 }              — placement queries
```

### 2.6 ShareLinks Collection

```javascript
// Collection: shareLinks
{
  _id: ObjectId,
  fileId: ObjectId,           // ref → files
  createdBy: ObjectId,        // ref → users
  token: String,              // unique, URL-safe random string (32 bytes)
  permission: String,         // "VIEW" | "DOWNLOAD"
  isPasswordProtected: Boolean,
  passwordHash: String,       // bcrypt hash of share password, if set
  expiresAt: Date,            // null = never expires
  maxDownloads: Number,       // null = unlimited
  downloadCount: Number,      // current count
  isRevoked: Boolean,         // manual revocation
  // --- Extension points ---
  qrCodeUrl: String,          // future: generated QR code image URL
  notifyOnAccess: Boolean,    // future: email notification
  createdAt: Date
}

// Indexes:
// { token: 1 }              — unique, O(1) link resolution
// { fileId: 1 }             — find all shares for a file
// { expiresAt: 1 }          — TTL index for auto-cleanup
// { createdBy: 1 }          — user's shared links list
```

### 2.7 VersionHistory Collection

```javascript
// Collection: versionHistory
{
  _id: ObjectId,
  fileId: ObjectId,           // ref → files
  versionNumber: Number,
  size: Number,               // size of this version
  uploadedBy: ObjectId,       // ref → users
  changeNote: String,         // optional description
  chunks: [ObjectId],         // refs → chunks for this version
  isCurrentVersion: Boolean,
  createdAt: Date
}

// Indexes:
// { fileId: 1, versionNumber: -1 }    — latest version first
// { fileId: 1, isCurrentVersion: 1 }  — quick current version lookup
```

### 2.8 AuditLogs Collection (Placeholder)

```javascript
// Collection: auditLogs
// This collection is reserved for the future audit logging feature.
// Schema designed now so no migration is needed later.
{
  _id: ObjectId,
  userId: ObjectId,           // who performed the action
  action: String,             // "FILE_UPLOAD" | "FILE_DELETE" | "SHARE_CREATE" | "LOGIN" | ...
  resourceType: String,       // "file" | "folder" | "user" | "shareLink"
  resourceId: ObjectId,       // ref → the affected resource
  metadata: Object,           // action-specific details (IP, user-agent, old/new values)
  ipAddress: String,
  userAgent: String,
  timestamp: Date
}

// Indexes:
// { userId: 1, timestamp: -1 }        — user activity feed
// { action: 1, timestamp: -1 }        — admin: filter by action type
// { resourceType: 1, resourceId: 1 }  — all events for a resource
// { timestamp: 1 }                    — TTL for log retention (90 days)
```

---

## 3. Chunking & Replication Strategy

### 3.1 Chunk Size: 64 MB

| Factor | Reasoning |
|---|---|
| **Throughput** | Larger chunks = fewer I/O operations, better sequential throughput. 64 MB saturates a 1 Gbps link in ~0.5s. |
| **Metadata overhead** | A 1 GB file = 16 chunks = 16 metadata records. At 4 MB chunks, that'd be 256 records — 16× more metadata pressure. |
| **Parallelism** | 64 MB is small enough that a 1 GB file still yields 16 chunks for parallel upload/download across nodes. |
| **Memory** | A single chunk fits comfortably in server memory for streaming without excessive RAM pressure. |
| **Precedent** | GFS uses 64 MB; HDFS defaults to 128 MB. 64 MB is a battle-tested sweet spot. |

For files smaller than 64 MB, the entire file is a single chunk — no overhead.

### 3.2 Chunk-to-File Mapping

```
File (1 GB)
  ├── Chunk 0  (64 MB)  → index: 0, checksum: sha256(data)
  ├── Chunk 1  (64 MB)  → index: 1, checksum: sha256(data)
  ├── ...
  └── Chunk 15 (64 MB)  → index: 15, checksum: sha256(data)
```

Each chunk is an independent unit with its own checksum and replica set. The `chunks` collection stores the ordered mapping. To reconstruct a file, query chunks by `fileId` sorted by `index`, then stream each chunk's data in order.

### 3.3 Replication Factor: 3

Each chunk is stored on **3 different storage nodes**. Rationale:

- **Availability**: With 3 replicas, the system tolerates 2 simultaneous node failures for any given chunk.
- **Read parallelism**: Download requests can pick the least-loaded replica, distributing read traffic.
- **Industry standard**: GFS, HDFS, and Ceph all default to replication factor 3.

### 3.4 Replica Placement Strategy

```
Placement Rules (priority order):
1. No two replicas of the same chunk on the same node (obvious)
2. At least one replica on a different rack (rack-awareness)
3. Prefer nodes with most free disk space (load leveling)
4. Prefer nodes in the same region as the uploader (latency)
```

**Algorithm** (simplified):
```javascript
function selectNodes(chunkId, replicationFactor, allNodes) {
  const healthy = allNodes.filter(n => n.status === 'HEALTHY');
  const sorted = healthy.sort((a, b) => b.diskFreePercent - a.diskFreePercent);

  const selected = [];
  const usedRacks = new Set();

  // First pass: spread across racks
  for (const node of sorted) {
    if (selected.length >= replicationFactor) break;
    if (!usedRacks.has(node.rack) || selected.length >= 2) {
      selected.push(node);
      usedRacks.add(node.rack);
    }
  }

  // Backfill if rack diversity isn't possible (e.g., only 1 rack)
  if (selected.length < replicationFactor) {
    for (const node of sorted) {
      if (selected.length >= replicationFactor) break;
      if (!selected.includes(node)) selected.push(node);
    }
  }

  return selected;
}
```

### 3.5 Consistency Model: Eventual Consistency with Read-Your-Writes

| Aspect | Model | Justification |
|---|---|---|
| **Writes** | Write to primary → ACK client → async replicate | Fast uploads. Acceptable because file data is immutable once written. |
| **Reads** | Read from any healthy replica | Chunks are immutable — no stale-read risk once replicated. |
| **Metadata** | Read from MongoDB primary for writes; secondaries OK for reads | Ensures upload confirmations are immediately visible to the uploader. |
| **Consistency guarantee** | If uploader reads immediately after upload, they hit the primary → see their file. Other users may see a brief delay (seconds). | |

This is **not** strong consistency (no distributed transactions, no Paxos). It's appropriate because:
- File chunks are **write-once, read-many** — no update conflicts.
- The brief replication window is bounded (typically < 2 seconds for healthy nodes).
- The Metadata Service is the single source of truth for "which replicas exist."

### 3.6 Failover & Re-Replication

```
Trigger: Node health check fails for 3 consecutive intervals (15 seconds)

1. Metadata Service marks node as "DOWN"
2. Metadata Service queries all chunks with a replica on the dead node
3. For each affected chunk:
   a. If remaining healthy replicas >= 1 → chunk is DEGRADED, not lost
   b. Metadata Service selects a new target node (using placement algorithm)
   c. Initiates re-replication: healthy replica → new node
   d. On success: updates chunk.replicas[], marks chunk as STORED
4. If remaining healthy replicas == 0:
   a. Chunk status → "LOST"
   b. Attempt recovery from S3 cold-tier backup
   c. Alert admin via dashboard
5. When dead node comes back online:
   a. Metadata Service marks it "SUSPECT," runs integrity check
   b. Stale replicas on recovered node are verified (checksum) or discarded
   c. Node returns to "HEALTHY" after passing checks
```

**Re-replication rate limiting**: To avoid saturating the network, re-replication runs at most 2 chunks concurrently per target node, with a 100 MB/s bandwidth cap. This prevents a cascade where re-replication traffic causes other nodes to appear slow and get falsely marked as unhealthy.
