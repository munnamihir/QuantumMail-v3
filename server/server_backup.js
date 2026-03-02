// server/server.js
import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import cors from "cors";
import nodemailer from "nodemailer";
import { sendMail } from "./mailer.js";
import { approvalEmail, rejectionEmail } from "./emailTemplates.js";

import { pool } from "./db.js"; // Neon/PG pool
import { peekOrg, getOrg, saveOrg } from "./orgStore.js"; // JSONB org store

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
   SMTP (Brevo)
========================================================= */
const QM_SMTP_HOST = process.env.QM_SMTP_HOST || "";
const QM_SMTP_PORT = parseInt(process.env.QM_SMTP_PORT || "587", 10);
const QM_SMTP_USER = process.env.QM_SMTP_USER || "";
const QM_SMTP_PASS = process.env.QM_SMTP_PASS || "";
const QM_FROM_EMAIL = process.env.QM_FROM_EMAIL || "";
const QM_FROM_NAME = process.env.QM_FROM_NAME || "QuantumMail";

let _mailer = null;

function mailerConfigured() {
  return !!(QM_SMTP_HOST && QM_SMTP_PORT && QM_SMTP_USER && QM_SMTP_PASS && QM_FROM_EMAIL);
}

function getMailer() {
  if (!mailerConfigured()) {
    throw new Error("Mailer not configured. Set QM_SMTP_HOST/QM_SMTP_PORT/QM_SMTP_USER/QM_SMTP_PASS/QM_FROM_EMAIL");
  }
  if (_mailer) return _mailer;

  const secure = QM_SMTP_PORT === 465; // 465 = SMTPS, 587 = STARTTLS
  _mailer = nodemailer.createTransport({
    host: QM_SMTP_HOST,
    port: QM_SMTP_PORT,
    secure,
    auth: { user: QM_SMTP_USER, pass: QM_SMTP_PASS },
  });

  return _mailer;
}

async function sendMail({ to, subject, html, text }) {
  const t = getMailer();
  const from = QM_FROM_NAME ? `"${QM_FROM_NAME}" <${QM_FROM_EMAIL}>` : QM_FROM_EMAIL;

  const info = await t.sendMail({
    from,
    to,
    subject,
    text: text || undefined,
    html: html || undefined,
  });

  // "accepted" means Brevo accepted for delivery; delivery may still fail later.
  const accepted = Array.isArray(info.accepted) ? info.accepted : [];
  return { messageId: info.messageId || null, accepted };
}

function approvedEmailTemplate({ orgName, orgId, username, setupLink, expiresAt }) {
  const safeOrgName = String(orgName || orgId || "Your Org");
  return {
    subject: `QuantumMail — Your organization is approved (${safeOrgName})`,
    text:
`Your QuantumMail organization request was approved.

Org Name: ${safeOrgName}
Org ID: ${orgId}
Admin Username: ${username}

Setup Link (expires ${expiresAt}):
${setupLink}

If you did not request this, ignore this email.`,
    html:
`<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#0b1020">
  <h2 style="margin:0 0 10px">Organization Approved ✅</h2>
  <p style="margin:0 0 12px">Your QuantumMail organization request was approved.</p>

  <div style="background:#f6f8ff;border:1px solid #e2e8ff;border-radius:12px;padding:12px">
    <div><b>Org Name:</b> ${safeOrgName}</div>
    <div><b>Org ID:</b> <span style="font-family:ui-monospace,Menlo,Consolas,monospace">${orgId}</span></div>
    <div><b>Admin Username:</b> <span style="font-family:ui-monospace,Menlo,Consolas,monospace">${username}</span></div>
  </div>

  <p style="margin:14px 0 8px"><b>Setup Link</b> (expires ${expiresAt}):</p>
  <p style="margin:0 0 14px">
    <a href="${setupLink}" style="display:inline-block;padding:10px 14px;border-radius:12px;background:#0b5cff;color:#fff;text-decoration:none;font-weight:700">
      Complete Admin Setup
    </a>
  </p>

  <p style="margin:0;color:#4a5568;font-size:12px">
    If you did not request this, ignore this email.
  </p>
</div>`
  };
}

function rejectedEmailTemplate({ orgName, requesterName, reason }) {
  const safeOrgName = String(orgName || "Your Org");
  const safeName = String(requesterName || "there");
  const safeReason = String(reason || "No reason provided.");
  return {
    subject: `QuantumMail — Organization request update (${safeOrgName})`,
    text:
`Hi ${safeName},

Your QuantumMail organization request for "${safeOrgName}" was rejected.

Reason: ${safeReason}

You can reply to this email if you want to resubmit with more details.`,
    html:
`<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#0b1020">
  <h2 style="margin:0 0 10px">Request Update</h2>
  <p style="margin:0 0 12px">Hi ${safeName},</p>
  <p style="margin:0 0 12px">
    Your QuantumMail organization request for <b>"${safeOrgName}"</b> was rejected.
  </p>

  <div style="background:#fff5f7;border:1px solid #ffd2dc;border-radius:12px;padding:12px">
    <b>Reason:</b> ${safeReason}
  </div>

  <p style="margin:14px 0 0;color:#4a5568;font-size:12px">
    You can resubmit your request after addressing the reason.
  </p>
</div>`
  };
}

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

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function sha256Hex(s) {
  return sha256(s);
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

  const payload = JSON.parse(b64urlDecodeToString(p));
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
   
  // ---- columns for email verification / context
  await pool.query(`alter table qm_setup_tokens add column if not exists email text;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists org_name text;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists admin_username text;`);

  await pool.query(`alter table qm_setup_tokens add column if not exists email_verified_at timestamptz;`);

  await pool.query(`alter table qm_setup_tokens add column if not exists otp_hash text;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists otp_expires_at timestamptz;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists otp_sent_at timestamptz;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists otp_attempts int not null default 0;`);
  await pool.query(`alter table qm_setup_tokens add column if not exists otp_last_attempt_at timestamptz;`);
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
  const password = String(req.body?.password || "");

  if (!orgId || !inviteCode || !username || !password) {
    return res.status(400).json({ error: "orgId, inviteCode, username, password required" });
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

  if (inv.usedAt) return res.status(403).json({ error: "Invite already used" });
  if (Date.parse(inv.expiresAt || "") < Date.now()) return res.status(403).json({ error: "Invite expired" });

  const taken = org.users.some((u) => String(u.username || "").toLowerCase() === username.toLowerCase());
  if (taken) return res.status(409).json({ error: "Username already exists" });

  const userId = nanoid(10);
  const role = inv.role === "Admin" ? "Admin" : "Member";

  org.users.push({
    userId,
    username,
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
    },
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
   POST/PUT /admin/policies
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

app.put("/admin/policies", requireAuth, requireAdmin, async (req, res) => {
  req.method = "POST";
  return app._router.handle(req, res);
});

/* =========================================================
   ADMIN: ANALYTICS
   GET /admin/analytics?days=7
========================================================= */
app.get("/admin/analytics", requireAuth, requireAdmin, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const org = await getOrg(orgId);

  const days = Math.min(Math.max(parseInt(req.query.days || "7", 10) || 7, 1), 90);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const auditItems = Array.isArray(org.audit) ? org.audit : [];
  const messages = org.messages || {};

  const usersTotal = Array.isArray(org.users) ? org.users.length : 0;
  const messagesTotal = Object.keys(messages).length;

  let encryptStore = 0,
    decryptPayload = 0,
    loginFailed = 0,
    decryptDenied = 0;

  for (const a of auditItems) {
    const at = Date.parse(a.at || "");
    if (Number.isNaN(at) || at < since) continue;

    if (a.action === "encrypt_store") encryptStore++;
    if (a.action === "decrypt_payload") decryptPayload++;
    if (a.action === "login_failed") loginFailed++;
    if (a.action === "decrypt_denied") decryptDenied++;
  }

  res.json({
    ok: true,
    orgId,
    days,
    summary: {
      usersTotal,
      messagesTotal,
      encryptStoreLastNDays: encryptStore,
      decryptPayloadLastNDays: decryptPayload,
      loginFailedLastNDays: loginFailed,
      decryptDeniedLastNDays: decryptDenied,
    },
  });
});

/* =========================================================
   ORG: check + check-username (peek-only)
========================================================= */
app.get("/org/check", async (req, res) => {
  const orgId = String(req.query.orgId || "").trim();
  if (!orgId) return res.status(400).json({ error: "orgId required" });

  const org = await peekOrg(orgId);
  const exists = !!org;
  const userCount = exists ? org.users?.length || 0 : 0;
  const hasAdmin = exists ? !!(org.users || []).find((u) => u.role === "Admin") : false;

  res.json({ ok: true, orgId, exists, initialized: exists && userCount > 0 && hasAdmin, userCount, hasAdmin });
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

// Resend approval email (creates a NEW setup token + link, safer)
app.post("/super/org-requests/:id/resend-approval-email", requireAuth, requireSuperAdmin, async (req, res) => {
  const requestId = String(req.params.id || "").trim();

  const r1 = await pool.query(`select * from qm_org_requests where id=$1`, [requestId]);
  if (!r1.rows.length) return res.status(404).json({ error: "Request not found" });
  const row = r1.rows[0];
  if (row.status !== "approved") return res.status(409).json({ error: "Request is not approved" });
  if (!row.approved_org_id || !row.approved_admin_user_id) return res.status(409).json({ error: "Missing approved org/user info" });

  const orgId = row.approved_org_id;
  const adminUserId = row.approved_admin_user_id;

  const org = await getOrg(orgId);
  const adminUser = (org.users || []).find(u => u.userId === adminUserId);
  if (!adminUser) return res.status(404).json({ error: "Admin user not found in org" });

  // New setup token
  const rawToken = makeSetupToken();
  const tokenHash = sha256Hex(rawToken);
  const tokenId = nanoid(12);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `insert into qm_setup_tokens (id, org_id, user_id, token_hash, purpose, expires_at)
     values ($1,$2,$3,$4,'initial_admin_setup',$5)`,
    [tokenId, orgId, adminUserId, tokenHash, expiresAt.toISOString()]
  );

  const base = getPublicBase(req);
  const setupLink = `${base}/portal/setup-admin.html?orgId=${encodeURIComponent(orgId)}&token=${encodeURIComponent(rawToken)}`;

  let emailSent = false;
  let emailError = null;

  try {
    const tpl = approvedEmailTemplate({
      orgName: row.org_name,
      orgId,
      username: adminUser.username,
      setupLink,
      expiresAt: expiresAt.toISOString()
    });

    const out = await sendMail({
      to: row.requester_email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text
    });

    emailSent = (out.accepted || []).length > 0;

    await pool.query(
      `update qm_org_requests
         set email_sent_at = now(),
             email_last_error = null,
             email_last_type = 'approved'
       where id=$1`,
      [requestId]
    );
  } catch (e) {
    emailSent = false;
    emailError = String(e?.message || e);

    await pool.query(
      `update qm_org_requests
         set email_sent_at = null,
             email_last_error = $2,
             email_last_type = 'approved'
       where id=$1`,
      [requestId, emailError]
    );
  }

  res.json({ ok: true, emailSent, emailError, setupLink, expiresAt: expiresAt.toISOString() });
});

// Resend approval email (creates a NEW setup token + link, safer)
app.post("/super/org-requests/:id/resend-reject-email", requireAuth, requireSuperAdmin, async (req, res) => {
  const requestId = String(req.params.id || "").trim();

  const r1 = await pool.query(`select * from qm_org_requests where id=$1`, [requestId]);
  if (!r1.rows.length) return res.status(404).json({ error: "Request not found" });
  const row = r1.rows[0];
  if (row.status !== "rejected") return res.status(409).json({ error: "Request is not rejected" });

  let emailSent = false;
  let emailError = null;

  try {
    const tpl = rejectedEmailTemplate({
      orgName: row.org_name,
      requesterName: row.requester_name,
      reason: row.reject_reason || ""
    });

    const out = await sendMail({
      to: row.requester_email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text
    });

    emailSent = (out.accepted || []).length > 0;

    await pool.query(
      `update qm_org_requests
         set email_sent_at = now(),
             email_last_error = null,
             email_last_type = 'rejected'
       where id=$1`,
      [requestId]
    );
  } catch (e) {
    emailSent = false;
    emailError = String(e?.message || e);

    await pool.query(
      `update qm_org_requests
         set email_sent_at = null,
             email_last_error = $2,
             email_last_type = 'rejected'
       where id=$1`,
      [requestId, emailError]
    );
  }

  res.json({ ok: true, emailSent, emailError });
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

  const org = await getOrg(PLATFORM_ORG_ID);
  org.users = org.users || [];
  org.audit = org.audit || [];
  org.policies = org.policies || defaultPolicies();

  const exists = org.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
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
  const orgName = String(req.body?.orgName || "").trim();
  const requesterName = String(req.body?.requesterName || "").trim();
  const requesterEmail = String(req.body?.requesterEmail || "").trim();
  const notes = String(req.body?.notes || "").trim();

  if (!orgName || !requesterName || !requesterEmail) {
    return res.status(400).json({ error: "orgName, requesterName, requesterEmail required" });
  }

  const id = nanoid(12);
  await pool.query(
    `insert into qm_org_requests (id, org_name, requester_name, requester_email, notes, status)
     values ($1,$2,$3,$4,$5,'pending')`,
    [id, orgName, requesterName, requesterEmail, notes || null]
  );

  res.json({ ok: true, requestId: id });
});

/* =========================================================
   AUTH: login / me / change-password / setup-admin
========================================================= */
app.post("/auth/login", async (req, res) => {
  try {
    const orgId = String(req.body?.orgId || "").trim();
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!orgId || !username || !password) {
      return res.status(400).json({ error: "orgId, username, password required" });
    }

    let org;
    try {
      org = await getOrg(orgId);
    } catch (e) {
      console.error("LOGIN getOrg failed:", { orgId, err: e?.message || e });
      return res.status(503).json({ error: "Org store unavailable. Try again." });
    }

    if (!org || !Array.isArray(org.users)) {
      try {
        await audit(req, orgId, null, "login_failed", { username, reason: "org_not_found" });
      } catch {}
      return res.status(401).json({ error: "Invalid creds" });
    }

    const unameLower = username.toLowerCase();
    const user = (org.users || []).find((u) => String(u.username || "").toLowerCase() === unameLower);

    if (!user) {
      try {
        await audit(req, orgId, null, "login_failed", { username, reason: "unknown_user" });
      } catch {}
      return res.status(401).json({ error: "Invalid creds" });
    }

    if (String(user.status || "Active") === "PendingSetup") {
      return res.status(403).json({ error: "Account pending setup. Use setup link." });
    }

    let okPassword = false;
    try {
      const ph = sha256(password);
      okPassword = !!user.passwordHash && timingSafeEq(ph, user.passwordHash);
    } catch (e) {
      console.error("LOGIN password verify failed:", { orgId, username, err: e?.message || e });
      return res.status(500).json({ error: "Password verification failed" });
    }

    if (!okPassword) {
      try {
        await audit(req, orgId, user.userId, "login_failed", { username: user.username, reason: "bad_password" });
      } catch {}
      return res.status(401).json({ error: "Invalid creds" });
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

    try {
      await audit(req, orgId, user.userId, "login", { username: user.username, role: user.role });
    } catch {}

    try {
      await saveOrg(orgId, org);
    } catch (e) {
      console.error("LOGIN saveOrg failed:", { orgId, username, err: e?.message || e });
      return res.status(503).json({ error: "Could not persist login state. Try again." });
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
    return res.status(500).json({ error: "Internal Server Error", detail: String(e?.message || e) });
  }
});

app.get("/auth/me", requireAuth, (req, res) => {
  const { user } = req.qm;
  res.json({
    ok: true,
    user: {
      userId: user.userId,
      orgId: req.qm.tokenPayload.orgId,
      username: user.username,
      role: user.role,
      status: user.status || "Active",
    },
  });
});

app.post("/auth/change-password", requireAuth, async (req, res) => {
  const orgId = req.qm.tokenPayload.orgId;
  const { org, user } = req.qm;

  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "currentPassword and newPassword required" });
  if (newPassword.length < 12) return res.status(400).json({ error: "New password must be at least 12 characters" });

  const curHash = sha256(currentPassword);
  if (!user.passwordHash || !timingSafeEq(curHash, user.passwordHash)) {
    await audit(req, orgId, user.userId, "change_password_failed", { reason: "bad_current_password" });
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  const nextHash = sha256(newPassword);
  if (timingSafeEq(nextHash, user.passwordHash)) return res.status(400).json({ error: "New password must be different" });

  user.passwordHash = nextHash;
  await audit(req, orgId, user.userId, "change_password", { username: user.username, role: user.role });
  await saveOrg(orgId, org);

  res.json({ ok: true });
});

/* =========================================================
   SETUP ADMIN (NEW FLOW)
   1) GET  /public/setup-admin-info?orgId&token
   2) POST /auth/setup-admin/send-code { orgId, token }
   3) POST /auth/setup-admin/verify-code { orgId, token, code }
   4) POST /auth/setup-admin { orgId, token, newPassword }  (requires verified)
========================================================= */

// GET setup context for UI (prefill email + show verified)
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

// POST send verification code to email
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
    await sendEmail({ to: email, subject, text, html });
  } catch (e) {
    console.error("send-code email failed:", e);
    return res.status(500).json({ error: "Failed to send email. Try again." });
  }

  return res.json({ ok: true });
});

// POST verify code
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

// POST /auth/setup-admin { orgId, token, newPassword }  (now requires verified email)
app.post("/auth/setup-admin", async (req, res) => {
  const orgId = String(req.body?.orgId || "").trim();
  const token = String(req.body?.token || "").trim();
  const newPassword = String(req.body?.newPassword || "");

  if (!orgId || !token || !newPassword) return res.status(400).json({ error: "orgId, token, newPassword required" });
  if (newPassword.length < 12) return res.status(400).json({ error: "Password must be >= 12 characters" });

  const tokenHash = sha256Hex(token);

  const { rows } = await pool.query(
    `select * from qm_setup_tokens
      where org_id=$1 and token_hash=$2 and purpose='initial_admin_setup'`,
    [orgId, tokenHash]
  );
  if (!rows.length) return res.status(403).json({ error: "Invalid token" });

  const t = rows[0];
  if (t.used_at) return res.status(403).json({ error: "Token already used" });
  if (Date.parse(t.expires_at) < Date.now()) return res.status(403).json({ error: "Token expired" });

  // ✅ NEW: must verify email before activation
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

  let code;
  for (let i = 0; i < 5; i++) {
    code = genInviteCode();
    if (!org.invites?.[code]) break;
  }

  org.invites = org.invites || {};
  if (!code || org.invites[code]) return res.status(500).json({ error: "Could not generate code" });

  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString();

  org.invites[code] = { code, role, createdAt, expiresAt, createdByUserId: admin.userId, usedAt: null, usedByUserId: null };

  await audit(req, orgId, admin.userId, "invite_generate", { code, role, expiresAt });
  await saveOrg(orgId, org);

  res.json({ ok: true, code, role, expiresAt });
});

app.get("/admin/invites", requireAuth, requireAdmin, (req, res) => {
  const { org } = req.qm;
  const items = Object.values(org.invites || {}).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 50);
  res.json({ items });
});

app.get("/admin/users", requireAuth, requireAdmin, (req, res) => {
  const { org } = req.qm;
  res.json({
    users: (org.users || []).map((u) => ({
      userId: u.userId,
      username: u.username,
      role: u.role,
      status: u.status || "Active",
      hasPublicKey: !!u.publicKeySpkiB64,
      lastLoginAt: u.lastLoginAt || null,
      publicKeyRegisteredAt: u.publicKeyRegisteredAt || null,
    })),
  });
});

async function sendApprovalEmail({ req, requestRow, orgId, adminUsername, rawToken, expiresAtIso }) {
  const base = getPublicBase(req);
  const setupLink =
    `${base}/portal/setup-admin.html?orgId=${encodeURIComponent(orgId)}&token=${encodeURIComponent(rawToken)}`;

  const { subject, text, html } = approvalEmail({
    orgName: requestRow.org_name,
    orgId,
    adminUsername,
    setupLink,
    expiresAt: expiresAtIso
  });

  await sendMail({
    to: requestRow.requester_email,
    subject,
    text,
    html
  });

  return { setupLink };
}


/* =========================================================
   SUPERADMIN: queue list / approve / reject (NEW: auto-email)
========================================================= */
function makeSetupToken() {
  return crypto.randomBytes(32).toString("base64url"); // url-safe
}

// POST /super/org-requests/:id/resend-approval-email
app.post("/super/org-requests/:id/resend-approval-email", requireAuth, requireSuperAdmin, async (req, res) => {
  const requestId = String(req.params.id || "").trim();

  const r1 = await pool.query(`select * from qm_org_requests where id=$1`, [requestId]);
  if (!r1.rows.length) return res.status(404).json({ error: "Request not found" });

  const reqRow = r1.rows[0];
  if (reqRow.status !== "approved") {
    return res.status(409).json({ error: "Request must be approved to resend approval email" });
  }
  if (!reqRow.approved_org_id || !reqRow.approved_admin_user_id) {
    return res.status(500).json({ error: "Approved request missing org/admin mapping" });
  }

  const orgId = reqRow.approved_org_id;
  const adminUserId = reqRow.approved_admin_user_id;

  // Find the admin username from org store
  const org = await getOrg(orgId);
  const admin = (org.users || []).find(u => u.userId === adminUserId);
  const adminUsername = admin?.username || "admin";

  // Try reuse latest unused token, else mint a new one
  let rawToken = null;
  let expiresAt = null;

  const tok = await pool.query(
    `select * from qm_setup_tokens
      where org_id=$1 and user_id=$2 and purpose='initial_admin_setup'
      order by created_at desc
      limit 1`,
    [orgId, adminUserId]
  );

  const latest = tok.rows[0] || null;

  const latestExpired = latest ? (Date.parse(latest.expires_at) < Date.now()) : true;
  const latestUsed = latest ? !!latest.used_at : false;

  if (!latest || latestUsed || latestExpired) {
    rawToken = makeSetupToken();
    const tokenHash = sha256Hex(rawToken);
    const tokenId = nanoid(12);
    expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `insert into qm_setup_tokens (id, org_id, user_id, token_hash, purpose, expires_at)
       values ($1,$2,$3,$4,'initial_admin_setup',$5)`,
      [tokenId, orgId, adminUserId, tokenHash, expiresAt.toISOString()]
    );
  } else {
    // Cannot recover raw token from hash, so we MUST mint a fresh token if we want to include it in email.
    // So: always mint a new one for resend to ensure link works.
    rawToken = makeSetupToken();
    const tokenHash = sha256Hex(rawToken);
    const tokenId = nanoid(12);
    expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `insert into qm_setup_tokens (id, org_id, user_id, token_hash, purpose, expires_at)
       values ($1,$2,$3,$4,'initial_admin_setup',$5)`,
      [tokenId, orgId, adminUserId, tokenHash, expiresAt.toISOString()]
    );
  }

  // Send email
  const { setupLink } = await sendApprovalEmail({
    req,
    requestRow: reqRow,
    orgId,
    adminUsername,
    rawToken,
    expiresAtIso: expiresAt.toISOString()
  });

  res.json({ ok: true, requestId, orgId, adminUsername, setupLink, expiresAt: expiresAt.toISOString() });
});

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
    const tpl = rejectedEmailTemplate({
      orgName: reqRow.org_name,
      requesterName: reqRow.requester_name,
      reason: reason || reqRow.reject_reason || ""
    });

    const out = await sendMail({
      to: reqRow.requester_email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text
    });

    emailSent = (out.accepted || []).length > 0;

    await pool.query(
      `update qm_org_requests
         set email_sent_at = now(),
             email_last_error = null,
             email_last_type = 'rejected'
       where id=$1`,
      [requestId]
    );
  } catch (e) {
    emailSent = false;
    emailError = String(e?.message || e);

    await pool.query(
      `update qm_org_requests
         set email_sent_at = null,
             email_last_error = $2,
             email_last_type = 'rejected'
       where id=$1`,
      [requestId, emailError]
    );
  }

  return res.json({ ok: true, emailSent, emailError });
});
// Approve: create org + create first admin (PendingSetup) + create setup token + return setupLink + email it
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

  const taken = org.users.some(u => String(u.username || "").toLowerCase() === adminUsername.toLowerCase());
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
    lastLoginAt: null
  });

  await saveOrg(orgId, org);

  // Create setup token
  const rawToken = makeSetupToken();
  const tokenHash = sha256Hex(rawToken);
  const tokenId = nanoid(12);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `insert into qm_setup_tokens (id, org_id, user_id, token_hash, purpose, expires_at)
     values ($1,$2,$3,$4,'initial_admin_setup',$5)`,
    [tokenId, orgId, adminUserId, tokenHash, expiresAt.toISOString()]
  );

  // Update request as approved
  await pool.query(
    `update qm_org_requests
       set status='approved',
           updated_at=now(),
           reviewed_by_user_id=$2,
           reviewed_at=now(),
           approved_org_id=$3,
           approved_admin_user_id=$4
     where id=$1`,
    [requestId, req.qm.user.userId, orgId, adminUserId]
  );

  const base = getPublicBase(req);
  const setupLink = `${base}/portal/setup-admin.html?orgId=${encodeURIComponent(orgId)}&token=${encodeURIComponent(rawToken)}`;

  // Send email to requester
  let emailSent = false;
  let emailError = null;

  try {
    const tpl = approvedEmailTemplate({
      orgName: reqRow.org_name,
      orgId,
      username: adminUsername,
      setupLink,
      expiresAt: expiresAt.toISOString()
    });

    const out = await sendMail({
      to: reqRow.requester_email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });

    emailSent = (out.accepted || []).length > 0;

    await pool.query(
      `update qm_org_requests
         set email_sent_at = now(),
             email_last_error = null,
             email_last_type = 'approved'
       where id=$1`,
      [requestId]
    );
  } catch (e) {
    emailSent = false;
    emailError = String(e?.message || e);

    await pool.query(
      `update qm_org_requests
         set email_sent_at = null,
             email_last_error = $2,
             email_last_type = 'approved'
       where id=$1`,
      [requestId, emailError]
    );
  }

  return res.json({
    ok: true,
    orgId,
    adminUserId,
    adminUsername,
    setupLink,
    expiresAt: expiresAt.toISOString(),
    emailSent,
    emailError
  });
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
   Portal static + routes
========================================================= */
const portalDir = path.join(__dirname, "..", "portal");

app.use("/portal", express.static(portalDir, { extensions: ["html"], etag: false, maxAge: 0 }));

app.get("/m/:id", (_req, res) => res.sendFile(path.join(portalDir, "decrypt.html")));
app.get("/portal/m/:id", (req, res) => res.redirect(`/m/${req.params.id}`));
app.get("/", (_req, res) => res.redirect("/portal/index.html"));

/* =========================================================
   Start (Render compatible)
========================================================= */
const PORT = Number(process.env.PORT || "10000");
app.listen(PORT, () => console.log(`QuantumMail server running on port ${PORT}`));
