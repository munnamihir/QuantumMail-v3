import { exportPublicSpkiB64 } from "./qm-crypto.js";

function hasOfficeRuntimeStorage() {
  return typeof OfficeRuntime !== "undefined" && OfficeRuntime?.storage?.getItem;
}

function rsaStorageKey(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  return `qm_rsa_${id}`;
}

async function storageGet(key) {
  if (hasOfficeRuntimeStorage()) return OfficeRuntime.storage.getItem(key);
  return Promise.resolve(localStorage.getItem(key));
}

async function storageSet(key, val) {
  if (hasOfficeRuntimeStorage()) return OfficeRuntime.storage.setItem(key, val);
  localStorage.setItem(key, val);
}

function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

export async function getOrCreateRsaKeypair(userId) {
  const key = rsaStorageKey(userId);
  if (!key) throw new Error("Missing userId for RSA keypair.");

  const existingRaw = await storageGet(key);
  const existing = existingRaw ? safeJson(existingRaw) : null;

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
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );

  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);

  await storageSet(key, JSON.stringify({ privateJwk, publicJwk, createdAt: new Date().toISOString() }));
  return { privateKey: kp.privateKey, publicKey: kp.publicKey };
}

export async function getMyPublicSpkiB64(userId) {
  const { publicKey } = await getOrCreateRsaKeypair(userId);
  return exportPublicSpkiB64(publicKey);
}
