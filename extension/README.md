# QuantumMail Enterprise Extension (MVP)

## What it does
- Login with orgId/username/password to get a JWT
- Encrypt selected text in Gmail compose:
  - Fetch active key version + key material
  - AES-GCM encrypt locally (WebCrypto)
  - POST ciphertext to backend (Model B)
  - Replace selection with share link `/m/<id>`
- Decrypt a link (paste into popup):
  - Fetch message by id
  - Fetch key by keyVersion
  - Decrypt locally

## Setup
1. Load unpacked in Chrome:
   - chrome://extensions -> Developer mode -> Load unpacked -> select this folder
2. In popup:
   - API Base: https://<codespace>-5173.app.github.dev
   - Org ID: org_demo
3. Seed admin + rotate key on backend, then create a member user.
4. Login in the extension with that member.

## Notes
- host_permissions include localhost and https://*.app.github.dev
- For production you'll likely add Outlook matches and improve editor insertion.
