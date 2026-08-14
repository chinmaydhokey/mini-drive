# 🗄️ Distributed File Storage System — "Mini Google Drive"

A production-grade distributed file storage system built as a portfolio project, demonstrating distributed systems principles like chunking, replication, fault tolerance, and load balancing.

## 🏗️ Architecture Overview

```
Client (React.js)
    │
    ▼
Nginx (Load Balancer / API Gateway)
    │
    ├──▶ API Server 1 (Express.js)  ──▶ MongoDB (Replica Set)
    ├──▶ API Server 2 (Express.js)  ──▶ Redis Cache
    │
    ▼
Metadata Service ──▶ Storage Node A
                 ──▶ Storage Node B  ──▶ AWS S3 (Cold Backup)
                 ──▶ Storage Node C
```

## ✨ Features

| Feature | Status |
|---|---|
| User Registration & Login (JWT + bcrypt) | ✅ Phase 1 |
| File Upload / Download | 🔲 Phase 2 |
| Folder Management | 🔲 Phase 3 |
| File Sharing via Link | 🔲 Phase 4 |
| Version History | 🔲 Phase 4 |
| Recycle Bin (Soft Delete/Restore) | 🔲 Phase 4 |
| React Frontend Dashboard | 🔲 Phase 5 |
| Chunk-based Storage & Replication | 🔲 Phase 6 |
| Redis Caching & Nginx Load Balancing | 🔲 Phase 7 |
| Fault Tolerance & Auto-Failover | 🔲 Phase 8 |
| Docker & Cloud Deployment | 🔲 Phase 9 |
| Admin Dashboard | 🔲 Phase 11 |

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React.js (Vite) |
| Backend | Node.js + Express.js |
| Database | MongoDB (Replica Set) |
| Authentication | JWT (access + refresh tokens) + bcrypt |
| Caching | Redis |
| Object Storage | AWS S3 |
| Load Balancer | Nginx |
| Containerization | Docker + Docker Compose |
| Deployment | AWS EC2 / Azure VM |

## 📁 Project Structure (Monorepo)

```
distributed-file-system/
├── .env.example              # Environment variable template
├── .gitignore
├── README.md
│
├── services/
│   └── api-server/           # Main backend service
│       ├── package.json
│       ├── uploads/           # Local file storage (dev only)
│       └── src/
│           ├── app.js                # Express app entry point
│           ├── config/
│           │   ├── index.js          # Central configuration
│           │   └── db.js             # MongoDB connection
│           ├── models/
│           │   └── User.js           # User schema (bcrypt, JWT helpers)
│           ├── controllers/
│           │   └── authController.js # Auth business logic
│           ├── middleware/
│           │   ├── auth.js           # JWT verification middleware
│           │   ├── errorHandler.js   # Global error handler
│           │   ├── validators.js     # Input validation rules
│           │   └── handleValidation.js
│           ├── routes/
│           │   └── auth.js           # Auth route definitions
│           └── utils/
│               ├── jwt.js            # Token generation/verification
│               └── AppError.js       # Custom error class
│
│   # Coming in later phases:
│   ├── metadata-service/     # Chunk-to-node mapping (Phase 6)
│   ├── storage-node/         # Distributed chunk storage (Phase 6)
│   └── frontend/             # React.js UI (Phase 5)
│
├── nginx/                    # Nginx configs (Phase 7)
├── docker/                   # Dockerfiles (Phase 9)
└── docker-compose.yml        # Full stack orchestration (Phase 9)
```

## 🚀 Getting Started

### Prerequisites

- **Node.js** v18+ ([download](https://nodejs.org/))
- **MongoDB** v7+ running locally on port `27017`
  - Download: [mongodb.com/try/download](https://www.mongodb.com/try/download/community)
  - Or use Docker: `docker run -d -p 27017:27017 --name mongo mongo:7`

### Setup

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd distributed-file-system

# 2. Create environment file
cp .env.example .env
# Edit .env if needed (defaults work for local development)

# 3. Install dependencies
cd services/api-server
npm install

# 4. Start the development server
npm run dev
```

The server starts at **http://localhost:3000**.

### Verify It's Running

```bash
# Health check
GET http://localhost:3000/health

# Response:
{
  "status": "ok",
  "service": "api-server",
  "timestamp": "2026-06-30T17:41:30.000Z",
  "uptime": 12.345
}
```

## 📡 API Documentation (Phase 1 — Authentication)

**Base URL:** `http://localhost:3000/api`

### Register a New User

```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "john@example.com",
  "username": "johndoe",
  "password": "MySecure123"
}
```

**Password Requirements:** min 8 chars, at least 1 uppercase, 1 lowercase, 1 number.

**Response (201):**
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "...",
      "email": "john@example.com",
      "username": "johndoe",
      "role": "user",
      "storageQuota": 5368709120,
      "storageUsed": 0,
      "isActive": true,
      "createdAt": "...",
      "updatedAt": "..."
    },
    "accessToken": "eyJhbGci...",
    "refreshToken": "eyJhbGci..."
  }
}
```

### Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "MySecure123"
}
```

**Response (200):** Same shape as register.

### Get Current User Profile (Protected)

```http
GET /api/auth/me
Authorization: Bearer <accessToken>
```

**Response (200):** Returns user object (no sensitive fields).

### Refresh Tokens

```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "<your-refresh-token>"
}
```

**Response (200):** Returns new `accessToken` + `refreshToken` (token rotation).

### Logout (Protected)

```http
POST /api/auth/logout
Authorization: Bearer <accessToken>
```

**Response (200):** `{ "success": true, "data": { "message": "Logged out successfully." } }`

### Error Responses

All errors follow this shape:
```json
{
  "success": false,
  "error": {
    "message": "Human-readable error description",
    "stack": "..." // only in development mode
  }
}
```

| Status | Meaning |
|---|---|
| 400 | Validation error (bad input) |
| 401 | Unauthorized (missing/invalid/expired token) |
| 403 | Forbidden (inactive account, wrong role) |
| 404 | Resource not found |
| 409 | Conflict (duplicate email/username) |
| 500 | Internal server error |

## 🔐 Security Architecture

### Authentication Flow

```
┌──────────────────────────────────────────────────────────────┐
│                    TOKEN LIFECYCLE                            │
│                                                              │
│  Register/Login ──▶ Access Token (15 min) ──▶ Use in API    │
│        │                                        headers      │
│        ▼                                                     │
│  Refresh Token (7 days) ──▶ POST /refresh ──▶ New pair      │
│  (httpOnly cookie + DB)      (rotation)      (old revoked)   │
│                                                              │
│  Logout ──▶ Refresh token cleared from DB + cookie           │
└──────────────────────────────────────────────────────────────┘
```

### Security Measures

| Measure | Implementation |
|---|---|
| Password hashing | bcrypt with 12 salt rounds (~250ms/hash) |
| Access tokens | Short-lived (15 min), stored in client memory |
| Refresh tokens | HttpOnly cookie + SHA-256 hashed in DB |
| Token rotation | Every refresh issues new pair, old invalidated |
| Reuse detection | If old refresh token reused → all sessions killed |
| Input validation | express-validator on every endpoint |
| Security headers | helmet.js (CSP, HSTS, X-Frame-Options, etc.) |
| CORS | Restricted to frontend origin only |
| Error sanitization | Stack traces only shown in development |

## 🧪 Testing with PowerShell

```powershell
# Register
Invoke-RestMethod -Uri "http://localhost:3000/api/auth/register" `
  -Method POST -ContentType "application/json" `
  -Body '{"email":"test@example.com","username":"testuser","password":"MyPass123"}'

# Login & use token
$login = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/login" `
  -Method POST -ContentType "application/json" `
  -Body '{"email":"test@example.com","password":"MyPass123"}'

# Access protected route
Invoke-RestMethod -Uri "http://localhost:3000/api/auth/me" `
  -Method GET -Headers @{Authorization="Bearer $($login.data.accessToken)"}
```

## 📋 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Environment mode |
| `PORT` | `3000` | API server port |
| `MONGO_URI` | `mongodb://localhost:27017/minidrive` | MongoDB connection string |
| `JWT_ACCESS_SECRET` | (set in .env) | Secret for signing access tokens |
| `JWT_REFRESH_SECRET` | (set in .env) | Secret for signing refresh tokens |
| `JWT_ACCESS_EXPIRY` | `15m` | Access token lifetime |
| `JWT_REFRESH_EXPIRY` | `7d` | Refresh token lifetime |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed CORS origin |

## 📄 License

MIT
