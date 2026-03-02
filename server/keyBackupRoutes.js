import express from "express";
import { getOrg, saveOrg } from "./orgStore.js";

/**
 * Zero-knowledge key backup:
 * - Extension encrypts private key locally using passphrase-derived AES key (PBKDF2 + AES-GCM)
 * - Server stores only ciphertext in org JSON store
 * - Restore requires extension + passphrase
 */

function fromB64(s) {
  return Buffer.from(String(s || ""), "base64");
}

export function mountKeyBackupRoutes(app, requireAuth) {
  const router = express.Router();

  // GET /org/key-backup/status
  router.get("/status", requireAuth, async (req, res) => {
    const { orgId, username } = req.qm?.tokenPayload || {};
    const org = await getOrg(orgId);
    const u = (org.users || []).find((x) => x.username === username);
    res.json({
      ok: true,
      hasBackup: Boolean(u?.keyBackup),
      createdAt: u?.keyBackup?.createdAt || null,
    });
  });

  // POST /org/key-backup
  router.post("/", requireAuth, async (req, res) => {
    const { orgId, username } = req.qm?.tokenPayload || {};
    const { v = 1, algo, saltB64, ivB64, ciphertextB64, kdf } = req.body || {};

    if (!algo || !saltB64 || !ivB64 || !ciphertextB64) {
      return res
        .status(400)
        .json({ error: "Missing fields: algo, saltB64, ivB64, ciphertextB64" });
    }

    // sanity checks
    if (fromB64(saltB64).length < 8) return res.status(400).json({ error: "saltB64 too short" });
    if (fromB64(ivB64).length < 12) return res.status(400).json({ error: "ivB64 invalid" });
    if (fromB64(ciphertextB64).length < 32)
      return res.status(400).json({ error: "ciphertextB64 too short" });

    const org = await getOrg(orgId);
    org.users = org.users || [];

    const idx = org.users.findIndex((x) => x.username === username);
    if (idx < 0) return res.status(404).json({ error: "User not found in org" });

    org.users[idx].keyBackup = {
      v,
      algo,
      saltB64,
      ivB64,
      ciphertextB64,
      kdf: kdf || { iterations: 250000 },
      createdAt: new Date().toISOString(),
    };

    await saveOrg(orgId, org);
    res.json({ ok: true });
  });

  // GET /org/key-backup
  router.get("/", requireAuth, async (req, res) => {
    const { orgId, username } = req.qm?.tokenPayload || {};
    const org = await getOrg(orgId);
    const u = (org.users || []).find((x) => x.username === username);
    if (!u?.keyBackup) return res.status(404).json({ error: "No backup found" });
    res.json({ ok: true, keyBackup: u.keyBackup });
  });

  // DELETE /org/key-backup
  router.delete("/", requireAuth, async (req, res) => {
    const { orgId, username } = req.qm?.tokenPayload || {};
    const org = await getOrg(orgId);
    const u = (org.users || []).find((x) => x.username === username);
    if (!u) return res.status(404).json({ error: "User not found in org" });
    delete u.keyBackup;
    await saveOrg(orgId, org);
    res.json({ ok: true });
  });

  app.use("/org/key-backup", router);
}
