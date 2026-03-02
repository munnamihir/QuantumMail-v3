import express from "express";
import crypto from "crypto";
import { getOrg } from "./orgStore.js";

// in-memory challenge store (good for MVP). Replace w/ Redis later.
const CH = new Map(); // id -> { orgId, usernameLower, nonceB64, expMs }

function now() { return Date.now(); }
function b64(buf) { return Buffer.from(buf).toString("base64"); }

export function mountChallengeAuthRoutes(app, { signToken }) {
  const router = express.Router();

  // POST /auth/challenge  { orgId, username }
  router.post("/challenge", async (req, res) => {
    const orgId = String(req.body?.orgId || "").trim();
    const username = String(req.body?.username || "").trim();
    if (!orgId || !username) return res.status(400).json({ error: "orgId and username required" });

    const id = crypto.randomBytes(16).toString("hex");
    const nonce = crypto.randomBytes(32);
    const expMs = now() + 2 * 60 * 1000; // 2 minutes

    CH.set(id, { orgId, usernameLower: username.toLowerCase(), nonceB64: b64(nonce), expMs });
    res.json({ ok: true, challengeId: id, nonceB64: b64(nonce), expiresInSec: 120 });
  });

  // POST /auth/challenge/verify { orgId, username, challengeId, signatureB64 }
  // signature is RSA-PSS over the raw nonce bytes
  router.post("/challenge/verify", async (req, res) => {
    const orgId = String(req.body?.orgId || "").trim();
    const username = String(req.body?.username || "").trim();
    const challengeId = String(req.body?.challengeId || "").trim();
    const signatureB64 = String(req.body?.signatureB64 || "").trim();

    if (!orgId || !username || !challengeId || !signatureB64) {
      return res.status(400).json({ error: "orgId, username, challengeId, signatureB64 required" });
    }

    const entry = CH.get(challengeId);
    if (!entry) return res.status(403).json({ error: "Invalid challenge" });
    if (entry.orgId !== orgId || entry.usernameLower !== username.toLowerCase()) {
      return res.status(403).json({ error: "Challenge mismatch" });
    }
    if (entry.expMs < now()) {
      CH.delete(challengeId);
      return res.status(403).json({ error: "Challenge expired" });
    }

    const org = await getOrg(orgId);
    const u = (org.users || []).find(
      (x) => String(x.username || "").toLowerCase() === username.toLowerCase()
    );
    if (!u?.publicKeySpkiB64) return res.status(403).json({ error: "No public key registered for this user" });

    const nonceBytes = Buffer.from(entry.nonceB64, "base64");
    const sigBytes = Buffer.from(signatureB64, "base64");

    // verify RSA-PSS SHA-256
    try {
      const pubDer = Buffer.from(u.publicKeySpkiB64, "base64");
      const pubKey = crypto.createPublicKey({ key: pubDer, format: "der", type: "spki" });
      const ok = crypto.verify(
        "sha256",
        nonceBytes,
        { key: pubKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        sigBytes
      );
      if (!ok) return res.status(403).json({ error: "Signature invalid" });
    } catch (e) {
      return res.status(403).json({ error: "Signature verify failed" });
    } finally {
      CH.delete(challengeId);
    }

    const payload = {
      userId: u.userId,
      orgId,
      role: u.role,
      username: u.username,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 2 * 60 * 60, // 2 hours
    };
    const token = signToken(payload);

    res.json({
      ok: true,
      token,
      user: {
        userId: u.userId,
        orgId,
        username: u.username,
        role: u.role,
        status: u.status || "Active",
        hasPublicKey: true,
        publicKeyRegisteredAt: u.publicKeyRegisteredAt || null
      }
    });
  });

  app.use("/auth", router);
}
