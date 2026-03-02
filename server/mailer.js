// server/mailer.js
import fetch from "node-fetch";

const PROVIDER = (process.env.QM_EMAIL_PROVIDER || "brevo").toLowerCase();

const BREVO_API_KEY = process.env.QM_BREVO_API_KEY || "";
const FROM_EMAIL = process.env.QM_FROM_EMAIL || "";
const FROM_NAME = process.env.QM_FROM_NAME || "QuantumMail";

function requireEnv(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
}

export async function sendMail({ to, subject, html, text }) {
  if (PROVIDER !== "brevo") {
    throw new Error(`Unsupported email provider: ${PROVIDER}`);
  }

  requireEnv("QM_BREVO_API_KEY", BREVO_API_KEY);
  requireEnv("QM_FROM_EMAIL", FROM_EMAIL);

  const payload = {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email: to }],
    subject: subject || "",
    textContent: text || "",
    htmlContent: html || "",
  };

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();
  let bodyJson = null;
  try { bodyJson = JSON.parse(bodyText); } catch {}

  if (!res.ok) {
    const msg =
      (bodyJson && (bodyJson.message || bodyJson.error)) ||
      bodyText ||
      `Brevo API error HTTP ${res.status}`;
    throw new Error(msg);
  }

  // Brevo returns { messageId: "..." }
  return bodyJson || { ok: true };
}
