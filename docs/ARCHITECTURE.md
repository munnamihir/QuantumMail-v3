# QuantumMail V2 — Architecture (Server.js aligned)

> **Scope:** This document describes the current QuantumMail V2 architecture as implemented in `server/server.js`.
> It covers identity + org model, key flows, message storage, security controls, and operational endpoints.

---

## 1) High-level System Overview

QuantumMail V2 is an **organization-scoped secure link encryption platform**.

- **Client-side encryption** happens in the browser extension (AES-GCM for payload + RSA-OAEP for key wrapping).
- The server **never needs plaintext**. It stores encrypted payloads + wrapped keys.
- Users are scoped to an **Organization (orgId)**, and access is enforced with:
  - Token auth (HMAC-signed JWT-like token)
  - Org/user membership checks in the org store
  - Per-user wrapped key presence (server only returns wrapped key for the authenticated user)

---

## 2) Components

### A) Chrome Extension (Client)
Responsibilities:
- Generates/holds **device RSA keypair** (private key stays local).
- Registers **public key** to org user profile.
- Encrypts selected email text:
  - Creates a DEK (data encryption key)
  - AES-256-GCM encrypts message content + optional attachment payloads
  - Wraps DEK for each recipient using recipient public key (RSA-OAEP-SHA256)
- Sends encrypted payload to server and receives a secure link: `/m/:msgId`
- On decrypt:
  - Authenticates to server
  - Fetches encrypted payload + wrapped DEK for **current user**
  - Unwraps DEK locally and decrypts content

### B) Portal (Web UI)
Hosted statically via Express:
- `/portal/*` serves admin/member flows and UI pages
- `/m/:id` serves `decrypt.html` (decrypt landing page)
- `/portal/setup-admin.html` is the admin setup workflow page (email + OTP + set password)

### C) Node/Express Server (Render)
Responsibilities:
- Auth + org policy enforcement
- Org lifecycle (requests, approvals, setup tokens)
- Invite-based signup
- Secure encrypted message storage (at-rest sealing via KEK)
- Audit logs + analytics
- Superadmin company/org overview endpoints

### D) Postgres (Neon)
Used for **durable workflow tables**:
- org requests
- setup tokens (admin setup + OTP verification)
- companies table

### E) Org Store (JSONB-backed `qm_org_store`)
Used for **durable org state**:
- users + roles + status
- invites
- policies
- audit log
- keyring (KEK versions)
- encrypted messages map

---

## 3) Data Model

### Postgres Tables (created in `ensureTables()`)

#### `qm_org_requests`
Tracks incoming org requests:
- pending | approved | rejected
- company_id, company_name
- requester details
- approved_org_id + approved_admin_user_id
- email delivery status fields (email_sent_at, email_last_error, email_last_type)

#### `qm_setup_tokens`
Stores one-time setup tokens (hash only) + OTP verification fields:
- token_hash = sha256(token) (raw token never stored)
- email verification:
  - otp_hash (HMAC-SHA256 with TOKEN_SECRET)
  - otp_expires_at, otp_sent_at
  - otp_attempts, otp_last_attempt_at
- context:
  - email, org_name, admin_username

#### `qm_companies`
Company list for SuperAdmin:
- company_id, company_name

---

### Org Store JSON Shape (`qm_org_store.data`)

Key fields used by server:
- `orgId` (row key)
- `orgName`
- `companyId`, `companyName`
- `users[]`:  
  - userId, username, email, role (Admin|Member|SuperAdmin), status (Active|Disabled|PendingSetup)
  - passwordHash (sha256)
  - publicKeySpkiB64 + publicKeyRegisteredAt
  - lastLoginAt
- `invites{ code -> invite }`:
  - role, email(optional), createdAt, expiresAt, usedAt, usedByUserId
- `policies`:
  - forceAttachmentEncryption
  - disablePassphraseMode
  - enforceKeyRotationDays
  - requireReauthForDecrypt
- `audit[]`: rolling list (max 2000)
- `keyring`:
  - active version string (e.g. "1")
  - keys[version] = { kekB64, status, createdAt, activatedAt, retiredAt }
- `messages{ msgId -> record }`:
  - createdAt
  - kekVersion
  - sealed { ivB64, ctB64, tagB64 }  // AES-GCM sealed server-side
  - createdByUserId, createdByUsername

---

## 4) Identity & Auth

### Token format (minimal JWT-like)
Server signs a token:
- header: `{ alg: "HS256", typ: "JWT" }`
- payload: `{ userId, orgId, role, username, iat, exp }`
- signature: HMAC-SHA256 over `base64url(header).base64url(payload)`

Validation:
- signature must match (timing-safe)
- exp enforced
- org must exist + user must exist and not disabled

Middleware:
- `requireAuth` loads `req.qm = { tokenPayload, org, user }`
- `requireAdmin` role == Admin
- `requireSuperAdmin` orgId == PLATFORM_ORG_ID and role == SuperAdmin

---

## 5) CORS & Deployment Security

CORS is **strict**:
- Allows:
  - `chrome-extension://<QM_EXTENSION_ID>` when configured
  - `QM_ALLOWED_WEB_ORIGINS` list for portal domains
- Blocks everything else in production

Headers allowed:
- `Content-Type`, `Authorization`, `X-QM-Bootstrap`

Portal + message routes disable caching:
- `/portal/*` and `/m/*` have `no-store` headers

---

## 6) Bootstrap Controls (High Privilege)

Bootstrap is protected by:
- `QM_BOOTSTRAP_SECRET` (>=32 chars) via header `X-QM-Bootstrap`
- Rate limited: 10 attempts / 15 minutes per IP

Endpoints:
- `POST /bootstrap/superadmin`  
  Creates the first SuperAdmin inside `PLATFORM_ORG_ID`
- `POST /dev/seed-admin`  
  Seeds the first Admin in an org (only if org has no admins)

If `QM_BOOTSTRAP_SECRET` is not set (or too short), bootstrap is disabled and returns 503.

---

## 7) Org Lifecycle

### A) Org Request (Public)
`POST /public/org-requests`
- stores request in `qm_org_requests`
- generates companyId if not provided

### B) Approve/Reject (SuperAdmin)
SuperAdmin actions require:
- user is SuperAdmin
- token orgId == `QM_PLATFORM_ORG_ID`

`GET  /super/org-requests?status=pending|approved|rejected`  
`POST /super/org-requests/:id/approve`
- Creates org admin user with status `PendingSetup`
- Ensures org keyring exists
- Writes org’s company info into org store
- Mints a **setup token** (hash stored in DB)
- Emails setup link using `approvalEmail()` via `sendMail()`

`POST /super/org-requests/:id/reject`
- Marks request rejected + emails rejection template

Resend:
- `POST /super/org-requests/:id/resend-approval-email`
  - Always mints a **fresh token + link** (raw token cannot be recovered)
- `POST /super/org-requests/:id/resend-reject-email`

---

## 8) Admin Setup Flow (OTP + Password)

Purpose: activate the initial Admin user safely.

Steps:
1) `GET /public/setup-admin-info?orgId&token`  
   - validates token hash + expiry + not used  
   - returns orgName, adminUsername, email, emailVerified

2) `POST /auth/setup-admin/send-code { orgId, token }`  
   - generates 6-digit OTP
   - stores `otp_hash = HMAC(code)` with TOKEN_SECRET
   - emails OTP via `sendMail()`
   - throttled: 30 seconds

3) `POST /auth/setup-admin/verify-code { orgId, token, code }`  
   - max 8 attempts
   - verifies OTP and sets `email_verified_at`

4) `POST /auth/setup-admin { orgId, token, newPassword }`  
   - requires verified email
   - sets admin passwordHash (sha256)
   - sets status `Active`
   - marks token used

---

## 9) User Signup + Invites

### Invite creation (Admin)
`POST /admin/invites/generate`
- role: Admin or Member
- optional email binding
- expiry window in minutes
- stores invite in org store
- audit: `invite_generate`

`GET /admin/invites` returns recent invite list

### Signup via invite (Public Auth)
`POST /auth/signup { orgId, inviteCode, username, email, password }`
- checks invite exists + not expired + not used
- if invite has email, must match
- enforces password length >= 12
- creates user Active immediately
- marks invite used
- audit: `signup_via_invite`

---

## 10) Login & Password Management

### Login
`POST /auth/login { orgId, username, password }`
- loads org + user
- blocks `PendingSetup`
- compares sha256(password) timing-safe
- issues token valid for 8 hours
- audit: `login` or `login_failed`

### Current user
`GET /auth/me` (requiresAuth)

### Change password
`POST /auth/change-password`
- requires current password match
- new password >= 12 and must differ
- audit: `change_password` / `change_password_failed`

---

## 11) Public Key Registration

Purpose: allow encrypting to a user.

`POST /org/register-key { publicKeySpkiB64 }` (requiresAuth)
- saves key on user
- sets publicKeyRegisteredAt
- audit: `pubkey_register`

`GET /org/users` (requiresAuth)
- returns users with `hasPublicKey` flags for recipient UI

---

## 12) Message Storage & Retrieval (Secure Links)

### Core idea
Server stores encrypted payloads in org store but seals them with a server-side KEK:
- Client payload remains encrypted with DEK (AES-GCM)
- Server additionally encrypts the stored record with KEK (AES-256-GCM)
- This protects encrypted blobs at rest against direct JSONB leakage

### KEK Keyring
- `org.keyring.active` selects active version (default "1")
- stored as `kekB64` per version
- record stores `kekVersion`

### Create message
`POST /api/messages` (requiresAuth)

Requires:
- `iv`, `ciphertext`, `wrappedKeys` (map userId -> wrappedDEK)
Optional:
- `aad`
- `attachments[]` (each may include iv/ciphertext/metadata)

Policy enforcement:
- if `forceAttachmentEncryption == true`
  - attachments must be array
  - each attachment must contain iv + ciphertext

Processing:
- `sealWithKek(activeKek, { iv, ciphertext, aad, wrappedKeys, attachments })`
- stores in `org.messages[msgId]`
- audit: `encrypt_store` with attachment metrics
- returns link: `${base}/m/${msgId}`

### Inbox view
`GET /api/inbox` (requiresAuth)
- returns only messages where `wrappedKeys[userId]` exists
- includes from, createdAt, attachment counts

### Fetch message payload for decrypt
`GET /api/messages/:id` (requiresAuth)
- opens sealed record with correct KEK version
- checks `wrappedKeys[userId]` exists
  - if missing: audit `decrypt_denied` and 403
- audit `decrypt_payload`
- returns: iv, ciphertext, aad, wrappedDek (for current user), attachments

---

## 13) Audit, Alerts, Analytics (Admin)

### Audit log (durable via org store)
Every important action inserts an audit entry:
- action + timestamp + ip + user-agent + details
- capped to 2000 entries per org

Endpoints:
- `GET /admin/audit?limit=200`
- `GET /admin/alerts?minutes=60`
  - detects:
    - login_failed (high)
    - decrypt_denied (critical)
    - clear_user_pubkey (medium)

### Policies
- `GET /admin/policies`
- `POST /admin/policies`
  - updates policy fields
  - audit: `policies_update`

### Analytics (portal charts)
`GET /admin/analytics?days=7&staleKeyDays=90`
Returns:
- counts: encrypted, decrypts, denied, failedLogins
- seats: totalUsers, activeUsers, keyCoveragePct
- invites: active/used/expired
- keyHealth:
  - missingKeys
  - staleKeys
- activitySeries for charts
- topUsers by usage

---

## 14) SuperAdmin Company/Org Insights

### Company overview (computed)
`GET /super/companies/overview`
- reads approved org requests from Postgres
- loads each org JSON to compute:
  - seats: totalUsers, admins, members, key coverage %
  - lastActivityAt (from lastLoginAt or audit)

### Orgs by companyId
`GET /super/companies/:companyId/orgs`
- queries `qm_org_store` by `data->>'companyId'`

> Note: There is also a `GET /super/companies` endpoint in server.js, but its SQL appears unfinished/incorrect and may need a fix to properly count orgs per company.

---

## 15) Static Routing

- `/portal` → static portal directory
- `/m/:id` → serves `/portal/decrypt.html`
- `/` → redirects to `/portal/index.html`
- `/outlook-addin` → static add-in directory

Cache-control disabled for `/portal/*` and `/m/*`.

---

## 16) Threat Model Notes (Current Mitigations)

✅ **Server cannot decrypt message content**
- Only encrypted payloads stored + per-user wrapped DEK
- Decryption requires client private key

✅ **At-rest protection**
- Stored encrypted message blobs are additionally sealed using org KEK AES-GCM

✅ **Org isolation**
- `requireAuth` loads org by `orgId` from token and verifies membership

✅ **Recipient enforcement**
- Server only returns wrapped key for the authenticated user

✅ **Bootstrap hardening**
- secret header + rate limit + can be disabled entirely

✅ **OTP for initial admin setup**
- email verification before password set
- hashed OTP using HMAC with TOKEN_SECRET (not reversible)
- attempt limits + expiry

---

## 17) Key Environment Variables

Required:
- `QM_PLATFORM_ORG_ID` — platform org for SuperAdmin
- `QM_TOKEN_SECRET` — HMAC signing secret (>=32 chars)
- `QM_ALLOWED_WEB_ORIGINS` — required in prod; comma-separated origins
- `DATABASE_URL` (Neon) — used by `pool` in db.js (implied)

Recommended:
- `QM_EXTENSION_ID` — chrome extension id for CORS allow
- `QM_BOOTSTRAP_SECRET` — enables bootstrap routes (>=32 chars)
- `PUBLIC_BASE_URL` — used by recovery routes (if configured)

---

## 18) Endpoints (Quick Index)

Public:
- `POST /public/org-requests`
- `GET  /org/check`
- `GET  /org/check-username`
- `GET  /public/setup-admin-info`
- `POST /auth/setup-admin/send-code`
- `POST /auth/setup-admin/verify-code`
- `POST /auth/setup-admin`

Auth:
- `POST /auth/login`
- `GET  /auth/me`
- `POST /auth/change-password`
- `POST /auth/signup`

Org:
- `GET  /org/me`
- `POST /org/register-key`
- `GET  /org/users`

Admin:
- `POST /admin/invites/generate`
- `GET  /admin/invites`
- `GET  /admin/users`
- `GET  /admin/audit`
- `GET  /admin/alerts`
- `GET  /admin/policies`
- `POST /admin/policies`
- `GET  /admin/analytics`

SuperAdmin:
- `GET  /super/org-requests`
- `POST /super/org-requests/:id/approve`
- `POST /super/org-requests/:id/reject`
- `POST /super/org-requests/:id/resend-approval-email`
- `POST /super/org-requests/:id/resend-reject-email`
- `GET  /super/companies/overview`
- `GET  /super/companies/:companyId/orgs`

Bootstrap (requires X-QM-Bootstrap):
- `POST /bootstrap/superadmin`
- `POST /dev/seed-admin`

Messages:
- `POST /api/messages`
- `GET  /api/inbox`
- `GET  /api/messages/:id`

Static:
- `/portal/*`
- `/m/:id`
- `/outlook-addin/*`

---

## 19) What’s Next (Recommended Enhancements)

- Fix/replace `GET /super/companies` SQL to correctly compute org counts.
- Add KEK rotation endpoint (Admin or SuperAdmin) + re-seal older messages.
- Add optional per-message access policy enforcement:
  - `requireReauthForDecrypt` (server-side enforcement)
  - expiring message links
- Add rate limits for `/auth/login` and `/api/messages/:id` to reduce brute force + abuse.
