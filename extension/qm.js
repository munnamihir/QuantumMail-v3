/* =========================================================
   QuantumMail extension crypto + session helpers
   - RSA-OAEP: wrap/unwrap DEK
   - AES-GCM: message + attachment encryption
   - RSA-PSS: nonce signing (crypto login)
   - Zero-knowledge key backup (PBKDF2 + AES-GCM)
========================================================= */

export const DEFAULTS = { serverBase: "", token: "", user: null };

export function normalizeBase(url) {
  let s = String(url || "").trim();
  if (s && !/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

export async function getSession() {
  return new Promise((resolve) => chrome.storage.sync.get(DEFAULTS, (v) => resolve(v || DEFAULTS)));
}
export async function setSession(patch) {
  return new Promise((resolve) => chrome.storage.sync.set(patch, () => resolve()));
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
   Storage keys
========================================================= */
function rsaStorageKey(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  return `qm_rsa_${id}`;
}

/* =========================================================
   Keypair: store BOTH OAEP and PSS usage in one keypair
========================================================= */
export async function getOrCreateRsaKeypair(userId) {
  const key = rsaStorageKey(userId);
  if (!key) throw new Error("Missing userId for RSA keypair.");

  const existing = await new Promise((resolve) => {
    chrome.storage.local.get({ [key]: null }, (v) => resolve(v[key]));
  });

  if (existing?.privateJwk && existing?.publicJwk) {
    const privateKeyOAEP = await crypto.subtle.importKey(
      "jwk",
      existing.privateJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["decrypt"]
    );
    const publicKeyOAEP = await crypto.subtle.importKey(
      "jwk",
      existing.publicJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"]
    );

    const privateKeyPSS = await crypto.subtle.importKey(
      "jwk",
      existing.privateJwk,
      { name: "RSA-PSS", hash: "SHA-256" },
      true,
      ["sign"]
    );
    const publicKeyPSS = await crypto.subtle.importKey(
      "jwk",
      existing.publicJwk,
      { name: "RSA-PSS", hash: "SHA-256" },
      true,
      ["verify"]
    );

    return { privateKeyOAEP, publicKeyOAEP, privateKeyPSS, publicKeyPSS };
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

  // export/import as JWK so we can also use RSA-PSS on same material
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);

  await new Promise((resolve) => {
    chrome.storage.local.set(
      { [key]: { privateJwk, publicJwk, createdAt: new Date().toISOString() } },
      () => resolve()
    );
  });

  const privateKeyPSS = await crypto.subtle.importKey("jwk", privateJwk, { name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"]);
  const publicKeyPSS = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]);

  return { privateKeyOAEP: kp.privateKey, publicKeyOAEP: kp.publicKey, privateKeyPSS, publicKeyPSS };
}

export async function exportPublicSpkiB64(publicKeyOAEP) {
  const spki = await crypto.subtle.exportKey("spki", publicKeyOAEP);
  return bytesToB64(new Uint8Array(spki));
}
export async function importPublicSpkiB64(publicKeySpkiB64) {
  const spkiBytes = b64ToBytes(publicKeySpkiB64);
  return crypto.subtle.importKey("spki", spkiBytes, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
}

/* =========================================================
   AES-GCM (message)
========================================================= */
export async function aesEncrypt(plaintext, aad = "web") {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const enc = new TextEncoder().encode(String(plaintext || ""));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, enc);
  const rawKey = await crypto.subtle.exportKey("raw", key);
  return {
    ivB64Url: bytesToB64Url(iv),
    ctB64Url: bytesToB64Url(new Uint8Array(ct)),
    rawDek: new Uint8Array(rawKey),
  };
}

export async function aesDecrypt(ivB64Url, ctB64Url, aad = "web", rawDekBytes) {
  const iv = b64UrlToBytes(ivB64Url);
  const ct = b64UrlToBytes(ctB64Url);
  const key = await crypto.subtle.importKey("raw", rawDekBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, ct);
  return new TextDecoder().decode(pt);
}

/* =========================================================
   RSA wrap/unwarp DEK (OAEP)
========================================================= */
export async function rsaWrapDek(publicKeyOAEP, rawDekBytes) {
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKeyOAEP, rawDekBytes);
  return bytesToB64Url(new Uint8Array(wrapped));
}
export async function rsaUnwrapDek(privateKeyOAEP, wrappedDekB64Url) {
  const wrappedBytes = b64UrlToBytes(wrappedDekB64Url);
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKeyOAEP, wrappedBytes);
  return new Uint8Array(raw);
}

/* =========================================================
   RSA-PSS nonce signing (crypto login)
========================================================= */
export async function signNonceB64(privateKeyPSS, nonceB64) {
  const nonce = b64ToBytes(nonceB64);
  const sig = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, privateKeyPSS, nonce);
  return bytesToB64(new Uint8Array(sig));
}

/* =========================================================
   API helper
========================================================= */
export async function apiJson(base, path, { method = "GET", token = "", body = null } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/* =========================================================
   Public key registration (your existing flow)
========================================================= */
export async function ensureKeypairAndRegister(base, token, userId) {
  const { publicKeyOAEP } = await getOrCreateRsaKeypair(userId);
  const publicKeySpkiB64 = await exportPublicSpkiB64(publicKeyOAEP);
  await apiJson(base, "/org/register-key", {
    method: "POST",
    token,
    body: { publicKeySpkiB64 },
  });
}

/* =========================================================
   Zero-knowledge key backup (PBKDF2 + AES-GCM)
========================================================= */
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

  const payloadJson = JSON.stringify({ privateJwk: existing.privateJwk, publicJwk: existing.publicJwk || null });

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

  await new Promise((resolve) => {
    chrome.storage.local.set(
      {
        [key]: {
          privateJwk: obj.privateJwk,
          publicJwk: obj.publicJwk || null,
          restoredAt: new Date().toISOString(),
        },
      },
      () => resolve()
    );
  });

  return true;
}
