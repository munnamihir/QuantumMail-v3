// server/routes/recovery.js
import express from "express";
import crypto from "crypto";

export function recoveryRoutes({
  getOrg,
  saveOrg,
  sendMail,
  tokenSecret,
  hashPassword,
  publicBaseUrl = ""
}) {
  if (!getOrg || !saveOrg) throw new Error("recoveryRoutes requires getOrg/saveOrg");
  if (!sendMail) throw new Error("recoveryRoutes requires sendMail");
  if (!tokenSecret || String(tokenSecret).length < 16) throw new Error("recoveryRoutes requires tokenSecret");
  if (!hashPassword) throw new Error("recoveryRoutes requires hashPassword");

  const router = express.Router();

  function nowIso() { return new Date().toISOString(); }

  function normEmail(s) {
    return String(s || "").trim().toLowerCase();
  }

  function sha256Hex(s) {
    return crypto.createHash("sha256").update(String(s)).digest("hex");
  }

  function otpHash(code) {
    // ✅ Same style you use for setup-admin OTP: HMAC with TOKEN_SECRET
    return crypto.createHmac("sha256", String(tokenSecret)).update(String(code)).digest("hex");
  }

  function genOtp6() {
    const n = crypto.randomInt(0, 1000000);
    return String(n).padStart(6, "0");
  }

  function randomResetToken() {
    // url-safe token; we only store hash
    return crypto.randomBytes(32).toString("base64url");
  }

  function getBase(req) {
    // Use env if provided; else derive from proxy headers (Render)
    if (publicBaseUrl && String(publicBaseUrl).trim()) return String(publicBaseUrl).trim().replace(/\/+$/,"");
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return `${proto}://${host}`;
  }

  function ensureUserReset(u) {
    if (!u.reset) u.reset = {};
    u.reset.tokenHash ??= null;
    u.reset.tokenExpiresAt ??= null;
    u.reset.otpHash ??= null;
    u.reset.otpExpiresAt ??= null;
    u.reset.otpSentAt ??= null;
    u.reset.otpAttempts ??= 0;
    u.reset.completedAt ??= null;
    return u;
  }

  // Very small spam throttle in-memory (good enough for MVP)
  const RL = new Map(); // key -> {count, resetAt}
  function rateLimit(key, { limit = 8, windowMs = 10 * 60 * 1000 } = {}) {
    const now = Date.now();
    const cur = RL.get(key);
    if (!cur || now > cur.resetAt) {
      RL.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    cur.count++;
    return cur.count <= limit;
  }

  function genericUsernameMessage() {
    return { ok: true, message: "If an account exists, you will receive an email shortly." };
  }

  function genericPasswordMessage() {
    return { ok: true, message: "If an account exists, you’ll receive a reset link shortly." };
  }

  /* =========================================================
     POST /auth/forgot-username
     body: { orgId, email }
     - Always returns generic message
     - If match exists: email the username
  ========================================================= */
  router.post("/auth/forgot-username", async (req, res) => {
    const generic = genericUsernameMessage();

    try {
      const orgId = String(req.body?.orgId || "").trim();
      const email = normEmail(req.body?.email);

      if (!orgId || !email) return res.json(generic);

      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
      if (!rateLimit(`fu:${ip}:${orgId}`, { limit: 10 })) return res.json(generic);

      const org = await getOrg(orgId);
      const users = Array.isArray(org?.users) ? org.users : [];
      const user = users.find(u => normEmail(u?.email) === email);

      if (!user) return res.json(generic);

      await sendMail({
        to: email,
        subject: "QuantumMail — Your username",
        text: `Org: ${orgId}\nUsername: ${user.username}\n\nIf you didn’t request this, ignore this email.`,
        html: `
          <div style="font-family:system-ui,Segoe UI,Roboto,Arial;line-height:1.4">
            <h2 style="margin:0 0 8px 0">Your QuantumMail username</h2>
            <p style="margin:0 0 6px 0">Org: <b>${orgId}</b></p>
            <p style="margin:0 0 6px 0">Username: <b>${String(user.username || "")}</b></p>
            <p style="color:#6b7280;margin:10px 0 0 0">If you didn’t request this, ignore this email.</p>
          </div>
        `
      });

      org.audit = Array.isArray(org.audit) ? org.audit : [];
      org.audit.unshift({
        id: crypto.randomBytes(8).toString("hex"),
        at: nowIso(),
        action: "forgot_username_email",
        userId: user.userId,
        username: user.username,
        ip
      });
      if (org.audit.length > 2000) org.audit.length = 2000;

      await saveOrg(orgId, org);
      return res.json(generic);
    } catch {
      return res.json(generic);
    }
  });

  /* =========================================================
     POST /auth/forgot-password
     body: { orgId, email }
     - Always returns generic
     - If match exists: create reset token, email reset link
  ========================================================= */
  router.post("/auth/forgot-password", async (req, res) => {
    const generic = genericPasswordMessage();

    try {
      const orgId = String(req.body?.orgId || "").trim();
      const email = normEmail(req.body?.email);

      if (!orgId || !email) return res.json(generic);

      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
      if (!rateLimit(`fp:${ip}:${orgId}`, { limit: 8 })) return res.json(generic);

      const org = await getOrg(orgId);
      const users = Array.isArray(org?.users) ? org.users : [];
      const user = users.find(u => normEmail(u?.email) === email);

      if (!user) return res.json(generic);

      ensureUserReset(user);

      const rawToken = randomResetToken();
      user.reset.tokenHash = sha256Hex(rawToken);
      user.reset.tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
      user.reset.otpHash = null;
      user.reset.otpExpiresAt = null;
      user.reset.otpSentAt = null;
      user.reset.otpAttempts = 0;
      user.reset.completedAt = null;

      const base = getBase(req);
      const link = `${base}/portal/reset.html?orgId=${encodeURIComponent(orgId)}&token=${encodeURIComponent(rawToken)}`;

      await saveOrg(orgId, org);

      await sendMail({
        to: email,
        subject: "QuantumMail — Reset your password",
        text: `Reset link (expires in 15 minutes):\n${link}\n\nIf you didn’t request this, ignore this email.`,
        html: `
          <div style="font-family:system-ui,Segoe UI,Roboto,Arial;line-height:1.4">
            <h2 style="margin:0 0 8px 0">Reset your password</h2>
            <p style="margin:0 0 10px 0">Click the button below to continue. This link expires in 15 minutes.</p>
            <p>
              <a href="${link}" style="display:inline-block;padding:12px 14px;border-radius:10px;background:#2bd576;color:#07101f;text-decoration:none;font-weight:800">
                Open Reset Page
              </a>
            </p>
            <p style="color:#6b7280;margin:10px 0 0 0">If you didn’t request this, ignore this email.</p>
          </div>
        `
      });

      org.audit = Array.isArray(org.audit) ? org.audit : [];
      org.audit.unshift({
        id: crypto.randomBytes(8).toString("hex"),
        at: nowIso(),
        action: "forgot_password_link_sent",
        userId: user.userId,
        username: user.username,
        ip
      });
      if (org.audit.length > 2000) org.audit.length = 2000;

      await saveOrg(orgId, org);
      return res.json(generic);
    } catch {
      return res.json(generic);
    }
  });

  /* =========================================================
     POST /auth/reset/send-code
     body: { orgId, token }
     - Validate token
     - Email OTP code
  ========================================================= */
  router.post("/auth/reset/send-code", async (req, res) => {
    try {
      const orgId = String(req.body?.orgId || "").trim();
      const token = String(req.body?.token || "").trim();
      if (!orgId || !token) return res.status(400).json({ error: "orgId and token required" });

      const org = await getOrg(orgId);
      const users = Array.isArray(org?.users) ? org.users : [];
      const tokenHash = sha256Hex(token);

      const user = users.find(u => u?.reset?.tokenHash === tokenHash);
      if (!user) return res.status(403).json({ error: "Invalid reset link" });

      ensureUserReset(user);

      const exp = Date.parse(user.reset.tokenExpiresAt || "");
      if (!exp || Date.now() > exp) return res.status(403).json({ error: "Reset link expired" });

      const email = normEmail(user.email);
      if (!email) return res.status(400).json({ error: "No email on file for this account. Ask Admin to add email." });

      // throttle resend: 30s
      const sentAt = Date.parse(user.reset.otpSentAt || "");
      if (sentAt && Date.now() - sentAt < 30 * 1000) {
        return res.status(429).json({ error: "Please wait before requesting another code." });
      }

      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
      if (!rateLimit(`rcode:${ip}:${orgId}`, { limit: 12 })) return res.status(429).json({ error: "Too many attempts" });

      const code = genOtp6();
      user.reset.otpHash = otpHash(code);
      user.reset.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      user.reset.otpSentAt = nowIso();
      user.reset.otpAttempts = 0;

      await saveOrg(orgId, org);

      await sendMail({
        to: email,
        subject: `QuantumMail — Verification code (${code})`,
        text: `Your QuantumMail verification code is ${code}. It expires in 10 minutes.`,
        html: `
          <div style="font-family:system-ui,Segoe UI,Roboto,Arial;line-height:1.4">
            <h2 style="margin:0 0 8px 0">QuantumMail Verification</h2>
            <p style="margin:0 0 10px 0">Use this code to reset your password:</p>
            <div style="font-size:28px;font-weight:800;letter-spacing:2px;margin:10px 0">${code}</div>
            <p style="color:#6b7280;margin:10px 0 0 0">Expires in 10 minutes.</p>
          </div>
        `
      });

      org.audit = Array.isArray(org.audit) ? org.audit : [];
      org.audit.unshift({
        id: crypto.randomBytes(8).toString("hex"),
        at: nowIso(),
        action: "reset_code_sent",
        userId: user.userId,
        username: user.username,
        ip
      });
      if (org.audit.length > 2000) org.audit.length = 2000;

      await saveOrg(orgId, org);

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e?.message || "Failed to send code" });
    }
  });

  /* =========================================================
     POST /auth/reset/confirm
     body: { orgId, token, code, newPassword }
     - Validate token + code
     - Set new password
     - Clear reset state
  ========================================================= */
  router.post("/auth/reset/confirm", async (req, res) => {
    try {
      const orgId = String(req.body?.orgId || "").trim();
      const token = String(req.body?.token || "").trim();
      const code = String(req.body?.code || "").trim();
      const newPassword = String(req.body?.newPassword || "");

      if (!orgId || !token || !code || !newPassword) {
        return res.status(400).json({ error: "orgId, token, code, newPassword required" });
      }
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Invalid code format" });
      if (newPassword.length < 12) return res.status(400).json({ error: "New password must be at least 12 characters" });

      const org = await getOrg(orgId);
      const users = Array.isArray(org?.users) ? org.users : [];
      const tokenHash = sha256Hex(token);

      const user = users.find(u => u?.reset?.tokenHash === tokenHash);
      if (!user) return res.status(403).json({ error: "Invalid reset session" });

      ensureUserReset(user);

      const tokenExp = Date.parse(user.reset.tokenExpiresAt || "");
      if (!tokenExp || Date.now() > tokenExp) return res.status(403).json({ error: "Reset link expired" });

      const otpExp = Date.parse(user.reset.otpExpiresAt || "");
      if (!otpExp || Date.now() > otpExp) return res.status(403).json({ error: "Code expired. Request a new code." });

      if ((user.reset.otpAttempts || 0) >= 8) {
        return res.status(429).json({ error: "Too many attempts. Request a new code." });
      }

      const incoming = otpHash(code);
      const ok = (user.reset.otpHash && crypto.timingSafeEqual(Buffer.from(incoming), Buffer.from(String(user.reset.otpHash))));
      user.reset.otpAttempts = (user.reset.otpAttempts || 0) + 1;

      if (!ok) {
        await saveOrg(orgId, org);
        return res.status(403).json({ error: "Incorrect code" });
      }

      // ✅ Set password (matches your system)
      user.passwordHash = await Promise.resolve(hashPassword(newPassword));

      // clear reset state
      user.reset.completedAt = nowIso();
      user.reset.tokenHash = null;
      user.reset.tokenExpiresAt = null;
      user.reset.otpHash = null;
      user.reset.otpExpiresAt = null;
      user.reset.otpSentAt = null;
      user.reset.otpAttempts = 0;

      org.audit = Array.isArray(org.audit) ? org.audit : [];
      org.audit.unshift({
        id: crypto.randomBytes(8).toString("hex"),
        at: nowIso(),
        action: "password_reset_success",
        userId: user.userId,
        username: user.username
      });
      if (org.audit.length > 2000) org.audit.length = 2000;

      await saveOrg(orgId, org);

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e?.message || "Reset failed" });
    }
  });

  return router;
}
