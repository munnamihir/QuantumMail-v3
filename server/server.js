// server/server.js
import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import cors from "cors";

import { pool } from "./db.js"; // Neon/PG pool
import { peekOrg, getOrg, saveOrg } from "./orgStore.js"; // JSONB org store
import { sendMail } from "./mailer.js"; // single source of truth for email sending
import { approvalEmail, rejectionEmail } from "./emailTemplates.js";
import { recoveryRoutes } from "./routes/recovery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* =========================================================
   ENV (Render / Neon)
========================================================= */
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const PLATFORM_ORG_ID = process.env.QM_PLATFORM_ORG_ID;
if (!PLATFORM_ORG_ID) throw new Error("QM_PLATFORM_ORG_ID is required.");

const TOKEN_SECRET = process.env.QM_TOKEN_SECRET;
if (!TOKEN_SECRET || TOKEN_SECRET.length < 32) {
  throw new Error("QM_TOKEN_SECRET is required and must be >= 32 chars.");
}

const EXTENSION_ID = process.env.QM_EXTENSION_ID || ""; // optional in dev, recommended in prod

const ALLOWED_WEB_ORIGINS = (process.env.QM_ALLOWED_WEB_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (IS_PROD && ALLOWED_WEB_ORIGINS.length === 0) {
  throw new Error("QM_ALLOWED_WEB_ORIGINS is required in production (comma-separated).");
}

const BOOTSTRAP_SECRET = process.env.QM_BOOTSTRAP_SECRET || "";
const BOOTSTRAP_ENABLED = BOOTSTRAP_SECRET.length >= 32;

/* =========================================================
   Helpers
========================================================= */
function nowIso() {
  return new Date().toISOString();
}

function timingSafeEq(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function sha256(s) {
  return sha256Hex(s);
}

function b64urlEncode(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecodeToString(s) {
  const str = String(s || "");
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

function bytesToB64(buf) {
  return Buffer.from(buf).toString("base64");
}
function b64ToBytes(b64) {
  return Buffer.from(String(b64 || ""), "base64");
}

function getPublicBase(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function defaultPolicies() {
  return {
    forceAttachmentEncryption: false,
    disablePassphraseMode: false,
    enforceKeyRotationDays: 0,
    requireReauthForDecrypt: true,
  };
}

/* =========================================================
   OTP helpers (email verification)
========================================================= */
function genOtp6() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

function otpHash(code) {
  // HMAC with TOKEN_SECRET so OTP isn't reversible if DB leaked
  return crypto.createHmac("sha256", TOKEN_SECRET).update(String(code)).digest("hex");
}

/* =========================================================
   CORS (strict)
========================================================= */
function isAllowedOrigin(origin) {
  if (!origin) return true; // curl/server-to-server
  if (EXTENSION_ID && origin === `chrome-extension://${EXTENSION_ID}`) return true;
  if (ALLOWED_WEB_ORIGINS.includes(origin)) return true;
  return false;
}

app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-QM-Bootstrap"],
    credentials: false,
  })
);

app.options("*", cors());
app.use(express.json({ limit: "25mb" }));

function hashPassword(pw) {
  return sha256(String(pw || ""));
}

app.use(recoveryRoutes({
  getOrg,
  saveOrg,
  sendMail,
  tokenSecret: TOKEN_SECRET,
  hashPassword, 
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "" 
}));


/* =========================================================
   No-cache for portal + /m
========================================================= */
app.use((req, res, next) => {
  if (req.path.startsWith("/portal") || req.path.startsWith("/m/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

/* =========================================================
   Token (minimal JWT-like HMAC-SHA256)
========================================================= */
function signToken(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(`${h}.${p}`).digest();
  const s = b64urlEncode(sig);
  return `${h}.${p}.${s}`;
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(`${h}.${p}`).digest();
  const expected = b64urlEncode(sig);
  if (!timingSafeEq(expected, s)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(p));
  } catch {
    return null;
  }

  if (payload.exp && Date.now() > payload.exp * 1000) return null;
  return payload;
}

/* =========================================================
   Auth middleware (Postgres-backed org)
========================================================= */
async function requireAuth(req, res, next) {
  try {
    const auth = String(req.headers.authorization || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "Missing Bearer token" });

    const payload = verifyToken(m[1]);
    if (!payload) return res.status(401).json({ error: "Invalid/expired token" });

    const org = await getOrg(payload.orgId);
    if (!org) return res.status(401).json({ error: "Unknown org" });

    const user = (org.users || []).find((u) => u.userId === payload.userId);
    if (!user) return res.status(401).json({ error: "Unknown user" });

    if (String(user.status || "Active").toLowerCase() === "disabled") {
      return res.status(403).json({ error: "User disabled" });
    }

    req.qm = { tokenPayload: payload, org, user };
    next();
  } catch (e) {
    console.error("requireAuth failed:", e);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.qm?.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.qm.user.role !== "Admin") return res.status(403).json({ error: "Admin only" });
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.qm?.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.qm.tokenPayload.orgId !== PLATFORM_ORG_ID) {
    return res.status(403).json({ error: "Super admin only (platform org)" });
  }
  if (req.qm.user.role !== "SuperAdmin") {
    return res.status(403).json({ error: "Super admin only" });
  }
  next();
}

// AUTH: who am I?
// GET /auth/me
app.get("/auth/me", requireAuth, async (req, res) => {
  const { user } = req.qm;
  const orgId = req.qm.tokenPayload.orgId;

  res.json({
    ok: true,
    user: {
      userId: user.userId,
      orgId,
      username: user.username,
      role: user.role,
      status: user.status || "Active",
      hasPublicKey: !!user.publicKeySpkiB64,
      lastLoginAt: user.lastLoginAt || null,
      publicKeyRegisteredAt: user.publicKeyRegisteredAt || null,
    },
  });
});

/* =========================================================
   Bootstrap protection (header secret)
========================================================= */
function requireBootstrapSecret(req, res, next) {
  if (!BOOTSTRAP_ENABLED) {
    return res.status(503).json({ error: "Bootstrap disabled (QM_BOOTSTRAP_SECRET not set or <32)" });
  }
  const provided = String(req.headers["x-qm-bootstrap"] || "");
  if (!provided) return res.status(401).json({ error: "Missing X-QM-Bootstrap header" });
  if (!timingSafeEq(provided, BOOTSTRAP_SECRET)) return res.status(403).json({ error: "Bootstrap denied" });
  next();
}

// rate limit only bootstrap routes
const RATE = new Map(); // ip -> {count, resetAt}
function rateLimitBootstrap(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const limit = 10;

  const cur = RATE.get(ip);
  if (!cur || now > cur.resetAt) {
    RATE.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }
  cur.count++;
  if (cur.count > limit) return res.status(429).json({ error: "Too many bootstrap attempts" });
  next();
}

/* =========================================================
   Audit (durable via saveOrg)
========================================================= */
async function audit(req, orgId, userId, action, details = {}) {
  const org = await getOrg(orgId);
  if (!org) return;

  const entry = {
    id: nanoid(10),
    at: nowIso(),
    orgId,
    userId: userId || null,
    action,
    ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
    ua: req.headers["user-agent"] || "",
    ...details,
  };

  org.audit = Array.isArray(org.audit) ? org.audit : [];
  org.audit.unshift(entry);
  if (org.audit.length > 2000) org.audit.length = 2000;

  await saveOrg(orgId, org);
}

/* =========================================================
   KEK keyring (server-side at-rest encryption)
========================================================= */
function randomKey32() {
  return crypto.randomBytes(32);
}

function sealWithKek(kekBytes, obj) {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from("quantummail:kek:v1", "utf8");

  const cipher = crypto.createCipheriv("aes-256-gcm", kekBytes, iv);
  cipher.setAAD(aad);

  const pt = Buffer.from(JSON.stringify(obj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { ivB64: bytesToB64(iv), ctB64: bytesToB64(ct), tagB64: bytesToB64(tag) };
}

function openWithKek(kekBytes, sealed) {
  const iv = b64ToBytes(sealed.ivB64);
  const ct = b64ToBytes(sealed.ctB64);
  const tag = b64ToBytes(sealed.tagB64);
  const aad = Buffer.from("quantummail:kek:v1", "utf8");

  const decipher = crypto.createDecipheriv("aes-256-gcm", kekBytes, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

function ensureKeyring(org) {
  org.keyring = org.keyring || null;
  if (!org.keyring) {
    const kek = randomKey32();
    org.keyring = {
      active: "1",
      keys: {
        "1": {
          version: "1",
          status: "active",
          createdAt: nowIso(),
          activatedAt: nowIso(),
          retiredAt: null,
          kekB64: bytesToB64(kek),
        },
      },
    };
  }
}

function getActiveKek(org) {
  ensureKeyring(org);
  const v = String(org.keyring.active);
  const k = org.keyring.keys[v];
  return { version: v, kekBytes: b64ToBytes(k.kekB64), meta: k };
}

function getKekByVersion(org, version) {
  ensureKeyring(org);
  const v = String(version);
  const k = org.keyring.keys[v];
  if (!k) return null;
  return { version: v, kekBytes: b64ToBytes(k.kekB64), meta: k };
}

/* =========================================================
   Invite helper
========================================================= */
function genInviteCode() {
  const n = crypto.randomInt(0, 1000000);
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

/* =========================================================
   DB bootstrap (tables)
========================================================= */
async function ensureTables() {
  await pool.query(`
    create table if not exists qm_org_requests (
      id text primary key,
      org_name text not null,
      requester_name text not null,
      requester_email text not null,
      notes text,
      status text not null default 'pending', -- pending|approved|rejected
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      reviewed_by_user_id text,
      reviewed_at timestamptz,
      reject_reason text,
      approved_org_id text,
      approved_admin_user_id text
    );
  `);

  await pool.query(`
    create table if not exists qm_setup_tokens (
      id text primary key,
      org_id text not null,
      user_id text not null,
      token_hash text not null,
      purpose text not null,
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`create index if not exists idx_qm_setup_tokens_org_hash on qm_setup_tokens(org_id, token_hash);`);
  await pool.query(`create index if not exists idx_qm_org_requests_status on qm_org_requests(status, created_at);`);

  await pool.query(`
    alter table qm_org_requests
      add column if not exists email_sent_at timestamptz,
      add column if not exists email_last_error text,
      add column if not exists email_last_type text;
  `);

  // ---- columns for email verification / setup context
  await pool.query(`alter table qm_setup_tokens add column if not exists email text;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists org_name text;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists admin_username text;`);

  await pool.query(`alter table qm_setup_tokens add column if not exists email_verified_at timestamptz;`);

  await pool.query(`alter table qm_setup_tokens add column if not exists otp_hash text;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists otp_expires_at timestamptz;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists otp_sent_at timestamptz;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists otp_attempts int not null default 0;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists otp_last_attempt_at timestamptz;`);
     // Companies table (SuperAdmin can list companies cleanly)
  await pool.query(`
    create table if not exists qm_companies (
      company_id text primary key,
      company_name text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  // Store company on org requests
  await pool.query(`
    alter table qm_org_requests
      add column if not exists company_id text,
      add column if not exists company_name text;
  `);

  await pool.query(`create index if not exists idx_qm_org_requests_company on qm_org_requests(company_id, created_at);`);
     // Query orgs by companyId stored inside JSONB
  await pool.query(`
    create index if not exists idx_qm_org_store_company_id_json
    on qm_org_store ((data->>'companyId'));
  `);
}

await ensureTables();

/* =========================================================
   AUTH: signup via invite code (Member/Admin)
   POST /auth/signup { orgId, inviteCode, username, password }
========================================================= */
app.post("/auth/signup", async (req, res) => {
   const orgId = String(req.body?.orgId || "").trim();
   const inviteCode = String(req.body?.inviteCode || "").trim();
   const username = String(req.body?.username || "").trim();
   const email = String(req.body?.email || "").trim().toLowerCase();
   const password = String(req.body?.password || "");

   if (!orgId || !inviteCode || !username || !email || !password) {
      return res.status(400).json({ error: "orgId, inviteCode, username, email, password required" });
   }
   if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
     return res.status(400).json({ error: "Invalid email format" });
   }
  if (password.length < 12) {
    return res.status(400).json({ error: "Password must be at least 12 characters" });
  }

  const org = await getOrg(orgId);
  org.users = org.users || [];
  org.audit = org.audit || [];
  org.invites = org.invites || {};
  org.policies = org.policies || defaultPolicies();
  ensureKeyring(org);

  const inv = org.invites[inviteCode];
  if (!inv) return res.status(403).json({ error: "Invalid invite code" });

  if (inv.email && inv.email.toLowerCase() !== email.toLowerCase()) {
     return res.status(403).json({ error: "Invite is designated to a different email" });
  }
   
  if (inv.usedAt) return res.status(403).json({ error: "Invite already used" });
  if (Date.parse(inv.expiresAt || "") < Date.now()) return res.status(403).json({ error: "Invite expired" });

  const taken = org.users.some((u) => String(u.username || "").toLowerCase() === username.toLowerCase());
  if (taken) return res.status(409).json({ error: "Username already exists" });

  const userId = nanoid(10);
  const role = inv.role === "Admin" ? "Admin" : "Member";

  org.users.push({
    userId,
    username,
    email,
    passwordHash: sha256(password),
    role,
    status: "Active",
    publicKeySpkiB64: null,
    publicKeyRegisteredAt: null,
    createdAt: nowIso(),
    lastLoginAt: null,
  });

  inv.usedAt = nowIso();
  inv.usedByUserId = userId;

  await audit(req, orgId, userId, "signup_via_invite", { username, role, inviteCode });
  await saveOrg(orgId, org);

  res.json({ ok: true, orgId, userId, username, role });
});

/* =========================================================
   ORG: get my org info (for Profile UI)
   GET /org/me
========================================================= */
app.get("/org/me", requireAuth, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const org = await getOrg(orgId);

  res.json({
    ok: true,
    org: {
      orgId,
      orgName: org.orgName || org.name || orgId,
      companyId: org.companyId || null,
      companyName: org.companyName || null,
    },
  });
});

/* =========================================================
   SUPERADMIN: companies overview
   GET /super/companies/overview
========================================================= */
app.get("/super/companies/overview", requireAuth, requireSuperAdmin, async (req, res) => {
  // 1) Pull approved orgs + company mapping from Postgres
  const { rows } = await pool.query(`
    select
      company_id,
      company_name,
      approved_org_id as org_id
    from qm_org_requests
    where status='approved'
      and approved_org_id is not null
    order by company_name asc, approved_org_id asc
  `);

  // Group: company -> orgIds
  const companiesMap = new Map();
  for (const r of rows) {
    const cid = String(r.company_id || "unknown").trim() || "unknown";
    const cname = String(r.company_name || "Unknown Company").trim() || "Unknown Company";
    const orgId = String(r.org_id || "").trim();
    if (!orgId) continue;

    if (!companiesMap.has(cid)) {
      companiesMap.set(cid, { companyId: cid, companyName: cname, orgs: [] });
    }
    companiesMap.get(cid).orgs.push({ orgId });
  }

  // 2) For each org, read JSONB org and compute metrics
  for (const c of companiesMap.values()) {
    for (const o of c.orgs) {
      let org;
      try {
        org = await getOrg(o.orgId);
      } catch {
        org = null;
      }

      const users = Array.isArray(org?.users) ? org.users : [];
      const totalUsers = users.length;
      const admins = users.filter(u => u.role === "Admin").length;
      const members = users.filter(u => u.role === "Member").length;

      const usersWithKeys = users.filter(u => !!u.publicKeySpkiB64).length;
      const keyCoveragePct = totalUsers ? Math.round((usersWithKeys / totalUsers) * 100) : 0;

      // last activity (best-effort): max(lastLoginAt) or latest audit item
      const lastLoginAt = users
        .map(u => Date.parse(u.lastLoginAt || ""))
        .filter(Number.isFinite)
        .sort((a,b)=>b-a)[0];

      const audit = Array.isArray(org?.audit) ? org.audit : [];
      const lastAuditAt = audit.length ? Date.parse(audit[0]?.at || "") : NaN;

      const lastActivityAtMs = Math.max(
        Number.isFinite(lastLoginAt) ? lastLoginAt : 0,
        Number.isFinite(lastAuditAt) ? lastAuditAt : 0
      );

      o.orgName = org?.orgName || org?.name || o.orgId;
      o.seats = { totalUsers, admins, members, usersWithKeys, keyCoveragePct };
      o.lastActivityAt = lastActivityAtMs ? new Date(lastActivityAtMs).toISOString() : null;
    }
  }

  const companies = Array.from(companiesMap.values()).map(c => ({
    ...c,
    totals: {
      orgs: c.orgs.length,
      seats: c.orgs.reduce((s, o) => s + (o.seats?.totalUsers || 0), 0),
      admins: c.orgs.reduce((s, o) => s + (o.seats?.admins || 0), 0),
      keysPctAvg: c.orgs.length
        ? Math.round(c.orgs.reduce((s, o) => s + (o.seats?.keyCoveragePct || 0), 0) / c.orgs.length)
        : 0
    }
  }));

  res.json({ ok: true, companies });
});


/* =========================================================
   SUPERADMIN: org overview (for /portal/org.js)
   GET /super/orgs/:orgId/overview
========================================================= */
app.get("/super/orgs/:orgId/overview", requireAuth, requireSuperAdmin, async (req, res) => {
  const orgId = String(req.params.orgId || "").trim();
  if (!orgId) return res.status(400).json({ error: "orgId required" });

  let org;
  try {
    org = await getOrg(orgId);
  } catch (e) {
    return res.status(503).json({ error: "Org store unavailable", detail: String(e?.message || e) });
  }
  if (!org) return res.status(404).json({ error: "Org not found" });

  const users = Array.isArray(org.users) ? org.users : [];
  const auditItems = Array.isArray(org.audit) ? org.audit : [];

  const totalUsers = users.length;
  const admins = users.filter(u => u.role === "Admin").length;
  const members = users.filter(u => u.role === "Member").length;

  const usersWithKeys = users.filter(u => !!u.publicKeySpkiB64).length;
  const usersMissingKeys = totalUsers - usersWithKeys;
  const keyCoveragePct = totalUsers ? Math.round((usersWithKeys / totalUsers) * 100) : 0;

  // last activity: max(lastLoginAt) vs latest audit
  const lastLoginAtMs = users
    .map(u => Date.parse(u.lastLoginAt || ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];

  const lastAuditAtMs = auditItems.length ? Date.parse(auditItems[0]?.at || "") : NaN;

  const lastActivityAtMs = Math.max(
    Number.isFinite(lastLoginAtMs) ? lastLoginAtMs : 0,
    Number.isFinite(lastAuditAtMs) ? lastAuditAtMs : 0
  );

  // ----- security/policy (best-effort: map from your org.policies)
  const pol = org.policies || defaultPolicies();
  const security = {
    recoveryEnabled: true,            // you have recovery routes enabled globally; if you store per-org switch later, change here
    linkTtlMinutes: 60,               // if you store TTL later, change here
    requireDeviceKey: !!pol.requireReauthForDecrypt,
    allowedDomains: Array.isArray(org.allowedDomains) ? org.allowedDomains : [], // optional future field
    lastKeyRotationAt: org.keyring?.keys?.[org.keyring?.active]?.activatedAt || null,
  };

  // ----- activity last 30d from audit (matches your org.js expectation)
  const since30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let encrypts30d = 0, decrypts30d = 0, failures30d = 0;
  let setupEmails30d = 0, rejectEmails30d = 0;

  // avg decrypt time (if you later log decryptMs in audit)
  let decryptMsSum = 0, decryptMsCount = 0;

  for (const a of auditItems) {
    const atMs = Date.parse(a.at || "");
    if (!Number.isFinite(atMs) || atMs < since30d) continue;

    if (a.action === "encrypt_store") encrypts30d++;
    if (a.action === "decrypt_payload") {
      decrypts30d++;
      const ms = Number(a.decryptMs);
      if (Number.isFinite(ms) && ms >= 0) { decryptMsSum += ms; decryptMsCount++; }
    }
    if (a.action === "decrypt_denied" || a.action === "login_failed") failures30d++;
    if (a.action === "super_email_approved") setupEmails30d++;   // optional if you add audit entries later
    if (a.action === "super_email_rejected") rejectEmails30d++;  // optional if you add audit entries later
  }

  const activity = {
    encrypts30d,
    decrypts30d,
    failures30d,
    avgDecryptMs: decryptMsCount ? Math.round(decryptMsSum / decryptMsCount) : null,
    setupEmails30d,
    rejectEmails30d,
  };

  // ----- admins list
  const adminsList = users
    .filter(u => u.role === "Admin")
    .map(u => ({
      userId: u.userId,
      username: u.username,
      email: u.email || "",
      status: u.status || "Active",
    }));

  res.json({
    ok: true,
    org: {
      orgId,
      orgName: org.orgName || org.name || orgId,
      companyId: org.companyId || null,
      companyName: org.companyName || null,
      createdAt: org.createdAt || null,
      lastActivityAt: lastActivityAtMs ? new Date(lastActivityAtMs).toISOString() : null,
      notes: org.notes || "",
    },
    counts: {
      totalUsers,
      admins,
      members,
      usersWithKeys,
      usersMissingKeys,
      keyCoveragePct,
    },
    security,
    activity,
    admins: adminsList,
  });
});

/* =========================================================
   ADMIN: SECURITY ALERTS
   GET /admin/alerts?minutes=60
========================================================= */
app.get("/admin/alerts", requireAuth, requireAdmin, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;

  const minutes = Math.min(Math.max(parseInt(req.query.minutes || "60", 10) || 60, 1), 7 * 24 * 60);

  const org = await getOrg(orgId);
  const since = Date.now() - minutes * 60 * 1000;

  const alerts = [];
  const items = Array.isArray(org.audit) ? org.audit : [];

  for (const a of items) {
    const at = Date.parse(a.at || "");
    if (Number.isNaN(at) || at < since) continue;

    if (a.action === "login_failed") {
      alerts.push({
        code: "LOGIN_FAILED",
        severity: "high",
        at: a.at,
        message: `Failed login for ${a.username || "unknown"} from ${a.ip || "unknown ip"}`,
      });
    }

    if (a.action === "decrypt_denied") {
      alerts.push({
        code: "DECRYPT_DENIED",
        severity: "critical",
        at: a.at,
        message: `Unauthorized decrypt attempt (msgId=${a.msgId || "?"})`,
      });
    }

    if (a.action === "clear_user_pubkey") {
      alerts.push({
        code: "KEY_CLEARED",
        severity: "medium",
        at: a.at,
        message: `Public key cleared for userId=${a.targetUserId || "?"}`,
      });
    }
  }

  const summary = {
    denied: alerts.filter((x) => x.code === "DECRYPT_DENIED").length,
    failedLogins: alerts.filter((x) => x.code === "LOGIN_FAILED").length,
  };

  res.json({ ok: true, orgId, minutes, summary, alerts: alerts.slice(0, 200) });
});

/* =========================================================
   ADMIN: AUDIT
   GET /admin/audit?limit=200
========================================================= */
app.get("/admin/audit", requireAuth, requireAdmin, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const org = await getOrg(orgId);

  const limit = Math.min(Math.max(parseInt(req.query.limit || "200", 10) || 200, 10), 2000);

  const items = Array.isArray(org.audit) ? org.audit.slice(0, limit) : [];
  res.json({ ok: true, orgId, items });
});

/* =========================================================
   ADMIN: POLICIES
   GET /admin/policies
   POST /admin/policies
========================================================= */
app.get("/admin/policies", requireAuth, requireAdmin, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const org = await getOrg(orgId);

  org.policies = org.policies || defaultPolicies();
  res.json({ ok: true, orgId, policies: org.policies });
});

app.post("/admin/policies", requireAuth, requireAdmin, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const org = await getOrg(orgId);

  org.policies = org.policies || defaultPolicies();

  const b = req.body || {};
  org.policies.forceAttachmentEncryption = !!b.forceAttachmentEncryption;
  org.policies.disablePassphraseMode = !!b.disablePassphraseMode;
  org.policies.requireReauthForDecrypt = !!b.requireReauthForDecrypt;
  org.policies.enforceKeyRotationDays = Math.max(0, parseInt(b.enforceKeyRotationDays || "0", 10) || 0);

  await audit(req, orgId, req.qm.user.userId, "policies_update", { policies: org.policies });
  await saveOrg(orgId, org);

  res.json({ ok: true, orgId, policies: org.policies });
});

/* =========================================================
   ADMIN: ANALYTICS  (FULL SHAPE FOR portal/analytics.js)
   GET /admin/analytics?days=7&staleKeyDays=90
========================================================= */
app.get("/admin/analytics", requireAuth, requireAdmin, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const org = await getOrg(orgId);

  const days = Math.min(Math.max(parseInt(req.query.days || "7", 10) || 7, 1), 365);
  const staleKeyDays = Math.min(Math.max(parseInt(req.query.staleKeyDays || "90", 10) || 90, 7), 3650);

  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const since7dMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const auditItems = Array.isArray(org.audit) ? org.audit : [];
  const users = Array.isArray(org.users) ? org.users : [];
  const messages = org.messages || {};

  const totalUsers = users.length;
  const usersWithKeys = users.filter((u) => !!u.publicKeySpkiB64).length;
  const keyCoveragePct = totalUsers ? Math.round((usersWithKeys / totalUsers) * 100) : 0;

  // ---- invites hygiene
  const invs = Object.values(org.invites || {});
  const now = Date.now();
  let invActive = 0, invUsed = 0, invExpired = 0;

  for (const inv of invs) {
    const exp = Date.parse(inv.expiresAt || "");
    const isExpired = Number.isFinite(exp) && exp < now;
    const isUsed = !!inv.usedAt;

    if (isUsed) invUsed++;
    else if (isExpired) invExpired++;
    else invActive++;
  }

  // ---- counts from audit within window
  let decrypts = 0, deniedDecrypts = 0, failedLogins = 0, logins = 0;
  let encryptStore = 0;

  // active seats = unique users who did anything meaningful in the window
  const activeUsersSet = new Set();
  const activeUsers7dSet = new Set();

  // daily series
  const dayKey = (d) => {
    const dt = new Date(d);
    dt.setHours(0, 0, 0, 0);
    return dt.toISOString().slice(0, 10); // YYYY-MM-DD
  };

  const seriesMap = new Map(); // day -> bucket
  function ensureBucket(day) {
    if (!seriesMap.has(day)) {
      seriesMap.set(day, {
        day,
        encrypted: 0,
        decrypts: 0,
        denied: 0,
        failedLogins: 0,
        attachmentsBytes: 0,
      });
    }
    return seriesMap.get(day);
  }

  // user aggregates
  const userAgg = new Map(); // userId -> counts
  function aggUser(userId, fn) {
    if (!userId) return;
    if (!userAgg.has(userId)) userAgg.set(userId, { encrypts: 0, decrypts: 0, denied: 0, logins: 0 });
    fn(userAgg.get(userId));
  }

  for (const a of auditItems) {
    const atMs = Date.parse(a.at || "");
    if (!Number.isFinite(atMs)) continue;

    // 7d active set
    if (atMs >= since7dMs && a.userId) activeUsers7dSet.add(a.userId);

    // window filter
    if (atMs < sinceMs) continue;

    if (a.userId) activeUsersSet.add(a.userId);

    const d = dayKey(atMs);
    const b = ensureBucket(d);

    if (a.action === "encrypt_store") {
      encryptStore++;
      b.encrypted++;
      b.attachmentsBytes += Number(a.attachmentsTotalBytes || 0);
      aggUser(a.userId, (u) => u.encrypts++);
    }

    if (a.action === "decrypt_payload") {
      decrypts++;
      b.decrypts++;
      aggUser(a.userId, (u) => u.decrypts++);
    }

    if (a.action === "decrypt_denied") {
      deniedDecrypts++;
      b.denied++;
      aggUser(a.userId, (u) => u.denied++);
    }

    if (a.action === "login_failed") {
      failedLogins++;
      b.failedLogins++;
    }

    if (a.action === "login") {
      logins++;
      aggUser(a.userId, (u) => u.logins++);
    }
  }

  // ensure full day range (even zeros) so charts look smooth
  const activitySeries = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    dt.setHours(0, 0, 0, 0);
    const dk = dt.toISOString().slice(0, 10);
    const bucket = seriesMap.get(dk) || {
      day: dk, encrypted: 0, decrypts: 0, denied: 0, failedLogins: 0, attachmentsBytes: 0
    };
    activitySeries.push(bucket);
  }

  // ---- key health
  const missingKeys = users
    .filter((u) => !u.publicKeySpkiB64)
    .map((u) => ({
      userId: u.userId,
      username: u.username,
      role: u.role,
      lastLoginAt: u.lastLoginAt || null,
    }));

  const staleKeys = users
    .filter((u) => !!u.publicKeySpkiB64 && !!u.publicKeyRegisteredAt)
    .map((u) => {
      const at = Date.parse(u.publicKeyRegisteredAt || "");
      const ageDays = Number.isFinite(at) ? Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000)) : null;
      return {
        userId: u.userId,
        username: u.username,
        role: u.role,
        publicKeyRegisteredAt: u.publicKeyRegisteredAt || null,
        keyAgeDays: ageDays,
      };
    })
    .filter((x) => (x.keyAgeDays ?? 0) >= staleKeyDays)
    .sort((a, b) => (b.keyAgeDays ?? 0) - (a.keyAgeDays ?? 0));

  // ---- top users (by activity)
  const topUsers = Array.from(userAgg.entries())
    .map(([userId, c]) => {
      const u = users.find((x) => x.userId === userId);
      return {
        userId,
        username: u?.username || userId,
        role: u?.role || "Member",
        encrypts: c.encrypts,
        decrypts: c.decrypts,
        denied: c.denied,
        logins: c.logins,
      };
    })
    .sort((a, b) =>
      (b.encrypts + b.decrypts + b.denied + b.logins) - (a.encrypts + a.decrypts + a.denied + a.logins)
    )
    .slice(0, 25);

  const encryptedMessages = Object.keys(messages).length;
  const decryptSuccessRatePct =
    (decrypts + deniedDecrypts) > 0 ? Math.round((decrypts / (decrypts + deniedDecrypts)) * 100) : 0;

  res.json({
    ok: true,
    orgId,
    days,
    staleKeyDays,

    counts: {
      encryptedMessages,
      decrypts,
      deniedDecrypts,
      failedLogins,
    },

    seats: {
      totalUsers,
      activeUsers: activeUsersSet.size,
      activeUsers7d: activeUsers7dSet.size,
      keyCoveragePct,
    },

    rates: {
      decryptSuccessRatePct,
    },

    invites: {
      active: invActive,
      used: invUsed,
      expired: invExpired,
    },

    keyHealth: {
      staleKeyDays,
      missingKeysCount: missingKeys.length,
      staleKeysCount: staleKeys.length,
      missingKeys,
      staleKeys,
    },

    topUsers,
    activitySeries,
  });
});

/* =========================================================
   ORG: check + check-username (peek-only)
========================================================= */
app.get("/org/check", async (req, res) => {
  const orgId = String(req.query.orgId || "").trim();
  if (!orgId) return res.status(400).json({ error: "orgId required" });

  const rec = await peekOrg(orgId);

  // rec might be {data:{...}} or the actual org
  const org = rec?.data && !rec?.users ? rec.data : rec;

  const exists = !!org;
  const userCount = exists ? (org.users?.length || 0) : 0;
  const hasPrivilegedUser = exists
    ? !!(org.users || []).find(u => u.role === "Admin" || u.role === "SuperAdmin")
    : false;

  res.json({
    ok: true,
    orgId,
    exists,
    initialized: exists && userCount > 0 && hasPrivilegedUser,
    userCount,
    hasAdmin: hasPrivilegedUser
  });
});

app.get("/org/check-username", async (req, res) => {
  const orgId = String(req.query.orgId || "").trim();
  const username = String(req.query.username || "").trim();
  if (!orgId || !username) return res.status(400).json({ error: "orgId and username required" });

  const org = await peekOrg(orgId);
  if (!org) return res.json({ ok: true, orgId, username, orgExists: false, available: false, reason: "org_not_found" });

  const taken = !!(org.users || []).find((u) => String(u.username || "").toLowerCase() === username.toLowerCase());
  res.json({ ok: true, orgId, username, orgExists: true, available: !taken });
});

/* =========================================================
   BOOTSTRAP: create first SuperAdmin in PLATFORM org
   POST /bootstrap/superadmin
========================================================= */
app.post("/bootstrap/superadmin", rateLimitBootstrap, requireBootstrapSecret, async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password || password.length < 12) {
    return res.status(400).json({ error: "username + password (>=12 chars) required" });
  }

  // SAFE: org may not exist yet
  let org = await peekOrg(PLATFORM_ORG_ID);
  if (!org) {
    org = {
      orgId: PLATFORM_ORG_ID,
      orgName: "QuantumMail Platform",
      users: [],
      audit: [],
      policies: defaultPolicies(),
      createdAt: nowIso(),
    };
  }

  org.users = Array.isArray(org.users) ? org.users : [];
  org.audit = Array.isArray(org.audit) ? org.audit : [];
  org.policies = org.policies || defaultPolicies();

  const exists = org.users.find((u) => String(u.username || "").toLowerCase() === username.toLowerCase());
  if (exists) return res.status(409).json({ error: "User already exists" });

  const userId = nanoid(10);
  org.users.push({
    userId,
    username,
    passwordHash: sha256(password),
    role: "SuperAdmin",
    status: "Active",
    publicKeySpkiB64: null,
    publicKeyRegisteredAt: null,
    createdAt: nowIso(),
    lastLoginAt: null,
  });

  org.audit.unshift({ id: nanoid(10), at: nowIso(), action: "bootstrap_superadmin", userId, username });
  if (org.audit.length > 2000) org.audit.length = 2000;

  await saveOrg(PLATFORM_ORG_ID, org);

  res.json({ ok: true, platformOrgId: PLATFORM_ORG_ID, userId, username });
});
/* =========================================================
   BOOTSTRAP: seed first Admin for an org
   POST /dev/seed-admin
========================================================= */
app.post("/dev/seed-admin", rateLimitBootstrap, requireBootstrapSecret, async (req, res) => {
  const orgId = String(req.body?.orgId || "").trim();
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!orgId || !username || !password) return res.status(400).json({ error: "orgId, username, password required" });
  if (password.length < 12) return res.status(400).json({ error: "Password must be at least 12 characters" });

  const existing = await peekOrg(orgId);
  if (existing) {
    const admins = (existing.users || []).filter((u) => u.role === "Admin");
    if (admins.length > 0) {
      return res.status(403).json({ error: "Org already initialized. Use invites or an existing admin." });
    }
  }

  const org = await getOrg(orgId);
  org.users = org.users || [];
  org.audit = org.audit || [];
  org.policies = org.policies || defaultPolicies();
  ensureKeyring(org);

  const taken = org.users.some((u) => String(u.username || "").toLowerCase() === username.toLowerCase());
  if (taken) return res.status(409).json({ error: "Username already exists" });

  const newAdmin = {
    userId: nanoid(10),
    username,
    passwordHash: sha256(password),
    role: "Admin",
    status: "Active",
    publicKeySpkiB64: null,
    publicKeyRegisteredAt: null,
    createdAt: nowIso(),
    lastLoginAt: null,
  };

  org.users.push(newAdmin);
  org.audit.unshift({ id: nanoid(10), at: nowIso(), orgId, userId: newAdmin.userId, action: "bootstrap_seed_admin", username });
  if (org.audit.length > 2000) org.audit.length = 2000;

  await saveOrg(orgId, org);
  res.json({ ok: true, orgId, userId: newAdmin.userId, username });
});

/* =========================================================
   PUBLIC: org request
   POST /public/org-requests
========================================================= */
app.post("/public/org-requests", async (req, res) => {
  const companyName = String(req.body?.companyName || "").trim();
  const companyIdRaw = String(req.body?.companyId || "").trim();

  const orgName = String(req.body?.orgName || "").trim();
  const requesterName = String(req.body?.requesterName || "").trim();
  const requesterEmail = String(req.body?.requesterEmail || "").trim().toLowerCase();
  const notes = String(req.body?.notes || "").trim();

  if (!companyName || !orgName || !requesterName || !requesterEmail) {
    return res.status(400).json({ error: "companyName, orgName, requesterName, requesterEmail required" });
  }

  // If caller doesn’t supply companyId, auto-generate stable one
  const companyId = companyIdRaw || `comp_${nanoid(10)}`;

  const id = nanoid(12);
  await pool.query(
    `insert into qm_org_requests (id, company_id, company_name, org_name, requester_name, requester_email, notes, status)
     values ($1,$2,$3,$4,$5,$6,$7,'pending')`,
    [id, companyId, companyName, orgName, requesterName, requesterEmail, notes || null]
  );

  res.json({ ok: true, requestId: id, companyId });
});

/* =========================================================
   AUTH: login / me / change-password
========================================================= */
app.post("/auth/login", async (req, res) => {
  // show reason only in dev (or explicitly enabled)
  const SHOW_REASON = (process.env.QM_DEBUG_AUTH === "1") || !IS_PROD;

  const deny = (status, error, reason, extra = {}) => {
    const payload = { error };
    if (SHOW_REASON) payload.reason = reason;
    // avoid leaking sensitive info in prod
    if (SHOW_REASON && Object.keys(extra).length) payload.debug = extra;
    return res.status(status).json(payload);
  };

  try {
    const orgId = String(req.body?.orgId || "").trim();
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!orgId || !username || !password) {
      return deny(400, "orgId, username, password required", "missing_fields", { orgId, usernamePresent: !!username });
    }

    let org;
    try {
      org = await getOrg(orgId);
    } catch (e) {
      console.error("LOGIN getOrg failed:", { orgId, err: e?.message || e });
      return deny(503, "Org store unavailable. Try again.", "org_store_unavailable", { orgId });
    }

    if (!org || !Array.isArray(org.users)) {
      try { await audit(req, orgId, null, "login_failed", { username, reason: "org_not_found" }); } catch {}
      return deny(401, "Invalid creds", "org_not_found", { orgId });
    }

    const unameLower = username.toLowerCase();
    const user = (org.users || []).find((u) => String(u.username || "").toLowerCase() === unameLower);

    if (!user) {
      try { await audit(req, orgId, null, "login_failed", { username, reason: "unknown_user" }); } catch {}
      return deny(401, "Invalid creds", "unknown_user", { orgId, username });
    }

    if (String(user.status || "Active") === "PendingSetup") {
      return deny(403, "Account pending setup. Use setup link.", "pending_setup", {
        orgId,
        username: user.username
      });
    }

    let okPassword = false;
    try {
      const ph = sha256(password);
      okPassword = !!user.passwordHash && timingSafeEq(ph, user.passwordHash);
    } catch (e) {
      console.error("LOGIN password verify failed:", { orgId, username, err: e?.message || e });
      return deny(500, "Password verification failed", "password_verify_error");
    }

    if (!okPassword) {
      try { await audit(req, orgId, user.userId, "login_failed", { username: user.username, reason: "bad_password" }); } catch {}
      return deny(401, "Invalid creds", "bad_password", { orgId, username: user.username });
    }

    user.lastLoginAt = nowIso();

    const payload = {
      userId: user.userId,
      orgId,
      role: user.role,
      username: user.username,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
    };

    const token = signToken(payload);

    try { await audit(req, orgId, user.userId, "login", { username: user.username, role: user.role }); } catch {}

    try {
      await saveOrg(orgId, org);
    } catch (e) {
      console.error("LOGIN saveOrg failed:", { orgId, username, err: e?.message || e });
      return deny(503, "Could not persist login state. Try again.", "save_org_failed", { orgId });
    }

    return res.json({
      token,
      user: {
        userId: user.userId,
        orgId,
        username: user.username,
        role: user.role,
        status: user.status || "Active",
        hasPublicKey: !!user.publicKeySpkiB64,
        lastLoginAt: user.lastLoginAt,
        publicKeyRegisteredAt: user.publicKeyRegisteredAt,
      },
    });
  } catch (e) {
    console.error("LOGIN handler crashed:", e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* =========================================================
   SETUP ADMIN (NEW FLOW)
   1) GET  /public/setup-admin-info?orgId&token
   2) POST /auth/setup-admin/send-code { orgId, token }
   3) POST /auth/setup-admin/verify-code { orgId, token, code }
   4) POST /auth/setup-admin { orgId, token, newPassword }  (requires verified)
========================================================= */
app.get("/public/setup-admin-info", async (req, res) => {
  const orgId = String(req.query.orgId || "").trim();
  const token = String(req.query.token || "").trim();
  if (!orgId || !token) return res.status(400).json({ error: "orgId and token required" });

  const tokenHash = sha256Hex(token);

  const { rows } = await pool.query(
    `select org_id, user_id, email, org_name, admin_username, expires_at, used_at, email_verified_at
       from qm_setup_tokens
      where org_id=$1 and token_hash=$2 and purpose='initial_admin_setup'
      limit 1`,
    [orgId, tokenHash]
  );
  if (!rows.length) return res.status(403).json({ error: "Invalid token" });

  const t = rows[0];
  if (t.used_at) return res.status(403).json({ error: "Token already used" });
  if (Date.parse(t.expires_at) < Date.now()) return res.status(403).json({ error: "Token expired" });

  return res.json({
    ok: true,
    orgId: t.org_id,
    email: t.email || "",
    orgName: t.org_name || "",
    adminUsername: t.admin_username || "",
    emailVerified: !!t.email_verified_at,
    expiresAt: t.expires_at,
  });
});

app.post("/auth/setup-admin/send-code", async (req, res) => {
  const orgId = String(req.body?.orgId || "").trim();
  const token = String(req.body?.token || "").trim();
  if (!orgId || !token) return res.status(400).json({ error: "orgId and token required" });

  const tokenHash = sha256Hex(token);

  const { rows } = await pool.query(
    `select * from qm_setup_tokens
      where org_id=$1 and token_hash=$2 and purpose='initial_admin_setup'
      limit 1`,
    [orgId, tokenHash]
  );
  if (!rows.length) return res.status(403).json({ error: "Invalid token" });

  const t = rows[0];
  if (t.used_at) return res.status(403).json({ error: "Token already used" });
  if (Date.parse(t.expires_at) < Date.now()) return res.status(403).json({ error: "Token expired" });

  const email = String(t.email || "").trim();
  if (!email) return res.status(400).json({ error: "Missing email for this setup token" });

  if (t.email_verified_at) return res.json({ ok: true, alreadyVerified: true });

  // throttle resend (30 seconds)
  if (t.otp_sent_at && Date.parse(t.otp_sent_at) > Date.now() - 30 * 1000) {
    return res.status(429).json({ error: "Please wait before requesting another code." });
  }

  const code = genOtp6();
  const codeHash = otpHash(code);
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await pool.query(
    `update qm_setup_tokens
        set otp_hash=$3,
            otp_expires_at=$4,
            otp_sent_at=now(),
            otp_attempts=0,
            otp_last_attempt_at=null
      where id=$1 and org_id=$2`,
    [t.id, orgId, codeHash, otpExpiresAt.toISOString()]
  );

  const subject = `QuantumMail Admin Setup Code (${code})`;
  const text = `Your QuantumMail verification code is ${code}. It expires in 10 minutes.`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,Arial;line-height:1.4">
      <h2 style="margin:0 0 8px 0">QuantumMail Verification</h2>
      <p style="margin:0 0 10px 0">Use this code to verify your email for admin setup:</p>
      <div style="font-size:28px;font-weight:800;letter-spacing:2px;margin:10px 0">${code}</div>
      <p style="color:#6b7280;margin:10px 0 0 0">Expires in 10 minutes.</p>
    </div>
  `;

  try {
    await sendMail({ to: email, subject, text, html });
  } catch (e) {
    console.error("send-code email failed:", e);
    return res.status(500).json({ error: "Failed to send email. Try again." });
  }

  return res.json({ ok: true });
});

app.post("/auth/setup-admin/verify-code", async (req, res) => {
  const orgId = String(req.body?.orgId || "").trim();
  const token = String(req.body?.token || "").trim();
  const code = String(req.body?.code || "").trim();

  if (!orgId || !token || !code) return res.status(400).json({ error: "orgId, token, code required" });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Invalid code format" });

  const tokenHash = sha256Hex(token);

  const { rows } = await pool.query(
    `select * from qm_setup_tokens
      where org_id=$1 and token_hash=$2 and purpose='initial_admin_setup'
      limit 1`,
    [orgId, tokenHash]
  );
  if (!rows.length) return res.status(403).json({ error: "Invalid token" });

  const t = rows[0];
  if (t.used_at) return res.status(403).json({ error: "Token already used" });
  if (Date.parse(t.expires_at) < Date.now()) return res.status(403).json({ error: "Token expired" });

  if (t.email_verified_at) return res.json({ ok: true, alreadyVerified: true });

  if (t.otp_attempts >= 8) {
    return res.status(429).json({ error: "Too many attempts. Request a new code." });
  }

  if (!t.otp_hash || !t.otp_expires_at) {
    return res.status(400).json({ error: "No code requested yet. Click Send Code." });
  }

  if (Date.parse(t.otp_expires_at) < Date.now()) {
    return res.status(403).json({ error: "Code expired. Request a new code." });
  }

  const incomingHash = otpHash(code);
  const ok = timingSafeEq(incomingHash, t.otp_hash);

  await pool.query(
    `update qm_setup_tokens
        set otp_attempts = otp_attempts + 1,
            otp_last_attempt_at = now()
      where id=$1`,
    [t.id]
  );

  if (!ok) return res.status(403).json({ error: "Incorrect code" });

  await pool.query(
    `update qm_setup_tokens
        set email_verified_at=now(),
            otp_hash=null,
            otp_expires_at=null
      where id=$1`,
    [t.id]
  );

  return res.json({ ok: true });
});

app.post("/auth/setup-admin", async (req, res) => {
  const orgId = String(req.body?.orgId || "").trim();
  const token = String(req.body?.token || "").trim();
  const newPassword = String(req.body?.newPassword || "");

  if (!orgId || !token || !newPassword) return res.status(400).json({ error: "orgId, token, newPassword required" });
  if (newPassword.length < 12) return res.status(400).json({ error: "Password must be >= 12 characters" });

  const tokenHash = sha256Hex(token);

  const { rows } = await pool.query(
    `select * from qm_setup_tokens
      where org_id=$1 and token_hash=$2 and purpose='initial_admin_setup'
      limit 1`,
    [orgId, tokenHash]
  );
  if (!rows.length) return res.status(403).json({ error: "Invalid token" });

  const t = rows[0];
  if (t.used_at) return res.status(403).json({ error: "Token already used" });
  if (Date.parse(t.expires_at) < Date.now()) return res.status(403).json({ error: "Token expired" });

  if (!t.email_verified_at) {
    return res.status(403).json({ error: "Email not verified. Please verify first." });
  }

  const org = await getOrg(orgId);
  const u = (org.users || []).find((x) => x.userId === t.user_id);
  if (!u) return res.status(404).json({ error: "User not found" });

  u.passwordHash = sha256(newPassword);
  u.status = "Active";

  await saveOrg(orgId, org);
  await pool.query(`update qm_setup_tokens set used_at=now() where id=$1`, [t.id]);

  res.json({ ok: true });
});

/* =========================================================
   ORG: register key + list users
========================================================= */
app.post("/org/register-key", requireAuth, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const { org, user } = req.qm;

  const publicKeySpkiB64 = String(req.body?.publicKeySpkiB64 || "").trim();
  if (!publicKeySpkiB64) return res.status(400).json({ error: "publicKeySpkiB64 required" });

  user.publicKeySpkiB64 = publicKeySpkiB64;
  user.publicKeyRegisteredAt = nowIso();

  await audit(req, orgId, user.userId, "pubkey_register", { username: user.username });
  await saveOrg(orgId, org);
  res.json({ ok: true });
});

app.get("/org/users", requireAuth, (req, res) => {
  const { org, user } = req.qm;
  res.json({
    users: (org.users || []).map((u) => ({
      userId: u.userId,
      username: u.username,
      email: u.email || null,
      role: u.role,
      status: u.status || "Active",
      publicKeySpkiB64: u.publicKeySpkiB64 || null,
      hasPublicKey: !!u.publicKeySpkiB64,
      isMe: u.userId === user.userId,
    })),
  });
});

/* =========================================================
   ADMIN: invites + users
========================================================= */
app.post("/admin/invites/generate", requireAuth, requireAdmin, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const { org, user: admin } = req.qm;

  const role = String(req.body?.role || "Member") === "Admin" ? "Admin" : "Member";
  const expiresMinutes = Math.min(Math.max(parseInt(req.body?.expiresMinutes || "60", 10) || 60, 5), 7 * 24 * 60);

  // NEW: optional email stored with invite
  const email = String(req.body?.email || "").trim().toLowerCase();
  const emailOk = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) return res.status(400).json({ error: "Invalid email format" });

  let code;
  for (let i = 0; i < 5; i++) {
    code = genInviteCode();
    if (!org.invites?.[code]) break;
  }

  org.invites = org.invites || {};
  if (!code || org.invites[code]) return res.status(500).json({ error: "Could not generate code" });

  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString();

  // NEW: save email on invite
  org.invites[code] = {
    code,
    role,
    email: email || null,
    createdAt,
    expiresAt,
    createdByUserId: admin.userId,
    usedAt: null,
    usedByUserId: null
  };

  await audit(req, orgId, admin.userId, "invite_generate", { code, role, email: email || null, expiresAt });
  await saveOrg(orgId, org);

  res.json({ ok: true, code, role, email: email || null, expiresAt });
});
app.get("/admin/invites", requireAuth, requireAdmin, (req, res) => {
  const { org } = req.qm;
  const items = Object.values(org.invites || {})
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 50);
  res.json({ items });
});

app.get("/admin/users", requireAuth, requireAdmin, (req, res) => {
  const { org } = req.qm;
  res.json({
    users: (org.users || []).map((u) => ({
      userId: u.userId,
      username: u.username,
      email: u.email || null,
      role: u.role,
      status: u.status || "Active",
      hasPublicKey: !!u.publicKeySpkiB64,
      lastLoginAt: u.lastLoginAt || null,
      publicKeyRegisteredAt: u.publicKeyRegisteredAt || null,
    })),
  });
});

/* =========================================================
   SUPERADMIN: org requests + approve/reject + resend emails
========================================================= */
function makeSetupToken() {
  return crypto.randomBytes(32).toString("base64url"); // url-safe
}

async function markRequestEmailStatus({ requestId, type, ok, err }) {
  if (ok) {
    await pool.query(
      `update qm_org_requests
         set email_sent_at = now(),
             email_last_error = null,
             email_last_type = $2
       where id=$1`,
      [requestId, type]
    );
  } else {
    await pool.query(
      `update qm_org_requests
         set email_sent_at = null,
             email_last_error = $2,
             email_last_type = $3
       where id=$1`,
      [requestId, String(err || "unknown"), type]
    );
  }
}

app.get("/super/org-requests", requireAuth, requireSuperAdmin, async (req, res) => {
  const status = String(req.query.status || "pending").trim().toLowerCase();
  const allowed = new Set(["pending", "approved", "rejected"]);
  const s = allowed.has(status) ? status : "pending";

  const { rows } = await pool.query(`select * from qm_org_requests where status = $1 order by created_at desc limit 200`, [s]);
  res.json({ ok: true, status: s, items: rows });
});

app.post("/super/org-requests/:id/reject", requireAuth, requireSuperAdmin, async (req, res) => {
  const requestId = String(req.params.id || "").trim();
  const reason = String(req.body?.reason || "").trim();

  const r1 = await pool.query(`select * from qm_org_requests where id=$1`, [requestId]);
  if (!r1.rows.length) return res.status(404).json({ error: "Request not found" });
  const reqRow = r1.rows[0];
  if (reqRow.status !== "pending") return res.status(409).json({ error: "Request is not pending" });

  await pool.query(
    `update qm_org_requests
       set status='rejected',
           updated_at=now(),
           reviewed_by_user_id=$2,
           reviewed_at=now(),
           reject_reason=$3
     where id=$1`,
    [requestId, req.qm.user.userId, reason || null]
  );

  let emailSent = false;
  let emailError = null;

  try {
    const { subject, text, html } = rejectionEmail({
      orgName: reqRow.org_name,
      requesterName: reqRow.requester_name,
      reason: reason || reqRow.reject_reason || "",
    });

    const out = await sendMail({ to: reqRow.requester_email, subject, text, html });
    emailSent = (out?.accepted || []).length > 0;

    await markRequestEmailStatus({ requestId, type: "rejected", ok: true });
  } catch (e) {
    emailError = String(e?.message || e);
    await markRequestEmailStatus({ requestId, type: "rejected", ok: false, err: emailError });
  }

  return res.json({ ok: true, emailSent, emailError });
});

app.post("/super/org-requests/:id/approve", requireAuth, requireSuperAdmin, async (req, res) => {
  const requestId = String(req.params.id || "").trim();
  const orgId = String(req.body?.orgId || "").trim();
  const adminUsername = String(req.body?.adminUsername || "").trim();

  if (!requestId || !orgId || !adminUsername) {
    return res.status(400).json({ error: "requestId, orgId, adminUsername required" });
  }

  const r1 = await pool.query(`select * from qm_org_requests where id=$1`, [requestId]);
  if (!r1.rows.length) return res.status(404).json({ error: "Request not found" });
  const reqRow = r1.rows[0];
  if (reqRow.status !== "pending") return res.status(409).json({ error: "Request is not pending" });

  const org = await getOrg(orgId);
  org.users = org.users || [];
  org.audit = org.audit || [];
  org.policies = org.policies || defaultPolicies();
  ensureKeyring(org);

  const taken = org.users.some((u) => String(u.username || "").toLowerCase() === adminUsername.toLowerCase());
  if (taken) return res.status(409).json({ error: "adminUsername already exists in org" });

  const adminUserId = nanoid(10);
  org.users.push({
    userId: adminUserId,
    username: adminUsername,
    passwordHash: null,
    role: "Admin",
    status: "PendingSetup",
    publicKeySpkiB64: null,
    publicKeyRegisteredAt: null,
    createdAt: nowIso(),
    lastLoginAt: null,
  });
  
  const companyId = String(reqRow.company_id || "").trim() || `comp_${nanoid(10)}`;
  const companyName = String(reqRow.company_name || "").trim() || "Unknown Company";

  await pool.query(
    `insert into qm_companies (company_id, company_name, created_at)
     values ($1, $2, now())
     on conflict (company_id)
     do update set company_name = excluded.company_name, created_at = now()`,
    [companyId, companyName]
  );

  org.companyId = companyId;
  org.companyName = companyName;
  org.orgName = reqRow.org_name || org.orgName || orgId;
  
  await saveOrg(orgId, org);

  // Create setup token (store context columns so setup-admin-info can prefill)
  const rawToken = makeSetupToken();
  const tokenHash = sha256Hex(rawToken);
  const tokenId = nanoid(12);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `insert into qm_setup_tokens (id, org_id, user_id, token_hash, purpose, expires_at, email, org_name, admin_username)
     values ($1,$2,$3,$4,'initial_admin_setup',$5,$6,$7,$8)`,
    [
      tokenId,
      orgId,
      adminUserId,
      tokenHash,
      expiresAt.toISOString(),
      reqRow.requester_email,
      reqRow.org_name,
      adminUsername,
    ]
  );

  // Update request as approved
    await pool.query(
    `update qm_org_requests
       set status='approved',
           updated_at=now(),
           reviewed_by_user_id=$2,
           reviewed_at=now(),
           approved_org_id=$3,
           approved_admin_user_id=$4,
           company_id=$5,
           company_name=$6
     where id=$1`,
    [requestId, req.qm.user.userId, orgId, adminUserId, companyId, companyName]
  );

  const base = getPublicBase(req);
  const setupLink = `${base}/portal/setup-admin.html?orgId=${encodeURIComponent(orgId)}&token=${encodeURIComponent(rawToken)}`;

  let emailSent = false;
  let emailError = null;

  try {
    const { subject, text, html } = approvalEmail({
      orgName: reqRow.org_name,
      orgId,
      adminUsername,
      setupLink,
      expiresAt: expiresAt.toISOString(),
    });

    const out = await sendMail({ to: reqRow.requester_email, subject, text, html });
    emailSent = (out?.accepted || []).length > 0;

    await markRequestEmailStatus({ requestId, type: "approved", ok: true });
  } catch (e) {
    emailError = String(e?.message || e);
    await markRequestEmailStatus({ requestId, type: "approved", ok: false, err: emailError });
  }

  return res.json({
    ok: true,
    orgId,
    adminUserId,
    adminUsername,
    setupLink,
    expiresAt: expiresAt.toISOString(),
    emailSent,
    emailError,
  });
});

// Resend approval email (ALWAYS mints a fresh setup token + link; cannot recover raw token from hash)
app.post("/super/org-requests/:id/resend-approval-email", requireAuth, requireSuperAdmin, async (req, res) => {
  const requestId = String(req.params.id || "").trim();

  const r1 = await pool.query(`select * from qm_org_requests where id=$1`, [requestId]);
  if (!r1.rows.length) return res.status(404).json({ error: "Request not found" });
  const row = r1.rows[0];

  if (row.status !== "approved") return res.status(409).json({ error: "Request must be approved to resend approval email" });
  if (!row.approved_org_id || !row.approved_admin_user_id) {
    return res.status(409).json({ error: "Approved request missing org/admin mapping" });
  }

  const orgId = row.approved_org_id;
  const adminUserId = row.approved_admin_user_id;

  const org = await getOrg(orgId);
  const admin = (org.users || []).find((u) => u.userId === adminUserId);
  const adminUsername = admin?.username || "admin";

  const rawToken = makeSetupToken();
  const tokenHash = sha256Hex(rawToken);
  const tokenId = nanoid(12);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `insert into qm_setup_tokens (id, org_id, user_id, token_hash, purpose, expires_at, email, org_name, admin_username)
     values ($1,$2,$3,$4,'initial_admin_setup',$5,$6,$7,$8)`,
    [
      tokenId,
      orgId,
      adminUserId,
      tokenHash,
      expiresAt.toISOString(),
      row.requester_email,
      row.org_name,
      adminUsername,
    ]
  );

  const base = getPublicBase(req);
  const setupLink = `${base}/portal/setup-admin.html?orgId=${encodeURIComponent(orgId)}&token=${encodeURIComponent(rawToken)}`;

  let emailSent = false;
  let emailError = null;

  try {
    const { subject, text, html } = approvalEmail({
      orgName: row.org_name,
      orgId,
      adminUsername,
      setupLink,
      expiresAt: expiresAt.toISOString(),
    });

    const out = await sendMail({ to: row.requester_email, subject, text, html });
    emailSent = (out?.accepted || []).length > 0;

    await markRequestEmailStatus({ requestId, type: "approved", ok: true });
  } catch (e) {
    emailError = String(e?.message || e);
    await markRequestEmailStatus({ requestId, type: "approved", ok: false, err: emailError });
  }

  res.json({ ok: true, requestId, orgId, adminUsername, setupLink, expiresAt: expiresAt.toISOString(), emailSent, emailError });
});

app.post("/super/org-requests/:id/resend-reject-email", requireAuth, requireSuperAdmin, async (req, res) => {
  const requestId = String(req.params.id || "").trim();

  const r1 = await pool.query(`select * from qm_org_requests where id=$1`, [requestId]);
  if (!r1.rows.length) return res.status(404).json({ error: "Request not found" });
  const row = r1.rows[0];
  if (row.status !== "rejected") return res.status(409).json({ error: "Request is not rejected" });

  let emailSent = false;
  let emailError = null;

  try {
    const { subject, text, html } = rejectionEmail({
      orgName: row.org_name,
      requesterName: row.requester_name,
      reason: row.reject_reason || "",
    });

    const out = await sendMail({ to: row.requester_email, subject, text, html });
    emailSent = (out?.accepted || []).length > 0;

    await markRequestEmailStatus({ requestId, type: "rejected", ok: true });
  } catch (e) {
    emailError = String(e?.message || e);
    await markRequestEmailStatus({ requestId, type: "rejected", ok: false, err: emailError });
  }

  res.json({ ok: true, emailSent, emailError });
});

/* =========================================================
   MESSAGES: create + inbox + fetch (durable in org JSON)
========================================================= */
app.post("/api/messages", requireAuth, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const { org, user } = req.qm;

  const payload = req.body || {};
  if (!payload.iv || !payload.ciphertext || !payload.wrappedKeys) {
    return res.status(400).json({ error: "Invalid payload (iv, ciphertext, wrappedKeys required)" });
  }

  const pol = org.policies || defaultPolicies();
  if (pol.forceAttachmentEncryption) {
    if (payload.attachments != null && !Array.isArray(payload.attachments)) return res.status(400).json({ error: "attachments must be an array" });
    const arr = Array.isArray(payload.attachments) ? payload.attachments : [];
    for (const a of arr) if (!a || !a.iv || !a.ciphertext) return res.status(400).json({ error: "attachments must include iv + ciphertext for each file" });
  }

  const id = nanoid(10);
  const createdAt = nowIso();
  ensureKeyring(org);

  const { version, kekBytes } = getActiveKek(org);

  const attachmentsArr = Array.isArray(payload.attachments) ? payload.attachments : [];
  const attachmentsTotalBytes = attachmentsArr.reduce((sum, a) => sum + Number(a?.size || 0), 0);

  const sealed = sealWithKek(kekBytes, {
    iv: payload.iv,
    ciphertext: payload.ciphertext,
    aad: payload.aad || "gmail",
    wrappedKeys: payload.wrappedKeys,
    attachments: attachmentsArr,
  });

  org.messages = org.messages || {};
  org.messages[id] = {
    createdAt,
    kekVersion: version,
    sealed,
    createdByUserId: user.userId,
    createdByUsername: user.username,
  };

  await audit(req, orgId, user.userId, "encrypt_store", {
    msgId: id,
    kekVersion: version,
    attachmentCount: attachmentsArr.length,
    attachmentsTotalBytes,
  });

  await saveOrg(orgId, org);

  const base = getPublicBase(req);
  const url = `${base}/m/${id}`;
  res.json({ id, url, kekVersion: version });
});

app.get("/super/companies", requireAuth, requireSuperAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    select
      c.company_id,
      c.company_name,
      (
        select count(*)
        from qm_org_store s
        where (SELECT
                 o.org_id,
                 o.company_id,
                 c.company_name
               FROM qm_org_store o
               LEFT JOIN qm_companies c
                 ON c.company_id = o.company_id;
                 ) = c.company_id
      ) as org_count
    from qm_companies c
    order by c.company_name asc
    limit 500
  `);

  res.json({
    ok: true,
    items: rows.map(r => ({
      companyId: r.company_id,
      companyName: r.company_name,
      orgCount: Number(r.org_count || 0)
    }))
  });
});

app.get("/super/companies/:companyId/orgs", requireAuth, requireSuperAdmin, async (req, res) => {
  const companyId = String(req.params.companyId || "").trim();
  if (!companyId) return res.status(400).json({ error: "companyId required" });

  const { rows } = await pool.query(`
    select
      org_id,
      coalesce(data->>'orgName', data->>'name', org_id) as org_name,
      data->>'companyName' as company_name,
      updated_at
    from qm_org_store
    where (data->>'companyId') = $1
    order by updated_at desc
    limit 500
  `, [companyId]);

  res.json({
    ok: true,
    companyId,
    items: rows.map(r => ({
      orgId: r.org_id,
      orgName: r.org_name,
      companyName: r.company_name || null,
      updatedAt: r.updated_at
    }))
  });
});

app.get("/api/inbox", requireAuth, (req, res) => {
  const { org, user } = req.qm;

  const items = [];
  const ids = Object.keys(org.messages || {});
  ids.sort((a, b) => (Date.parse(org.messages[b]?.createdAt || "") || 0) - (Date.parse(org.messages[a]?.createdAt || "") || 0));

  for (const id of ids) {
    const rec = org.messages[id];
    if (!rec) continue;

    const kv = String(rec.kekVersion || org.keyring?.active || "1");
    const kk = getKekByVersion(org, kv);
    if (!kk) continue;

    let msg;
    try {
      msg = openWithKek(kk.kekBytes, rec.sealed);
    } catch {
      continue;
    }
    if (!msg?.wrappedKeys?.[user.userId]) continue;

    const attCount = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
    const attBytes = Array.isArray(msg.attachments) ? msg.attachments.reduce((s, a) => s + Number(a?.size || 0), 0) : 0;

    items.push({
      id,
      createdAt: rec.createdAt,
      from: rec.createdByUsername || null,
      fromUserId: rec.createdByUserId || null,
      attachmentCount: attCount,
      attachmentsTotalBytes: attBytes,
    });
  }

  res.json({ items });
});

app.get("/api/messages/:id", requireAuth, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const { org, user } = req.qm;

  const id = String(req.params.id || "").trim();
  const rec = org.messages?.[id];
  if (!rec) return res.status(404).json({ error: "Not found" });

  const kv = String(rec.kekVersion || org.keyring?.active || "1");
  const kk = getKekByVersion(org, kv);
  if (!kk) return res.status(500).json({ error: "Missing KEK for stored message" });

  let msg;
  try {
    msg = openWithKek(kk.kekBytes, rec.sealed);
  } catch {
    return res.status(500).json({ error: "Failed to open message record (bad KEK)" });
  }

  const wrappedDek = msg.wrappedKeys?.[user.userId];
  if (!wrappedDek) {
    await audit(req, orgId, user.userId, "decrypt_denied", { msgId: id, reason: "missing_wrapped_key" });
    return res.status(403).json({ error: "No wrapped key for this user" });
  }

  await audit(req, orgId, user.userId, "decrypt_payload", { msgId: id, kekVersion: kv });

  res.json({
    id,
    createdAt: rec.createdAt,
    iv: msg.iv,
    ciphertext: msg.ciphertext,
    aad: msg.aad,
    wrappedDek,
    kekVersion: kv,
    attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
  });
});

/* =========================================================
   Portal static + routes + outlook addin 
========================================================= */
const portalDir = path.join(__dirname, "..", "portal");

app.use("/portal", express.static(portalDir, { extensions: ["html"], etag: false, maxAge: 0 }));

app.get("/m/:id", (_req, res) => res.sendFile(path.join(portalDir, "decrypt.html")));
app.get("/portal/m/:id", (req, res) => res.redirect(`/m/${req.params.id}`));
app.get("/", (_req, res) => res.redirect("/portal/index.html"));

const outlookAddinDir = path.join(__dirname, "..", "outlook-addin");
app.use("/outlook-addin", express.static(outlookAddinDir, { etag: false, maxAge: 0 }));

/* =========================================================
   Start (Render compatible)
========================================================= */
const PORT = Number(process.env.PORT || "10000");
app.listen(PORT, () => console.log(`QuantumMail server running on port ${PORT}`));
