// extension/qm.js

export const DEFAULTS = { serverBase: "", token: "", user: null };

// accept "quantummail.onrender.com" -> "https://quantummail.onrender.com"
export function normalizeBase(url) {
  let s = String(url || "").trim();
  if (s && !/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

export async function getSession() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (v) => resolve(v || DEFAULTS));
  });
}
export async function setSession(patch) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(patch, () => resolve());
  });
}
export async function clearSession() {
  return setSession({ ...DEFAULTS });
}

/* ---------- Base64 helpers ---------- */
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
export function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function bytesToB64Url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export function b64UrlToBytes(b64url) {
  let b64 = String(b64url || "").replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return b64ToBytes(b64);
}

/* =========================================================
   RSA keypairs PER USER (local)
========================================================= */
function rsaStorageKey(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  return `qm_rsa_${id}`;
}

export async function getOrCreateRsaKeypair(userId) {
  const key = rsaStorageKey(userId);
  if (!key) throw new Error("Missing userId for RSA keypair.");

  const existing = await new Promise((resolve) => {
    chrome.storage.local.get({ [key]: null }, (v) => resolve(v[key]));
  });

  if (existing?.privateJwk && existing?.publicJwk) {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      existing.privateJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["decrypt"]
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      existing.publicJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"]
    );
    return { privateKey, publicKey };
  }

  const kp = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"]
  );

  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);

  await new Promise((resolve) => {
    chrome.storage.local.set(
      { [key]: { privateJwk, publicJwk, createdAt: new Date().toISOString() } },
      () => resolve()
    );
  });

  return { privateKey: kp.privateKey, publicKey: kp.publicKey };
}

export async function exportPublicSpkiB64(publicKey) {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return bytesToB64(new Uint8Array(spki));
}

export async function importPublicSpkiB64(publicKeySpkiB64) {
  const spkiBytes = b64ToBytes(publicKeySpkiB64);
  return crypto.subtle.importKey(
    "spki",
    spkiBytes,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"]
  );
}

/* =========================================================
   AES-GCM helpers (message encryption)
========================================================= */
export async function aesEncrypt(plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const enc = new TextEncoder().encode(String(plaintext || ""));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const rawKey = await crypto.subtle.exportKey("raw", key);
  return {
    ivB64: bytesToB64(iv),
    ciphertextB64: bytesToB64(new Uint8Array(ct)),
    dekRawB64: bytesToB64(new Uint8Array(rawKey)),
  };
}

export async function aesDecrypt(ivB64, ciphertextB64, dekRawB64) {
  const iv = b64ToBytes(ivB64);
  const ct = b64ToBytes(ciphertextB64);
  const rawKey = b64ToBytes(dekRawB64);
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/* =========================================================
   RSA wrap/unwarp DEK
========================================================= */
export async function rsaWrapDek(publicKey, dekRawB64) {
  const dekRaw = b64ToBytes(dekRawB64);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, dekRaw);
  return bytesToB64(new Uint8Array(wrapped));
}

export async function rsaUnwrapDek(privateKey, wrappedDekB64) {
  const wrapped = b64ToBytes(wrappedDekB64);
  const dekRaw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, wrapped);
  return bytesToB64(new Uint8Array(dekRaw));
}

/* =========================================================
   Public key registration (existing idea)
========================================================= */
export async function ensureKeypairAndRegister({ serverBase, token, user }) {
  if (!serverBase || !token || !user?.id) throw new Error("Missing session/user for key registration.");

  const { privateKey, publicKey } = await getOrCreateRsaKeypair(user.id);
  const publicKeySpkiB64 = await exportPublicSpkiB64(publicKey);

  const base = normalizeBase(serverBase);
  const res = await fetch(`${base}/org/register-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ publicKeySpkiB64 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Key register failed (${res.status})`);

  return { privateKey, publicKey };
}

/* =========================================================
   NEW: Zero-knowledge key backup + restore
========================================================= */

// PBKDF2(passphrase, salt) -> AES-GCM key
async function deriveAesKeyFromPassphrase(passphrase, saltBytes, iterations = 250000) {
  const passBytes = new TextEncoder().encode(String(passphrase || ""));
  const baseKey = await crypto.subtle.importKey("raw", passBytes, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createEncryptedKeyBackup(userId, passphrase) {
  const key = rsaStorageKey(userId);
  if (!key) throw new Error("Missing userId");

  const existing = await new Promise((resolve) => {
    chrome.storage.local.get({ [key]: null }, (v) => resolve(v[key]));
  });
  if (!existing?.privateJwk) throw new Error("No private key found locally to backup.");

  const payloadJson = JSON.stringify({ privateJwk: existing.privateJwk });

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveAesKeyFromPassphrase(passphrase, salt, 250000);

  const pt = new TextEncoder().encode(payloadJson);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, pt);

  return {
    v: 1,
    algo: "PBKDF2-SHA256/AES-GCM",
    saltB64: bytesToB64(salt),
    ivB64: bytesToB64(iv),
    ciphertextB64: bytesToB64(new Uint8Array(ct)),
    kdf: { iterations: 250000 },
  };
}

export async function restoreKeyFromBackup(userId, passphrase, keyBackup) {
  const key = rsaStorageKey(userId);
  if (!key) throw new Error("Missing userId");
  if (!keyBackup?.saltB64 || !keyBackup?.ivB64 || !keyBackup?.ciphertextB64) {
    throw new Error("Invalid backup payload");
  }

  const salt = b64ToBytes(keyBackup.saltB64);
  const iv = b64ToBytes(keyBackup.ivB64);
  const ct = b64ToBytes(keyBackup.ciphertextB64);

  const iterations = keyBackup?.kdf?.iterations || 250000;
  const aesKey = await deriveAesKeyFromPassphrase(passphrase, salt, iterations);

  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ct);
  const obj = JSON.parse(new TextDecoder().decode(pt));

  if (!obj?.privateJwk) throw new Error("Backup did not contain privateJwk");

  // Need public key too — regenerate public from private by importing and exporting public is not possible for RSA-OAEP.
  // So we keep existing publicJwk if present, else you’ll re-register by generating a new pair.
  const existing = await new Promise((resolve) => {
    chrome.storage.local.get({ [key]: null }, (v) => resolve(v[key]));
  });

  await new Promise((resolve) => {
    chrome.storage.local.set(
      {
        [key]: {
          privateJwk: obj.privateJwk,
          publicJwk: existing?.publicJwk || null,
          restoredAt: new Date().toISOString(),
        },
      },
      () => resolve()
    );
  });

  return true;
}
