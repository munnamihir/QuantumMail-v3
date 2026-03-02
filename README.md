# QuantumMail – Organization-Based Email Encryption using Extension and online platform to keep track

QuantumMail is a client-side envelope encryption platform designed to securely share sensitive email content and attachments within organizations.

It enables users to encrypt selected portions of email messages such that:
- Only intended recipients can decrypt the content
- Plaintext data is never stored server-side
- Access is restricted to verified organization members
- No shared passphrases are required

QuantumMail integrates directly into web-based email workflows via browser runtime without requiring changes to the email provider infrastructure.


----------------------
## Why QuantumMail?

Most traditional email encryption solutions depend on:

- Shared passphrases  
- Transport-layer encryption  
- Centralized key recovery  

These introduce risks such as:

- Insider access to plaintext  
- Credential compromise  
- Server-side exposure  
- Harvest Now, Decrypt Later (HNDL) attacks  

QuantumMail implements:

Client-side envelope encryption with per-recipient key wrapping and organization-bound decryption.

All encryption and decryption operations occur only on the user’s device.

---

## Architecture Overview

QuantumMail uses:

- AES-256-GCM for message and attachment encryption  
- RSA-OAEP-SHA256 for per-recipient key wrapping  
- Device-generated user keypairs  
- Organization-based public key registry  
- Server-side encrypted message storage using KEK keyring  

Private keys never leave the user's device.

---

## Encryption Flow

1. User logs into their organization  
2. User selects email content and optional attachments  
3. Client generates a Data Encryption Key (DEK)  
4. Email content encrypted locally  
5. Attachments encrypted locally  
6. DEK wrapped individually using each recipient’s public key  
7. Encrypted payload stored server-side  
8. Secure access link inserted into the email  

---

## Decryption Flow

1. Recipient opens secure link  
2. Recipient logs into the same organization  
3. Client retrieves wrapped DEK  
4. DEK unwrapped using recipient’s private key  
5. Content decrypted locally  

The server never has access to plaintext content.

---

## Organization-Based Encryption

Each organization maintains:

- Registered users  
- Public key registry  
- Encryption policies  
- Audit logs  
- Key rotation support  
- Server KEK keyring  

Encryption access is governed via:

/auth/login  
/org/register-key  
/org/users  
/api/messages  


Only users with registered public keys inside the same organization and are included in recipient list can decrypt messages.
---
## Secure Organization Provisioning

QuantumMail supports secure organization onboarding and administrator provisioning through an email-based setup workflow.

Organization setup includes:

- Organization request submission  
- SuperAdmin approval  
- Setup token generation  
- OTP-based email verification  
- Initial Admin password setup  
- Invite-based Member onboarding  

Transactional emails for:

- Admin setup  
- OTP verification  
- Account recovery  
- Organization approval / rejection  

are delivered using Brevo to ensure reliable and verifiable account provisioning.

This enables controlled onboarding of enterprise users without exposing credentials or private key material during setup.

---
## Features

- Encrypt email body text  
- Encrypt file attachments  
- Restrict access to selected recipients  
- Organization-wide public key registry  
- Secure link-based delivery  
- Per-recipient DEK wrapping  
- Device-bound private keys  
- Admin policy enforcement  
- Audit logging  
- Server-side KEK-encrypted message storage
- Email-based organization onboarding   

---

## Tech Stack

### Client-side:
- Chrome Extension (Manifest V3)  
- WebCrypto API  

### Server:
- Node.js + Express  
- Neon PostgreSQL  
- JSONB Org Store  
- AES-GCM (Node Crypto)  
- HMAC-SHA256 Token Signing
- Brevo Transactional Email   

### Deployment:
- Render  

---

## Live Backend

https://quantummail-v2.onrender.com

---

## Installation

Load unpacked extension from:

/extension

Login using your organization credentials.

---
##  Security Model

QuantumMail ensures:
- Client-side encryption only  
- No plaintext stored server-side  
- No shared encryption keys  
- Per-recipient access control  
- Device-bound decryption  
- Policy-based reauthentication
- Verified email-based account setup

Attachments are encrypted using the same DEK as the email body.
---

## Data Handling

 -------------------- --------------------
| Stored Server-Side |     Not Stored     |
|--------------------|--------------------|
| Encrypted Payload  | Plaintext Content  |
| Wrapped DEKs       | Private Keys       |
| Audit Metadata     | Email Body         |
| Org Policies       | User Files         |
 -------------------- --------------------
Private keys are never transmitted to the server.

---

## Roadmap

- Mobile Runtime Support  
- PQC-Ready Key Wrapping  
- Admin Dashboard  
- Key Rotation Enforcement  
- Decryption Policy Engine  

---

## Use Cases

- Internal secure communications  
- Financial institutions  
- Healthcare providers  
- Government agencies  
- Legal firms  
- Enterprise SaaS companies  

---

## License

MIT License

---

## Contact

For enterprise deployment or pilot programs:

quantummail-v2@gmail.com

Developer: Mihir Bommisetty
LinkedIn: www.linkedin.com/in/mihirbommisetty
