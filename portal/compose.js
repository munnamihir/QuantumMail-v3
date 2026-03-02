import mlkem from './vendor/mlkem.js';
import {
  el, setStatus, copyToClipboard,
  abToB64, b64ToAb,
  randBytes,
  deriveAesKeyFromPassphrase,
  aesGcmEncrypt
} from './util.js';

const messageEl = el('message');
const resultEl = el('result');
const statusEl = el('status');
const recipientPkEl = el('recipientPk');
const passphraseEl = el('passphrase');
const attachmentsEl = el('attachments');
const pqcFields = document.getElementById('pqcFields');
const pwFields = document.getElementById('pwFields');

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

document.querySelectorAll('input[name="mode"]').forEach(r => {
  r.addEventListener('change', () => {
    const m = getMode();
    pqcFields.style.display = (m === 'pqc') ? '' : 'none';
    pwFields.style.display = (m === 'passphrase') ? '' : 'none';
    setStatus(statusEl, '');
    resultEl.textContent = '—';
  });
});

el('clearBtn').addEventListener('click', () => {
  messageEl.value = '';
  recipientPkEl.value = '';
  passphraseEl.value = '';
  if (attachmentsEl) attachmentsEl.value = '';
  resultEl.textContent = '—';
  setStatus(statusEl, '');
});

el('copyBtn').addEventListener('click', async () => {
  const text = resultEl.textContent.trim();
  if (!text || text === '—') return;
  await copyToClipboard(text);
  setStatus(statusEl, 'Copied to clipboard.');
});

const MAX_TOTAL_BYTES = 6_000_000; // ~6MB MVP total (tune)

async function encryptAttachments(aesKey) {
  const files = Array.from(attachmentsEl?.files || []);
  if (!files.length) return [];

  let total = 0;
  const out = [];

  for (const f of files) {
    total += (f.size || 0);
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`Attachments too large for MVP (~${Math.round(total/1024/1024)}MB). Reduce size.`);
    }

    const bytes = new Uint8Array(await f.arrayBuffer());
    const { iv, ct } = await aesGcmEncrypt(aesKey, bytes);

    out.push({
      name: f.name || 'attachment',
      mimeType: f.type || 'application/octet-stream',
      size: f.size || bytes.length,
      alg: 'AES-256-GCM',
      iv: abToB64(iv.buffer),
      ciphertext: abToB64(ct.buffer)
    });
  }

  return out;
}

el('encryptBtn').addEventListener('click', async () => {
  try {
    setStatus(statusEl, 'Encrypting…');
    const plaintext = messageEl.value || '';
    if (!plaintext.trim()) {
      setStatus(statusEl, 'Please enter a message.', true);
      return;
    }

    const mode = getMode();
    let aesKey;
    let kemCiphertextB64 = undefined;
    let saltB64 = undefined;

    if (mode === 'pqc') {
      const pkB64 = (recipientPkEl.value || '').trim();
      if (!pkB64) {
        setStatus(statusEl, 'Paste the recipient public key (base64).', true);
        return;
      }

      const recipientPk = await mlkem.importKey(
        'raw-public',
        b64ToAb(pkB64),
        { name: 'ML-KEM-768' },
        true,
        ['encapsulateKey']
      );

      const enc = await mlkem.encapsulateKey(
        { name: 'ML-KEM-768' },
        recipientPk,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );

      aesKey = enc.sharedKey;
      kemCiphertextB64 = abToB64(enc.ciphertext);
    } else {
      const pw = (passphraseEl.value || '').trim();
      if (!pw) {
        setStatus(statusEl, 'Enter a passphrase.', true);
        return;
      }
      const salt = randBytes(16);
      saltB64 = abToB64(salt.buffer);
      aesKey = await deriveAesKeyFromPassphrase(pw, salt, 200000);
    }

    // Encrypt body
    const { iv, ct } = await aesGcmEncrypt(aesKey, plaintext);

    // Encrypt attachments using SAME AES key
    const attachments = await encryptAttachments(aesKey);

    const payload = {
      mode,
      alg: 'AES-256-GCM',
      iv: abToB64(iv.buffer),
      ciphertext: abToB64(ct.buffer),
      ...(saltB64 ? { salt: saltB64, kdf: 'PBKDF2-SHA256', kdfIterations: '200000' } : {}),
      ...(kemCiphertextB64 ? { kem: { alg: 'ML-KEM-768', ciphertext: kemCiphertextB64 } } : {}),
      attachments
    };

    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Server error (${res.status})`);
    }

    const out = await res.json();
    resultEl.textContent = out.url;
    setStatus(statusEl, attachments.length
      ? `Link generated. Encrypted ${attachments.length} attachment(s).`
      : 'Link generated.'
    );
  } catch (err) {
    console.error(err);
    setStatus(statusEl, (err && err.message) ? err.message : 'Encryption failed', true);
  }
});
