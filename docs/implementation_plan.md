# Mini Google Drive — Implementation Plan

## Repo Structure Decision: **Monorepo**

**Why monorepo over separate repos:**
- All services share MongoDB schemas, validation logic, and constants (DRY)
- Single `docker-compose.yml` orchestrates everything
- Atomic commits when a feature touches API + frontend + storage node
- Simpler CI/CD for a portfolio project
- Service boundaries are still clean via `/services/*` directories

```
distributed-file-system/
├── services/
│   ├── api-server/           # Main Express.js backend (Phase 1+)
│   │   ├── src/
│   │   │   ├── config/       # DB, env, constants
│   │   │   ├── models/       # Mongoose schemas
│   │   │   ├── routes/       # Express routers
│   │   │   ├── middleware/   # Auth, validation, error handling
│   │   │   ├── controllers/  # Route handlers
│   │   │   ├── services/     # Business logic
│   │   │   ├── utils/        # Helpers
│   │   │   └── app.js        # Express app setup
│   │   ├── package.json
│   │   └── .env.example
│   ├── metadata-service/     # Phase 6
│   ├── storage-node/         # Phase 6
│   └── frontend/             # Phase 5 (React via Vite)
├── shared/                   # Shared constants, enums (Phase 3+)
├── nginx/                    # Nginx configs (Phase 7)
├── docker/                   # Dockerfiles per service (Phase 9)
├── scripts/                  # Seed scripts, setup helpers
├── docker-compose.yml        # Phase 9
├── .env.example
├── .gitignore
└── README.md
```

---

## Phase Breakdown

### Phase 1 — Project Scaffold + Authentication ✅
| | |
|---|---|
| **Goal** | Runnable Express server with full JWT auth flow |
| **Builds** | Project structure, MongoDB connection, User model, auth routes, JWT middleware, input validation, error handling |
| **Files** | `services/api-server/` full scaffold (see structure above) |
| **Deps** | `express`, `mongoose`, `bcryptjs`, `jsonwebtoken`, `express-validator`, `cors`, `helmet`, `morgan`, `dotenv` |
| **Done when** | Can register → login → get JWT → access protected route → refresh token → logout. Tested via Postman/curl. |

### Phase 2 — Basic File Upload & Download
| | |
|---|---|
| **Goal** | Upload/download single files (no chunking yet), stored on local disk |
| **Builds** | File model, `multer` upload middleware, upload/download/delete routes, storage quota tracking, file metadata |
| **New files** | `models/File.js`, `routes/files.js`, `controllers/fileController.js`, `middleware/upload.js`, `uploads/` directory |
| **Deps** | `multer`, `mime-types`, `uuid` |
| **Done when** | Can upload a file, list my files, download by ID, soft-delete. Storage quota updates on upload. |

### Phase 3 — Folders, Search & File Management
| | |
|---|---|
| **Goal** | Folder hierarchy, move/rename files, full-text search |
| **Builds** | Folder model, folder CRUD, materialized-path logic, file move/rename, search endpoint |
| **New files** | `models/Folder.js`, `routes/folders.js`, `controllers/folderController.js`, `services/searchService.js` |
| **Done when** | Can create folders, nest them, move files between folders, search files by name. |

### Phase 4 — Sharing, Versions & Recycle Bin
| | |
|---|---|
| **Goal** | Share files via link, version history, soft-delete/restore |
| **Builds** | ShareLink model, VersionHistory model, share CRUD, public share access, version upload, recycle bin endpoints |
| **New files** | `models/ShareLink.js`, `models/VersionHistory.js`, `routes/shares.js`, `routes/versions.js`, `routes/trash.js`, corresponding controllers |
| **Done when** | Can share a file via link → access without auth, upload new version, view version list, delete to trash → restore. |

### Phase 5 — React Frontend
| | |
|---|---|
| **Goal** | Full UI: auth pages, file manager, dashboard |
| **Builds** | React app via Vite, auth pages, file browser with drag-drop upload, folder navigation, sharing UI, dashboard, recycle bin, admin panel |
| **New files** | `services/frontend/` entire React app |
| **Deps** | `react`, `react-router-dom`, `axios`, `react-dropzone`, etc. |
| **Done when** | Full CRUD flow works through the UI. Dashboard shows storage usage. |

### Phase 6 — Chunking, Replication & Storage Nodes
| | |
|---|---|
| **Goal** | Files split into chunks, stored across distributed storage nodes, replicated 3× |
| **Builds** | Metadata Service, Storage Node service, Chunk model, chunk-based upload/download, replica placement |
| **New files** | `services/metadata-service/`, `services/storage-node/`, `models/Chunk.js`, `models/Node.js` |
| **Deps** | `axios` (inter-service calls) |
| **Done when** | A large file uploads in chunks across 3 storage nodes. Download reassembles from chunks. Metadata service tracks locations. |

### Phase 7 — Redis Caching + Nginx Load Balancing
| | |
|---|---|
| **Goal** | Cached metadata, load-balanced API servers, rate limiting |
| **Builds** | Redis integration, cache layer for file metadata/chunk maps/quotas, Nginx reverse proxy config, health endpoints |
| **New files** | `services/api-server/src/services/cacheService.js`, `nginx/nginx.conf`, `services/api-server/src/routes/health.js` |
| **Deps** | `ioredis` |
| **Done when** | Cached reads are measurably faster. Nginx distributes across 2 API servers. Rate limiting works. |

### Phase 8 — Fault Tolerance & Failover
| | |
|---|---|
| **Goal** | System survives node deaths, auto-re-replicates |
| **Builds** | Heartbeat system, health monitor, circuit breaker, re-replication worker, node drain |
| **New files** | `services/metadata-service/src/healthMonitor.js`, `services/metadata-service/src/replicationWorker.js`, `services/api-server/src/utils/circuitBreaker.js` |
| **Done when** | Kill a storage node → system detects in ~15s → re-replicates affected chunks → downloads still work. |

### Phase 9 — Docker & Deployment
| | |
|---|---|
| **Goal** | Everything containerized, deployable to EC2/Azure |
| **Builds** | Dockerfiles per service, docker-compose, MongoDB replica set setup, environment configs |
| **New files** | `docker/Dockerfile.api`, `docker/Dockerfile.metadata`, `docker/Dockerfile.storage`, `docker/Dockerfile.frontend`, `docker-compose.yml`, `scripts/init-replica-set.sh` |
| **Done when** | `docker-compose up` brings up entire system. Accessible from browser. |

### Phase 10 — S3 Integration (Cold Tier)
| | |
|---|---|
| **Goal** | Async backup of chunks to S3, recovery from S3 when local replicas exhausted |
| **Builds** | S3 upload worker, S3 recovery path in download flow |
| **Deps** | `@aws-sdk/client-s3` |
| **Done when** | Chunks appear in S3 bucket after upload. Can recover a chunk from S3 if all local replicas gone. |

### Phase 11 — Admin Dashboard
| | |
|---|---|
| **Goal** | Admin UI: system stats, user management, node health |
| **Builds** | Admin API routes, admin frontend pages |
| **Done when** | Admin can view system stats, manage users, see node health, drain a node. |

---

## Future Feature Phases (Phase 12+)

| Phase | Feature | Key Work |
|---|---|---|
| 12 | Audit Logs | Logging middleware, auditLogs collection writes, admin viewer |
| 13 | RBAC | Roles collection, permission middleware, admin role management |
| 14 | File Deduplication | SHA-256 on upload, dedup check before storing, refCount on chunks |
| 15 | Compression | gzip/zstd before chunking, decompress on download |
| 16 | WebSocket Upload Progress | `ws` server, Redis Pub/Sub bridge, frontend progress bar |
| 17 | Expiring Link Cleanup | Cron job for expired share cleanup, TTL enforcement |
| 18 | Email Notifications | Bull queue, SendGrid/SES worker, notification on share |
| 19 | QR Code Sharing | `qrcode` npm, QR generation on share, download endpoint |
| 20 | Virus Scanning | ClamAV container, scan queue, quarantine flow |
| 21 | E2E Encryption | Client-side AES-256, key management, encrypted chunk storage |

---

## Design Decisions to Confirm Before Phase 2

> [!IMPORTANT]
> 1. **Local upload storage path**: During Phases 2–5 (before distributed storage nodes exist), files will be stored on the API server's local disk at `./uploads/`. OK?
> 2. **Port assignments**: API Server `:3000`, Metadata Service `:4000`, Storage Nodes `:5001–5003`, Frontend dev `:5173`, MongoDB `:27017`, Redis `:6379`. Any conflicts?
> 3. **File size limit for Phase 2**: Before chunking exists (Phase 6), I'll cap uploads at 100 MB via multer. Acceptable?
