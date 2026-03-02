# Security Policy

## Supported Versions

QuantumMail is currently under active development. Security updates are applied to the latest version of the platform.

| Version | Supported |
|---------|-----------|
Latest Release | ✅ Yes |
Older Versions | ❌ No |

---

## Reporting a Vulnerability

If you discover a security vulnerability within QuantumMail, please report it responsibly.

Do **NOT** disclose vulnerabilities publicly.

Instead, please contact:

quantummailv2@gmail.com

Include the following information:

- Description of the vulnerability  
- Steps to reproduce  
- Potential impact  
- Any proof-of-concept (if available)  

You will receive an acknowledgement as soon as developer takes a look at it.

---

## Encryption Model

QuantumMail implements a client-side envelope encryption model to ensure that:

- Encryption occurs on the sender’s device  
- Decryption occurs on the recipient’s device  
- Plaintext content is never stored server-side  

Encryption primitives used:

- AES-256-GCM for message and attachment encryption  
- RSA-OAEP-SHA256 for per-recipient key wrapping  
- Device-generated public/private keypairs  

Private keys are generated and stored locally within the client runtime and are never transmitted to the server.

---

## Data Storage

QuantumMail stores the following server-side:

- Encrypted message payloads  
- Wrapped Data Encryption Keys (DEKs)  
- Organization audit metadata  
- Encryption policy configurations  

QuantumMail does **NOT** store:

- Plaintext message content  
- Private keys  
- Decrypted attachments  

All stored message payloads are encrypted using an organization-specific KEK (Key Encryption Key) prior to persistence.

---

## Account Provisioning Security

Organization onboarding and administrator provisioning includes:

- Setup token generation  
- OTP-based email verification  
- Initial Admin password setup  
- Invite-based Member onboarding  

Transactional onboarding emails are delivered using Brevo to support:

- Account setup  
- OTP verification  
- Password recovery  
- Organization approval notifications  

Private key material is never transmitted during onboarding.

---

## Access Control

Message access is restricted by:

- Organization identity  
- Recipient public key registry  
- Policy-based authentication  
- Wrapped key ownership  

Only users with registered public keys within the same organization are capable of decrypting stored messages.

Unauthorized access attempts are logged within organization audit trails.

---

## Key Management

- Each user generates a device-bound RSA keypair  
- Public keys are registered with the organization  
- Private keys remain client-side  
- DEKs are wrapped individually per recipient  

Server-side KEK keyrings are used solely for encrypting stored payloads at rest.

---

## Secure Development Practices

QuantumMail follows:

- Client-side cryptographic operations  
- Token-based authentication  
- Timing-safe comparison methods  
- Encrypted data-at-rest storage  
- OTP verification for account setup  

Dependencies are periodically reviewed for known vulnerabilities.

---

## Compliance

QuantumMail is designed to align with:

- Zero Trust principles  
- Least privilege access  
- End-to-end encryption best practices  

Formal compliance certifications are under evaluation.

---

## Disclaimer

QuantumMail is provided "as is" without warranty of any kind and an active fixing of features rolling out as it is a development project.

Users are responsible for evaluating QuantumMail’s suitability for their organizational security requirements.
