export const el = (id) => document.getElementById(id);

export function setStatus(statusEl, msg, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.style.color = isError ? '#b00020' : '#666';
}

export async function copyToClipboard(text) {
  await navigator.clipboard.writeText(text);
}

// ArrayBuffer <-> base64
export function abToB64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64ToAb(b64) {
  const bin = atob(String(b64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function randBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// PBKDF2 -> AES key
export async function deriveAesKeyFromPassphrase(passphrase, saltBytes, iterations = 200000) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(passphrase || '')),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: Number(iterations) || 200000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// AES-GCM encrypt (accepts string OR Uint8Array)
export async function aesGcmEncrypt(aesKey, plaintextOrBytes) {
  const ptBytes =
    plaintextOrBytes instanceof Uint8Array
      ? plaintextOrBytes
      : new TextEncoder().encode(String(plaintextOrBytes ?? ''));

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, ptBytes);
  return { iv, ct: new Uint8Array(ctBuf) };
}

// AES-GCM decrypt -> Uint8Array
export async function aesGcmDecryptToBytes(aesKey, ivBytes, ctBytes) {
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, aesKey, ctBytes);
  return new Uint8Array(ptBuf);
}
