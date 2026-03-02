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

export async function aesEncrypt(plaintext, aadText = "outlook") {
  const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ptBytes = new TextEncoder().encode(String(plaintext || ""));
  const aadBytes = new TextEncoder().encode(String(aadText || ""));

  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aadBytes },
    dek,
    ptBytes
  );

  const rawDek = new Uint8Array(await crypto.subtle.exportKey("raw", dek));
  return {
    ivB64Url: bytesToB64Url(iv),
    ctB64Url: bytesToB64Url(new Uint8Array(ct)),
    aad: aadText,
    rawDek
  };
}

export async function rsaWrapDek(recipientPublicKey, rawDekBytes) {
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, recipientPublicKey, rawDekBytes);
  return bytesToB64Url(new Uint8Array(wrapped));
}

export async function encryptBytesWithRawDek(rawDekBytes, plainBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawDekBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);
  return { ivB64Url: bytesToB64Url(iv), ctB64Url: bytesToB64Url(new Uint8Array(ct)) };
}
