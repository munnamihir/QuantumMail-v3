import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const portalDir = path.join(root, 'portal');
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'messages.json');

fs.mkdirSync(dataDir, { recursive: true });

function loadStore() {
  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { messages: {} };
  }
}

function saveStore(store) {
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), 'utf8');
}

const store = loadStore();

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// ⬆️ Increased limit for attachments-in-JSON MVP
app.use(express.json({ limit: '10mb' }));

// Static portal (compose, keygen, decrypt)
app.use('/portal', express.static(portalDir, {
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
}));

app.get('/', (_req, res) => {
  res.redirect('/portal/compose.html');
});

// Secure message link
app.get('/m/:id', (_req, res) => {
  res.sendFile(path.join(portalDir, 'decrypt.html'));
});

// --- API ---

app.post('/api/messages', (req, res) => {
  const body = req.body || {};

  // Minimal validation (body ciphertext)
  const required = ['mode', 'ciphertext', 'iv', 'alg'];
  for (const k of required) {
    if (typeof body[k] !== 'string' || body[k].length === 0) {
      return res.status(400).json({ error: `Missing or invalid field: ${k}` });
    }
  }

  // Optional attachments validation
  if (body.attachments != null) {
    if (!Array.isArray(body.attachments)) {
      return res.status(400).json({ error: 'attachments must be an array' });
    }
    for (const [i, a] of body.attachments.entries()) {
      const reqA = ['name', 'mimeType', 'ciphertext', 'iv', 'alg'];
      for (const k of reqA) {
        if (typeof a?.[k] !== 'string' || a[k].length === 0) {
          return res.status(400).json({ error: `Invalid attachments[${i}].${k}` });
        }
      }
      if (a.size != null && typeof a.size !== 'number') {
        return res.status(400).json({ error: `Invalid attachments[${i}].size` });
      }
    }
  }

  const id = nanoid(12);
  store.messages[id] = {
    id,
    createdAt: new Date().toISOString(),
    ...body
  };
  saveStore(store);

  return res.json({
    id,
    url: `${req.protocol}://${req.get('host')}/m/${id}`
  });
});

app.get('/api/messages/:id', (req, res) => {
  const msg = store.messages[req.params.id];
  if (!msg) return res.status(404).json({ error: 'Not found' });
  return res.json(msg);
});

const port = process.env.PORT ? Number(process.env.PORT) : 5173;
app.listen(port, () => {
  console.log(`QuantumMail server running on http://localhost:${port}`);
  console.log(`Portal: http://localhost:${port}/portal/compose.html`);
});
