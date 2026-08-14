# Distributed File Storage System — "Mini Google Drive"
## Part 2: Metadata Server, API Design & Core Workflows

---

## 4. Metadata Server Design

The Metadata Service is the **brain** of the distributed storage layer. It's a dedicated Express.js microservice (separate from the API server) that owns the chunk→node mapping.

### 4.1 What It Tracks

| Data | Source | Update Frequency |
|---|---|---|
| Node registry (host, port, rack, region) | Node self-registration on startup | Rare (node add/remove) |
| Node health status + disk metrics | Heartbeats from storage nodes | Every 5 seconds |
| Chunk → node mappings (replicas) | Created during upload, updated during re-replication | On upload + failover |
| Chunk integrity checksums | Computed on upload | Immutable after write |
| Replication queue | Generated when a chunk is under-replicated | On node failure detection |

### 4.2 Consistency with Storage Nodes

The Metadata Service is the **single source of truth**. Storage nodes are "dumb" — they store bytes and respond to health checks. The consistency protocol:

1. **On upload**: API server tells Metadata Service "I want to write chunk X." Metadata Service allocates nodes and records `replicas: [{nodeId, status: "PENDING"}]`. After the storage node ACKs the write, API server tells Metadata Service → status becomes `"ACTIVE"`.

2. **On heartbeat**: Each storage node sends a heartbeat every 5 seconds containing: `{ nodeId, diskUsed, diskFree, activeConnections, chunkCount }`. Metadata Service updates the `nodes` collection.

3. **Periodic reconciliation** (every 1 hour): Metadata Service asks each healthy node to report its chunk inventory. Compares against its records. Orphaned chunks on nodes are flagged for cleanup. Missing chunks trigger re-replication.

4. **Checksum verification** (every 24 hours): Metadata Service asks storage nodes to recompute and report checksums for a random sample of chunks. Mismatches trigger re-replication from a healthy replica.

### 4.3 Redis Caching Strategy

| Cache Key Pattern | Value | TTL | Invalidation |
|---|---|---|---|
| `file:meta:{fileId}` | File document (name, size, status, folderId) | 10 min | On file update/delete |
| `file:chunks:{fileId}:{version}` | Ordered list of chunk IDs + replica locations | 5 min | On re-replication |
| `node:health:{nodeId}` | Latest health status + disk metrics | 30 sec | On heartbeat |
| `node:healthy_list` | Array of all healthy node IDs | 10 sec | On any node status change |
| `user:quota:{userId}` | `{ storageUsed, storageQuota }` | 2 min | On upload/delete |
| `folder:tree:{userId}:{folderId}` | Folder contents (files + subfolders) | 3 min | On any child change |
| `share:{token}` | ShareLink document | 15 min | On revoke/expire |
| `ratelimit:{ip}` | Request counter | 1 min | Auto-expire (sliding window) |

**Cache invalidation approach**: Write-through for critical paths (quota updates, node health). Event-driven invalidation for everything else — when a file is updated, the API server publishes to Redis Pub/Sub channel `cache:invalidate`, and all API server instances subscribe and delete the relevant keys.

```javascript
// Publish invalidation event after file update
redis.publish('cache:invalidate', JSON.stringify({
  type: 'file:update',
  keys: [`file:meta:${fileId}`, `file:chunks:${fileId}:*`, `folder:tree:${userId}:${folderId}`]
}));
```

---

## 5. API Design (REST)

All endpoints return JSON. Auth endpoints are public; all others require `Authorization: Bearer <JWT>` header unless noted.

### 5.1 Authentication

| Method | Route | Description | Auth | Request Body | Response |
|---|---|---|---|---|---|
| POST | `/api/auth/register` | Create account | No | `{ email, username, password }` | `{ userId, token, refreshToken }` |
| POST | `/api/auth/login` | Login | No | `{ email, password }` | `{ token, refreshToken, user }` |
| POST | `/api/auth/refresh` | Refresh JWT | No | `{ refreshToken }` | `{ token, refreshToken }` |
| POST | `/api/auth/logout` | Invalidate refresh token | Yes | — | `{ message }` |
| GET | `/api/auth/me` | Get current user profile | Yes | — | `{ user }` |

### 5.2 Files

| Method | Route | Description | Auth | Request / Params | Response |
|---|---|---|---|---|---|
| POST | `/api/files/upload` | Upload file | Yes | Multipart: `file`, `folderId?`, `changeNote?` | `{ fileId, filename, size, version }` |
| POST | `/api/files/upload/init` | Init chunked upload | Yes | `{ filename, size, mimeType, folderId?, totalChunks }` | `{ uploadId, chunkUrls[] }` |
| PUT | `/api/files/upload/:uploadId/chunk/:index` | Upload single chunk | Yes | Binary chunk data | `{ chunkId, status }` |
| POST | `/api/files/upload/:uploadId/complete` | Finalize chunked upload | Yes | `{ checksums[] }` | `{ fileId, filename, status }` |
| GET | `/api/files/:id` | Get file metadata | Yes | — | `{ file }` |
| GET | `/api/files/:id/download` | Download file | Yes | — | Binary stream |
| DELETE | `/api/files/:id` | Soft delete (recycle bin) | Yes | — | `{ message }` |
| PATCH | `/api/files/:id` | Rename / move file | Yes | `{ filename?, folderId? }` | `{ file }` |
| GET | `/api/files/search` | Search files | Yes | Query: `q`, `type?`, `dateFrom?`, `dateTo?` | `{ files[], total }` |

### 5.3 Folders

| Method | Route | Description | Auth | Request / Params | Response |
|---|---|---|---|---|---|
| POST | `/api/folders` | Create folder | Yes | `{ name, parentFolderId? }` | `{ folder }` |
| GET | `/api/folders/:id` | Get folder contents | Yes | Query: `page`, `limit`, `sort` | `{ folder, files[], subfolders[] }` |
| GET | `/api/folders/:id/tree` | Get folder tree (recursive) | Yes | Query: `depth?` | `{ tree }` |
| PATCH | `/api/folders/:id` | Rename / move folder | Yes | `{ name?, parentFolderId? }` | `{ folder }` |
| DELETE | `/api/folders/:id` | Soft delete folder + contents | Yes | — | `{ message, affectedCount }` |

### 5.4 Sharing

| Method | Route | Description | Auth | Request / Params | Response |
|---|---|---|---|---|---|
| POST | `/api/shares` | Create share link | Yes | `{ fileId, permission, expiresIn?, password?, maxDownloads? }` | `{ shareLink, url, token }` |
| GET | `/api/shares/file/:fileId` | List shares for a file | Yes | — | `{ shares[] }` |
| GET | `/api/shares/:token` | Access shared file (public) | No | Query: `password?` | `{ file }` or redirect to download |
| GET | `/api/shares/:token/download` | Download shared file (public) | No | Query: `password?` | Binary stream |
| DELETE | `/api/shares/:shareId` | Revoke share link | Yes | — | `{ message }` |

### 5.5 Versions

| Method | Route | Description | Auth | Request / Params | Response |
|---|---|---|---|---|---|
| GET | `/api/files/:id/versions` | List all versions | Yes | — | `{ versions[] }` |
| GET | `/api/files/:id/versions/:versionNum` | Get specific version metadata | Yes | — | `{ version }` |
| GET | `/api/files/:id/versions/:versionNum/download` | Download specific version | Yes | — | Binary stream |
| POST | `/api/files/:id/versions/:versionNum/restore` | Restore old version as current | Yes | — | `{ file, newVersion }` |

### 5.6 Recycle Bin

| Method | Route | Description | Auth | Request / Params | Response |
|---|---|---|---|---|---|
| GET | `/api/trash` | List deleted items | Yes | Query: `page`, `limit` | `{ items[], total }` |
| POST | `/api/trash/:id/restore` | Restore from trash | Yes | — | `{ file \| folder }` |
| DELETE | `/api/trash/:id` | Permanent delete | Yes | — | `{ message }` |
| DELETE | `/api/trash` | Empty entire trash | Yes | — | `{ deletedCount }` |

### 5.7 Admin Dashboard

| Method | Route | Description | Auth | Request / Params | Response |
|---|---|---|---|---|---|
| GET | `/api/admin/stats` | System overview stats | Admin | — | `{ totalUsers, totalFiles, totalStorage, nodeCount }` |
| GET | `/api/admin/users` | List all users | Admin | Query: `page`, `limit`, `search` | `{ users[], total }` |
| PATCH | `/api/admin/users/:id` | Update user (quota, role, active) | Admin | `{ storageQuota?, role?, isActive? }` | `{ user }` |
| GET | `/api/admin/nodes` | List storage nodes + health | Admin | — | `{ nodes[] }` |
| POST | `/api/admin/nodes/:id/drain` | Drain node (migrate data off) | Admin | — | `{ message, chunksToMigrate }` |
| GET | `/api/admin/files/orphaned` | Find orphaned chunks | Admin | — | `{ orphanedChunks[] }` |

### 5.8 Node Health (Internal — Metadata Service ↔ Storage Nodes)

| Method | Route | Description | Auth | Request / Params | Response |
|---|---|---|---|---|---|
| POST | `/internal/nodes/register` | Node self-registration | Internal key | `{ nodeId, host, port, region, rack }` | `{ registered: true }` |
| POST | `/internal/nodes/:id/heartbeat` | Heartbeat ping | Internal key | `{ diskUsed, diskFree, activeConns, chunkCount }` | `{ ack: true }` |
| GET | `/internal/nodes/:id/chunks` | List chunks on node | Internal key | — | `{ chunks[] }` |
| POST | `/internal/chunks/replicate` | Trigger re-replication | Internal key | `{ chunkId, sourceNodeId, targetNodeId }` | `{ status }` |

These internal endpoints use a shared secret (`X-Internal-Key` header), not JWT — they're only called within the Docker network.

---

## 6. Core Workflows

### 6.1 File Upload with Chunking + Replication

```
Precondition: User is authenticated, has sufficient storage quota.

 1. Client sends POST /api/files/upload/init
    Body: { filename: "report.pdf", size: 150_000_000, mimeType: "application/pdf",
            folderId: "abc123", totalChunks: 3 }

 2. API Server:
    a. Validates JWT
    b. Checks user.storageUsed + 150MB <= user.storageQuota
    c. Creates File document with status: "UPLOADING"
    d. Calls Metadata Service: allocateChunks({ fileId, totalChunks: 3, replicationFactor: 3 })

 3. Metadata Service:
    a. Reads healthy node list from Redis cache (or MongoDB)
    b. For each chunk (0, 1, 2), runs placement algorithm → selects 3 nodes
    c. Creates Chunk documents with status: "PENDING", replicas: [{ nodeId, status: "PENDING" }]
    d. Returns allocation map to API Server

 4. API Server returns to Client:
    { uploadId: "xyz", chunkAllocation: [
      { index: 0, primaryNode: "node-a", uploadUrl: "/internal/chunks/write" },
      { index: 1, primaryNode: "node-b", uploadUrl: "/internal/chunks/write" },
      { index: 2, primaryNode: "node-a", uploadUrl: "/internal/chunks/write" }
    ]}

 5. Client uploads each chunk: PUT /api/files/upload/xyz/chunk/0
    (API Server proxies to the assigned primary storage node)

 6. For each chunk, Storage Node:
    a. Writes chunk to local disk at path: /data/chunks/{chunkId}
    b. Computes SHA-256 checksum
    c. ACKs to API Server

 7. API Server updates chunk status in Metadata Service: "PENDING" → "STORED"

 8. Storage Node (async, post-ACK):
    a. Pushes chunk to replica nodes (pipeline replication):
       Primary → Replica1 → Replica2
    b. Each replica ACKs back to Metadata Service

 9. Client sends POST /api/files/upload/xyz/complete
    Body: { checksums: ["sha256_0", "sha256_1", "sha256_2"] }

10. API Server:
    a. Verifies checksums match what storage nodes reported
    b. Updates File document: status → "AVAILABLE"
    c. Creates VersionHistory record (version 1)
    d. Updates user.storageUsed += 150MB
    e. Invalidates Redis caches: user quota, folder contents

11. API Server responds: { fileId, filename, size, version: 1, status: "AVAILABLE" }

12. Background (S3 cold tier):
    a. Storage nodes async-upload chunks to S3 as backup
    b. Update chunk.s3BackupKey when complete
```

### 6.2 File Download with Node Selection & Failover

```
 1. Client sends GET /api/files/:id/download

 2. API Server:
    a. Validates JWT
    b. Checks file ownership or active share link
    c. Queries Redis cache for chunk map → cache miss → queries Metadata Service
    d. Gets: { chunks: [
         { index: 0, replicas: [{ nodeId: "node-a", status: "ACTIVE" }, { nodeId: "node-c", status: "ACTIVE" }] },
         { index: 1, replicas: [{ nodeId: "node-b", status: "ACTIVE" }, { nodeId: "node-a", status: "ACTIVE" }] },
         ...
       ]}

 3. API Server sets response headers:
    Content-Type: application/pdf
    Content-Disposition: attachment; filename="report.pdf"
    Content-Length: 150000000

 4. For each chunk (in order, index 0 → N):
    a. Score each healthy replica:
       score = 0.4 * (1 - node.load) + 0.3 * latencyScore + 0.3 * localityScore
    b. Select highest-scoring node
    c. HTTP GET to storage node: /internal/chunks/{chunkId}/read
    d. Stream chunk data directly into HTTP response (pipe, no buffering)

 5. If a storage node fails mid-chunk:
    a. API Server detects connection error / timeout (3 second timeout)
    b. Selects next-best replica for that same chunk
    c. Re-requests the chunk from offset (using Range header if supported)
    d. Continues streaming — client sees no interruption (TCP handles buffering)
    e. Reports failed node to Metadata Service for health tracking

 6. After all chunks streamed, response ends. Client has complete file.

 7. API Server updates: file.downloadCount++, caches chunk map in Redis
```

### 6.3 File Sharing via Link

```
 1. Client sends POST /api/shares
    Body: { fileId: "abc", permission: "DOWNLOAD", expiresIn: 86400, password: "secret123" }

 2. API Server:
    a. Validates JWT
    b. Confirms user owns the file
    c. Generates cryptographically secure token: crypto.randomBytes(32).toString('base64url')
    d. Hashes password with bcrypt if provided
    e. Computes expiresAt = now + 86400 seconds
    f. Creates ShareLink document in MongoDB

 3. API Server responds:
    { shareLink: { token, permission, expiresAt },
      url: "https://drive.example.com/share/abc123token..." }

 4. Owner shares the URL externally (email, chat, etc.)

 5. Recipient visits GET /api/shares/:token:
    a. API Server looks up ShareLink by token (Redis cache → MongoDB)
    b. Checks: isRevoked? expiresAt > now? downloadCount < maxDownloads?
    c. If passwordProtected → returns 401 with prompt
    d. Recipient re-requests with ?password=secret123
    e. API Server verifies bcrypt.compare(password, passwordHash)
    f. Returns file metadata (name, size, type) for preview

 6. Recipient clicks download → GET /api/shares/:token/download:
    a. Re-validates all share constraints
    b. Increments downloadCount atomically: { $inc: { downloadCount: 1 } }
    c. Proceeds with same download flow as 6.2 (chunk streaming)
    d. No JWT required — the token IS the auth for this specific file
```

### 6.4 Node Failure Detection & Automatic Failover

```
Continuous Process — Metadata Service Health Monitor (runs in background)

 1. Every 5 seconds, Metadata Service expects a heartbeat from each registered node.

 2. If no heartbeat received within 10 seconds:
    a. Mark node as "SUSPECT"
    b. Increment node.consecutiveFailures
    c. Send active health probe: HTTP GET /internal/health to the node

 3. If consecutiveFailures >= 3 (15 seconds of silence + failed probes):
    a. Mark node as "DOWN"
    b. Log event (future: audit log)
    c. Notify admin dashboard via WebSocket/SSE

 4. Metadata Service queries: db.chunks.find({ "replicas.nodeId": deadNodeId })
    Result: list of all chunks that had a replica on the dead node

 5. For each affected chunk:
    a. Remove dead node's replica entry from the chunk's replicas array
    b. Count remaining healthy replicas
    c. If count < replicationFactor (3):
       - Status → "DEGRADED"
       - Add to re-replication queue (priority: chunks with fewer replicas first)

 6. Re-Replication Worker (separate process within Metadata Service):
    a. Pops highest-priority chunk from queue
    b. Selects a source node (healthy replica holder)
    c. Selects a target node (placement algorithm — different rack, most free space)
    d. Sends POST /internal/chunks/replicate to source node:
       { chunkId, targetNodeId, targetHost }
    e. Source node reads chunk from local disk, streams to target node
    f. Target node writes, computes checksum, ACKs Metadata Service
    g. Metadata Service updates chunk.replicas[] — adds new replica, status: "ACTIVE"
    h. If chunk now has replicationFactor replicas → status: "STORED"

 7. Rate limiting: max 2 concurrent re-replications per target node, 100 MB/s cap
    (Prevents re-replication storm from degrading live traffic)

 8. When previously-down node recovers:
    a. Node sends heartbeat → Metadata Service sees it, marks "SUSPECT"
    b. Metadata Service runs chunk inventory check on the node
    c. Valid chunks are re-registered as replicas
    d. Corrupted chunks (checksum mismatch) are deleted from the node
    e. After inventory passes → node status: "HEALTHY"
```

### 6.5 Recycle Bin: Delete & Restore

```
SOFT DELETE:

 1. Client sends DELETE /api/files/:id

 2. API Server:
    a. Validates JWT + ownership
    b. Updates File document:
       { isDeleted: true, deletedAt: new Date(), status: "DELETED" }
    c. Does NOT delete chunks or modify storage nodes
    d. Updates folder contents cache (Redis invalidation)
    e. File disappears from folder listings, appears in trash
    f. Storage quota is NOT freed (file still physically exists)

 3. Response: { message: "Moved to trash", restoreDeadline: "2026-07-30T..." }

RESTORE:

 4. Client browses GET /api/trash → sees deleted files with deletion dates

 5. Client sends POST /api/trash/:id/restore

 6. API Server:
    a. Validates JWT + ownership
    b. Checks: is the original folderId still valid?
       - If parent folder also deleted → restore to root
       - If parent folder exists → restore to original location
    c. Updates File document:
       { isDeleted: false, deletedAt: null, status: "AVAILABLE" }
    d. Invalidates caches

 7. Response: { file, restoredTo: "/documents/work" }

PERMANENT DELETE:

 8. Client sends DELETE /api/trash/:id (or auto-purge after 30 days)

 9. API Server:
    a. Queries all chunks for this file (all versions)
    b. For each chunk → tells each replica's storage node:
       DELETE /internal/chunks/{chunkId}
    c. Storage nodes delete from local disk
    d. Deletes S3 backup: s3.deleteObject({ Key: chunk.s3BackupKey })
    e. Deletes Chunk documents from MongoDB
    f. Deletes VersionHistory records
    g. Deletes File document
    h. Updates user.storageUsed -= file.size
    i. Invalidates caches

10. Auto-purge job (runs daily):
    db.files.find({ isDeleted: true, deletedAt: { $lt: thirtyDaysAgo } })
    → executes permanent delete (step 9) for each
```
