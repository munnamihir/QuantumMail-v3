import mlkem from './vendor/mlkem.js';
import { el, setStatus, copyToClipboard, abToB64, b64ToAb } from './util.js';

const pubOut = el('pubOut');
const seedOut = el('seedOut');
const statusEl = el('status');

const LS_KEY = 'quantummail_seed_b64';

async function renderFromSeed(seedB64) {
  const priv = await mlkem.importKey(
    'raw-seed',
    b64ToAb(seedB64),
    { name: 'ML-KEM-768' },
    true,
    ['decapsulateKey']
  );
  const pub = await mlkem.getPublicKey(priv, ['encapsulateKey']);
  const pubRaw = await mlkem.exportKey('raw-public', pub);

  pubOut.textContent = abToB64(pubRaw);
  seedOut.textContent = seedB64;
}

async function generateNew() {
  setStatus(statusEl, 'Generating…');
  const { publicKey, privateKey } = await mlkem.generateKey(
    { name: 'ML-KEM-768' },
    true,
    ['encapsulateKey', 'decapsulateKey']
  );

  const pubRaw = await mlkem.exportKey('raw-public', publicKey);
  const seedRaw = await mlkem.exportKey('raw-seed', privateKey);

  pubOut.textContent = abToB64(pubRaw);
  seedOut.textContent = abToB64(seedRaw);
  setStatus(statusEl, 'Keys generated.');
}

el('genBtn').addEventListener('click', async () => {
  try {
    await generateNew();
  } catch (err) {
    console.error(err);
    setStatus(statusEl, err.message || 'Failed', true);
  }
});

el('loadBtn').addEventListener('click', async () => {
  try {
    const seedB64 = localStorage.getItem(LS_KEY);
    if (!seedB64) {
      setStatus(statusEl, 'No saved seed found in this browser.', true);
      return;
    }
    await renderFromSeed(seedB64);
    setStatus(statusEl, 'Loaded saved keys.');
  } catch (err) {
    console.error(err);
    setStatus(statusEl, err.message || 'Failed', true);
  }
});

el('copyPub').addEventListener('click', async () => {
  if (pubOut.textContent.trim() === '—') return;
  await copyToClipboard(pubOut.textContent.trim());
  setStatus(statusEl, 'Copied public key.');
});

el('copySeed').addEventListener('click', async () => {
  if (seedOut.textContent.trim() === '—') return;
  await copyToClipboard(seedOut.textContent.trim());
  setStatus(statusEl, 'Copied private seed.');
});

el('saveSeed').addEventListener('click', async () => {
  const seedB64 = seedOut.textContent.trim();
  if (!seedB64 || seedB64 === '—') return;
  localStorage.setItem(LS_KEY, seedB64);
  setStatus(statusEl, 'Saved in this browser (localStorage).');
});

// Auto-load saved seed if present
(async () => {
  try {
    const seedB64 = localStorage.getItem(LS_KEY);
    if (seedB64) await renderFromSeed(seedB64);
  } catch {
    // ignore
  }
})();
