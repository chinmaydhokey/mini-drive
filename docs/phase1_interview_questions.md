# Phase 1 — Interview Questions & Answers

Questions an interviewer might ask about the authentication system, project architecture, and design decisions in Phase 1. Answers reference the actual codebase.

---

## Category 1: JWT & Authentication (10 Questions)

### Q1. Why do you use two separate tokens (access + refresh) instead of just one?

**Answer:** It's a security-versus-UX tradeoff.

- The **access token** is short-lived (15 min). It travels in every API request via the `Authorization` header, so it's exposed to potential interception. If stolen, the attacker has only a 15-minute window.
- The **refresh token** is long-lived (7 days) but has restricted exposure — it's stored in an `httpOnly` cookie (immune to XSS/JavaScript theft) and is only sent to `/api/auth/*` endpoints (via `path: '/api/auth'` on the cookie).

If we used a single long-lived token, a single theft would give 7 days of access. With the dual-token approach, stealing the access token gives 15 minutes, and stealing the refresh token is much harder because JavaScript can't read httpOnly cookies.

**Code reference:** [authController.js](file:///d:/Distributed%20File%20System%20Project/services/api-server/src/controllers/authController.js) — `setRefreshCookie()` function, line ~155.

---

### Q2. What is token rotation and why did you implement it?

**Answer:** Token rotation means every time the client uses a refresh token to get new tokens, **both** the access token and refresh token are replaced. The old refresh token is immediately invalidated (overwritten in the DB).

**Why it matters:** If an attacker steals a refresh token and uses it, the legitimate user's next refresh attempt will fail (because the token in the DB no longer matches). This is a **reuse detection** mechanism. When reuse is detected, we invalidate all tokens for that user as a safety measure:

```javascript
// From authController.js — refresh()
if (user.refreshToken !== hashedIncoming) {
  // Possible token theft — invalidate everything
  user.refreshToken = null;
  await user.save();
  throw new AppError('Refresh token reuse detected. All sessions invalidated.', 401);
}
```

Without rotation, a stolen refresh token could be used silently for 7 days without detection.

---

### Q3. Why do you hash the refresh token before storing it in MongoDB?

**Answer:** Defense in depth. If the database is compromised (SQL injection, backup leak, insider threat), the attacker gets SHA-256 hashes, not usable tokens. Since SHA-256 is a one-way function, they can't reverse it to get the actual refresh token.

This is the same principle as hashing passwords — never store secrets in plaintext. The access token isn't stored in the DB at all (it's stateless and verified purely by signature), so only the refresh token needs this treatment.

```javascript
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
```

---

### Q4. What happens if the access token expires while the user is active?

**Answer:** The client detects the `401 Token expired` response and silently calls `POST /api/auth/refresh` with the refresh token. If the refresh token is valid, the server issues a new access + refresh token pair. The client retries the original request with the new access token — the user never sees a login screen.

This is typically implemented with an **Axios interceptor** on the frontend (Phase 5):
```javascript
// Frontend interceptor pattern (not built yet)
axios.interceptors.response.use(null, async (error) => {
  if (error.response.status === 401 && !error.config._retry) {
    error.config._retry = true;
    const { data } = await axios.post('/api/auth/refresh');
    setAccessToken(data.accessToken);
    return axios(error.config); // retry original request
  }
  throw error;
});
```

---

### Q5. Why is the JWT payload `{ userId, role }` and not the entire user object?

**Answer:** Three reasons:

1. **Size:** JWTs are sent in every HTTP request header. A fat payload increases bandwidth. `{ userId, role }` is ~50 bytes; a full user object could be 500+ bytes.
2. **Staleness:** JWT data is frozen at sign-time. If the user changes their email or username, the JWT still has the old values until it expires. By storing only `userId`, we fetch fresh data from the DB when needed (like in `GET /me`).
3. **Security:** Less sensitive data in the token means less damage if it's intercepted. The token doesn't contain email, password hash, or storage details.

We include `role` because it's needed for authorization checks (admin vs user) on every request, and it changes very rarely.

---

### Q6. What's the difference between authentication and authorization in your codebase?

**Answer:**
- **Authentication** = "Who are you?" — Handled by `authenticate` middleware in [auth.js](file:///d:/Distributed%20File%20System%20Project/services/api-server/src/middleware/auth.js). It verifies the JWT and attaches `req.user = { userId, role }`.
- **Authorization** = "What are you allowed to do?" — Handled by `requireAdmin` middleware (same file). It checks `req.user.role === 'admin'`.

Authentication always runs first. Authorization depends on the route:
```javascript
// Public route — no auth
router.post('/login', authController.login);

// Authenticated route — any logged-in user
router.get('/me', authenticate, authController.getMe);

// Authorized route — admin only
router.get('/admin/users', authenticate, requireAdmin, adminController.listUsers);
```

---

### Q7. Why do you verify the user still exists in the database during every authenticated request?

**Answer:** Because the JWT might have been issued before the user was deleted or deactivated. The token is still cryptographically valid (it hasn't expired and the signature is correct), but the user no longer should have access.

```javascript
// From auth.js middleware
const user = await User.findById(decoded.userId).select('_id role isActive');
if (!user) throw new AppError('User no longer exists.', 401);
if (!user.isActive) throw new AppError('Account has been deactivated.', 403);
```

This is a trade-off: it adds a DB query to every request. In Phase 7, we'll cache this in Redis (TTL: 2 min) so it's nearly free for active users.

---

### Q8. How would you handle multiple devices/sessions?

**Answer:** Currently, each new login overwrites the stored refresh token, so only the **last device** can refresh. Earlier devices get logged out when they try to refresh.

To support multiple simultaneous sessions, I'd change `user.refreshToken` (a single string) to a `refreshTokens` array or a separate `sessions` collection:

```javascript
// Future: sessions collection
{
  userId: ObjectId,
  refreshTokenHash: String,
  deviceInfo: String,     // "Chrome on Windows"
  ipAddress: String,
  createdAt: Date,
  lastUsedAt: Date
}
```

This lets users see "active sessions" and revoke specific devices (like Google's session management).

---

### Q9. What is the JWT secret and what happens if it's compromised?

**Answer:** The JWT secret (`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`) is the symmetric key used to sign and verify tokens. It's loaded from environment variables, never hardcoded.

If compromised, an attacker can **forge any token** — they can create tokens for any userId with any role. Recovery steps:
1. Rotate the secret immediately (change env var, redeploy)
2. All existing tokens instantly become invalid (signatures won't verify against the new secret)
3. All users must re-login

That's why we use **two separate secrets** — even if one leaks, the other is still safe.

---

### Q10. Why not use sessions (server-side) instead of JWT?

**Answer:** JWTs make the API server **stateless** — any server instance can verify the token independently using only the secret key. This is critical for our distributed architecture:

| | Sessions | JWT |
|---|---|---|
| State | Server holds session data (memory/Redis) | Token is self-contained |
| Scaling | Need sticky sessions or shared session store | Any server handles any request |
| Load balancing | Complicated (session affinity) | Simple (round-robin) |
| Mobile clients | Awkward (cookies don't work well) | Natural (Bearer header) |

Since we'll have multiple API servers behind Nginx (Phase 7), stateless JWT means Nginx can freely round-robin without worrying about which server has which session.

---

## Category 2: bcrypt & Password Security (5 Questions)

### Q11. Why bcrypt over SHA-256 or MD5 for password hashing?

**Answer:** bcrypt is purpose-built for passwords. SHA-256 and MD5 are designed to be **fast** (billions of hashes/second on a GPU), which makes brute-force attacks trivial. bcrypt is intentionally **slow** and has three critical properties:

1. **Built-in salt:** Each hash includes a random salt, so identical passwords produce different hashes. No rainbow table attacks.
2. **Configurable cost factor:** Our 12 rounds means ~250ms per hash. An attacker trying 1 billion passwords would need ~8 years on a single core.
3. **Adaptive:** As hardware gets faster, increase the rounds (13, 14...) without changing any code.

```javascript
const SALT_ROUNDS = 12; // ~250ms on modern hardware
```

---

### Q12. Why 12 salt rounds specifically?

**Answer:** It's a latency-vs-security trade-off:

| Rounds | Time per hash | Brute-force 1B passwords |
|---|---|---|
| 10 | ~60ms | ~2 years |
| **12** | **~250ms** | **~8 years** |
| 14 | ~1s | ~32 years |
| 16 | ~4s | ~128 years |

At 12 rounds, a login request takes ~250ms for password verification — fast enough that users don't notice, slow enough that brute-force is impractical. Going higher (14+) would make login feel sluggish.

---

### Q13. Why does the pre-save hook check `isModified('passwordHash')`?

**Answer:** Without this check, the password would be **double-hashed** every time the user document is saved for any reason (updating email, storage quota, refresh token, etc.). The pre-save hook runs on every `.save()` call, but we only want to hash when the password is actually being set or changed.

```javascript
userSchema.pre('save', async function () {
  if (!this.isModified('passwordHash')) return; // Skip if password didn't change
  this.passwordHash = await bcrypt.hash(this.passwordHash, SALT_ROUNDS);
});
```

---

### Q14. Why is the field called `passwordHash` instead of `password`?

**Answer:** Naming it `passwordHash` makes the intent explicit — this field stores a **hash**, never a plaintext password. It prevents accidental misuse:
- A developer won't accidentally log `user.password` thinking it's safe
- Code reviews catch `user.passwordHash = req.body.password` (plaintext going into a "hash" field) — the pre-save hook handles the actual hashing
- The `toSafeObject()` method knows to strip it from API responses

---

### Q15. How does `bcrypt.compare()` work if each hash has a different salt?

**Answer:** The salt is embedded in the hash string itself. A bcrypt hash looks like:

```
$2b$12$LJ3m4ys3Lg.Nz2yRYfNqWOeKzVkfMKGd3N7/mZn5RXqXBY1E.6XqG
 │   │  │                    │
 │   │  │                    └── Hash output
 │   │  └── 22-char salt (base64)
 │   └── Cost factor (12 rounds)
 └── Algorithm version (2b)
```

`bcrypt.compare(password, hash)` extracts the salt and cost factor from the stored hash, hashes the candidate password with those same parameters, and checks if the output matches. No need to store the salt separately.

---

## Category 3: Express.js Architecture & Middleware (7 Questions)

### Q16. Explain the middleware execution order in your app.

**Answer:** Middleware runs top-to-bottom in the order registered in `app.js`:

```
Request → helmet (security headers)
        → cors (origin check)
        → morgan (request logging)
        → express.json (parse body)
        → express.urlencoded (parse form data)
        → cookieParser (parse cookies)
        → Route matching:
            → validators (check input format)
            → handleValidation (reject if invalid)
            → authenticate (verify JWT)
            → controller (business logic)
        → 404 handler (if no route matched)
        → errorHandler (if any middleware threw)
```

Order matters. For example, `express.json()` must run before route handlers, or `req.body` is undefined. `errorHandler` must be **last** — Express only sends errors to 4-argument middleware.

---

### Q17. Why is `errorHandler` a 4-argument function?

**Answer:** Express identifies error-handling middleware by its function signature: `(err, req, res, next)`. When any middleware or route handler calls `next(error)` or throws an error, Express skips all regular middleware and jumps to the next error-handling middleware (4 args).

If I wrote it as `(req, res, next)` (3 args), Express would treat it as regular middleware and it would never receive errors.

---

### Q18. What's the purpose of the `AppError` class?

**Answer:** It's a custom error class that attaches an HTTP status code to the error:

```javascript
throw new AppError('User not found.', 404);
throw new AppError('Invalid token.', 401);
```

Without it, all errors would become `500 Internal Server Error` because native JavaScript errors don't have a status code. The global `errorHandler` reads `err.statusCode` to send the correct HTTP status.

The `isOperational` flag distinguishes expected errors (bad input, auth failures) from programming bugs (null reference, type errors). In production, you'd only show operational error messages to users and log the rest.

---

### Q19. Why do you separate routes, controllers, and middleware into different files?

**Answer:** **Separation of concerns** — each layer has one job:

| Layer | Responsibility | Example |
|---|---|---|
| **Route** | Define URL patterns and wire middleware chain | "POST /register uses these validators, then this controller" |
| **Validator** | Check input shape/format (pure data validation) | "email must be valid, password must have 8+ chars" |
| **Middleware** | Cross-cutting concerns (auth, logging, error handling) | "Verify JWT and attach userId to request" |
| **Controller** | Business logic and response formatting | "Find user, compare password, generate tokens, return response" |

Benefits:
- **Testable:** You can unit-test a controller by mocking `req`/`res` without setting up routes
- **Reusable:** The `authenticate` middleware works on any route, not just auth
- **Readable:** A route file reads like a table of contents; the logic lives elsewhere

---

### Q20. What does `express-validator` do differently from Mongoose validation?

**Answer:** They validate at different layers:

| | express-validator | Mongoose validation |
|---|---|---|
| **When** | Before controller runs (middleware) | When `.save()` is called |
| **What** | Request body shape and format | Data model constraints |
| **Failure** | Returns 400 immediately, controller never runs | Throws `ValidationError`, caught by error handler |
| **Purpose** | Reject bad input early (fail fast) | Enforce data integrity as a safety net |

Having both is **defense in depth**. If someone bypasses the API and writes directly to MongoDB (admin script, migration), Mongoose validation still protects the data.

---

### Q21. Why use `express.json({ limit: '10mb' })` instead of the default?

**Answer:** Express's default body size limit is `100kb`. In later phases, API requests might include base64-encoded file metadata, large JSON manifests, or batch operations. 10 MB gives headroom without being dangerously large.

For actual file uploads (Phase 2+), we use `multer` which handles multipart/form-data separately — those bypass the JSON body parser entirely.

---

### Q22. What's the request-response cycle for `POST /api/auth/register`?

**Answer:** Step by step through the middleware chain:

```
1. helmet()          → Adds security headers (X-Content-Type-Options, etc.)
2. cors()            → Checks Origin header against allowed frontend URL
3. morgan('dev')     → Logs: "POST /api/auth/register"
4. express.json()    → Parses JSON body → req.body = { email, username, password }
5. cookieParser()    → Parses cookies (none for registration)
6. Router matches    → /api/auth/register → auth route
7. validators.register → express-validator checks email, username, password format
8. handleValidation  → If validation errors → throws AppError(400)
9. authController.register:
   a. Check duplicate email/username in MongoDB
   b. Create User document (pre-save hook hashes password)
   c. Generate access + refresh tokens
   d. Hash refresh token, save to user document
   e. Set httpOnly cookie with refresh token
   f. Respond 201 with user + tokens
10. morgan          → Logs: "POST /api/auth/register 201 278.708 ms"
```

If any step throws, execution jumps to `errorHandler` which formats the error as JSON.

---

## Category 4: MongoDB & Mongoose (5 Questions)

### Q23. Why MongoDB over PostgreSQL for this project?

**Answer:** Four specific reasons for a file storage system:

1. **Schema flexibility:** File metadata varies by type (images have dimensions, videos have duration, docs have page count). MongoDB's schemaless documents handle this without ALTER TABLE migrations.
2. **Hierarchical data:** Folder trees use materialized paths (`/root/docs/work`). In MongoDB, a prefix regex query (`/^\/root\/docs/`) finds all descendants. In SQL, you'd need recursive CTEs.
3. **Embedded documents:** A chunk's replica locations are embedded as an array inside the chunk document. One read gets everything. In SQL, this would be a 3-table JOIN (files → chunks → replicas).
4. **JSON-native:** Node.js and Express work with JSON. MongoDB stores BSON (binary JSON). No ORM impedance mismatch.

**Trade-off acknowledged:** MongoDB's eventual consistency means a brief window where reads after writes might hit a stale secondary. For auth, we read from the primary.

---

### Q24. What does `unique: true` on a Mongoose field do under the hood?

**Answer:** It creates a **unique index** in MongoDB. When you try to insert a document with a duplicate value in that field, MongoDB rejects it with error code `11000` (duplicate key error). 

Our error handler catches this:
```javascript
if (err.code === 11000) {
  statusCode = 409;
  const field = Object.keys(err.keyValue)[0];
  message = `${field} already exists.`;
}
```

Important: `unique` is an **index property**, not a validator. It's enforced at the database level, not by Mongoose. If you have existing duplicates, adding `unique: true` won't retroactively clean them.

---

### Q25. What is `toSafeObject()` and why not just use `.lean()` or `select('-passwordHash')`?

**Answer:** All three approaches serve different purposes:

| Method | How | When to use |
|---|---|---|
| `.select('-passwordHash')` | Excludes field at query time | When you never need the field (e.g., listing users) |
| `.lean()` | Returns plain JS object instead of Mongoose document | When you don't need Mongoose methods (faster) |
| `toSafeObject()` | Instance method that strips multiple sensitive fields | When you already have the full document and need to sanitize for API response |

`toSafeObject()` is useful because sometimes we need `passwordHash` for comparison (login), but then want to send the user without it in the response. It also strips `refreshToken`, `mfaSecret`, and `__v` — more fields than a simple `-passwordHash` select.

---

### Q26. Why do you use `mongoose.connect()` in a separate `db.js` file?

**Answer:** Separation of concerns and testability:
- `config/db.js` handles **connection** (connect, log events, exit on failure)
- `config/index.js` handles **configuration** (env vars, defaults)
- `app.js` handles **application setup** (middleware, routes)

This way, in tests, you can connect to a test database by importing `db.js` with a different `MONGO_URI`, without touching the app setup. It also keeps `app.js` clean — the connection logic (retry, event listeners, error handling) is tucked away.

---

### Q27. What are the extension point fields (`encryptionPublicKey`, `mfaSecret`, `preferences`) for?

**Answer:** They're **schema placeholders** for future features. By adding them now:
- No database migration needed later (MongoDB is flexible, but it's still better to plan ahead)
- The field names and types are documented in the codebase
- Other developers can see what's planned just by reading the model

For example, `encryptionPublicKey` is for Phase 21 (E2E encryption), `mfaSecret` is for future 2FA, and `preferences` is a flexible object for notification settings, theme preferences, etc.

They all default to `null` or `{}`, so they take no space until used (MongoDB doesn't store `null` fields in BSON).

---

## Category 5: Security & Error Handling (5 Questions)

### Q28. What does `helmet()` do and why is it the first middleware?

**Answer:** Helmet sets 11+ HTTP security headers in one line. Key ones:

| Header | Purpose |
|---|---|
| `X-Content-Type-Options: nosniff` | Prevents browsers from MIME-sniffing (treating a .txt as .exe) |
| `X-Frame-Options: DENY` | Prevents clickjacking (embedding your site in an iframe) |
| `Strict-Transport-Security` | Forces HTTPS after first visit |
| `X-XSS-Protection` | Enables browser's XSS filter |
| `Content-Security-Policy` | Controls which resources the page can load |

It's first because security headers must be set **before** any response is sent. If a later middleware responds with an error, the headers are still present.

---

### Q29. How do you prevent timing attacks on login?

**Answer:** Timing attacks exploit the fact that "user not found" returns faster than "wrong password" (because bcrypt is slow). An attacker can determine which emails are registered by measuring response times.

Currently, our login has this vulnerability:
```javascript
const user = await User.findOne({ email }); // Fast if not found
if (!user) throw new AppError('Invalid email or password.', 401); // Returns immediately
const isValid = await user.comparePassword(password); // Slow (bcrypt)
```

**Fix** (could be implemented): Hash a dummy password even when the user isn't found:
```javascript
if (!user) {
  await bcrypt.compare(password, '$2b$12$dummyhashforconstanttime');
  throw new AppError('Invalid email or password.', 401);
}
```

The same error message ("Invalid email or password") is already used for both cases, preventing information leakage in the response body. The timing fix makes it airtight.

---

### Q30. Why do you use generic error messages like "Invalid email or password" instead of "Email not found" or "Wrong password"?

**Answer:** Telling the user **which** field is wrong leaks information:
- "Email not found" → confirms the email is NOT registered (attacker can enumerate valid emails)
- "Wrong password" → confirms the email IS registered (attacker now knows to brute-force this email)

A generic message gives no information about which part failed. This is standard practice (Google, GitHub, AWS all do this).

The exception is registration: "email already exists" is acceptable there because the user needs to know why registration failed, and the existence of an account is somewhat public information anyway.

---

### Q31. What is the CORS configuration doing?

**Answer:** CORS (Cross-Origin Resource Sharing) controls which domains can make API requests from a browser.

```javascript
app.use(cors({
  origin: config.cors.origin,   // 'http://localhost:5173' (React dev server)
  credentials: true,            // Allow cookies (refresh token)
}));
```

Without CORS, a browser would block the React app (on `localhost:5173`) from calling the API (on `localhost:3000`) because they're different origins (different ports).

`credentials: true` is needed because the refresh token is sent as a cookie. Without it, the browser won't include cookies in cross-origin requests.

In production, `origin` would be `'https://drive.example.com'` — only your frontend can call the API. Requests from other domains are rejected.

---

### Q32. Why do you show stack traces only in development?

**Answer:** Stack traces reveal internal file paths, library versions, database structure, and code patterns. An attacker can use this to find vulnerabilities:

```json
// Development (helpful for debugging):
{ "message": "User not found", "stack": "at authController.js:42 → at mongoose/model.js:403..." }

// Production (safe):
{ "message": "User not found" }
```

The toggle:
```javascript
res.status(statusCode).json({
  success: false,
  error: {
    message,
    ...(config.env === 'development' && { stack: err.stack }),
  },
});
```

---

## Category 6: System Design Thinking (5 Questions)

### Q33. Why a monorepo instead of separate repositories for each service?

**Answer:** For this project, monorepo wins on three fronts:

1. **Shared code:** All services will share MongoDB schemas, validation logic, constants, and TypeScript types. In separate repos, you'd need a private npm package — overhead for a portfolio project.
2. **Atomic commits:** When a feature touches the API + frontend + storage node, one commit captures the complete change. In separate repos, you'd need coordinated PRs across 3 repos.
3. **Single docker-compose:** One `docker-compose.yml` at the root orchestrates everything. No git submodules or repo cloning in CI.

**When separate repos make sense:** 100+ engineer teams where services are owned by different teams with different deploy cadences. Not applicable here.

---

### Q34. Why do you have empty directories for `metadata-service`, `storage-node`, `frontend` already?

**Answer:** This is **scaffolding for future phases**. By establishing the directory structure now:
- The monorepo layout is clear from day 1
- `docker-compose.yml` can be planned with the correct build contexts
- Developers (or interviewers) can see the full system scope just from the folder structure
- It prevents structural refactoring later (moving files between directories)

---

### Q35. How would this auth system scale to 1 million users?

**Answer:** The current auth system is already mostly scalable:

| Concern | Current state | At 1M users |
|---|---|---|
| Stateless JWT | ✅ Any server can verify | ✅ No change needed |
| MongoDB lookups | Email/username indexes → O(log n) | ✅ Indexes scale fine to 1M docs |
| bcrypt hashing | 250ms/login | ⚠️ At 1000 concurrent logins, need multiple API servers |
| Refresh token storage | One field per user | ✅ Negligible storage |

The main bottleneck would be **bcrypt CPU usage** during login spikes. Solution: horizontal scaling — add more API server instances behind Nginx. Since the servers are stateless, this is trivial.

---

### Q36. What would you change if this were a production system?

**Answer:** Several hardening steps:

1. **Rate limiting per endpoint:** Login gets 5 attempts/minute per IP (prevent brute force). Currently no rate limiting.
2. **Account lockout:** Lock after 10 failed attempts, unlock after 15 min or admin action.
3. **HTTPS everywhere:** Currently HTTP in dev. Production needs TLS certificates on Nginx.
4. **Secret management:** Move JWT secrets from `.env` to AWS Secrets Manager or HashiCorp Vault.
5. **Logging:** Structured JSON logs (Winston/Pino) instead of `console.log`. Ship to ELK/CloudWatch.
6. **Monitoring:** Health check endpoint for load balancer + APM (Datadog/New Relic).
7. **Password reset flow:** Email-based password reset with time-limited tokens.
8. **Input sanitization:** Add `mongo-sanitize` to prevent NoSQL injection via `$gt`, `$ne` operators.

---

### Q37. Walk me through what happens if MongoDB goes down while a user is registering.

**Answer:** Here's the exact failure path:

1. User sends `POST /api/auth/register`
2. Controller calls `user.save()` → Mongoose tries to write to MongoDB
3. MongoDB is down → Mongoose throws a connection error
4. The `try/catch` in the controller catches it → passes to `next(error)`
5. `errorHandler` middleware receives it → it's not a validation/duplicate/cast error → status 500
6. User gets: `{ "success": false, "error": { "message": "Internal Server Error" } }`
7. Meanwhile, `mongoose.connection.on('disconnected', ...)` logs a warning
8. Mongoose has built-in reconnection (default: tries indefinitely with exponential backoff)
9. Once MongoDB recovers, the next request works normally

**Data consistency:** The user was never created (the write failed atomically). The tokens were generated in memory but never persisted. The client received an error, so they'll retry. No partial state.
