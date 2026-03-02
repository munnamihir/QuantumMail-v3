// server/emailTemplates.js
export function approvalEmail({ orgName, orgId, adminUsername, setupLink, expiresAt }) {
  const subject = `QuantumMail: ${orgName} approved — Admin setup link inside`;

  const text =
`Your QuantumMail organization request was approved.

Org Name: ${orgName}
Org ID: ${orgId}
Admin Username: ${adminUsername}

Setup Link (expires ${expiresAt}):
${setupLink}

If you did not request this, ignore this email.`;

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; background:#0b0f14; padding:24px; color:#e7eef8;">
    <div style="max-width:640px;margin:0 auto;background:#0f1620;border:1px solid #1d2a3a;border-radius:16px;overflow:hidden">
      <div style="padding:18px 18px;border-bottom:1px solid #1d2a3a;">
        <div style="font-weight:800;font-size:16px;">QuantumMail</div>
        <div style="color:#93a4b8;font-size:13px;margin-top:4px;">Organization approved • Admin setup</div>
      </div>

      <div style="padding:18px;">
        <div style="font-size:14px;line-height:1.5;">
          Your organization request has been <b>approved</b>.
        </div>

        <div style="margin-top:14px;padding:12px;border:1px solid #1d2a3a;border-radius:14px;background:#0b1220;">
          <div style="color:#93a4b8;font-size:12px;">Org Name</div>
          <div style="font-weight:700">${escapeHtml(orgName)}</div>
          <div style="height:10px"></div>
          <div style="color:#93a4b8;font-size:12px;">Org ID</div>
          <div style="font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;">${escapeHtml(orgId)}</div>
          <div style="height:10px"></div>
          <div style="color:#93a4b8;font-size:12px;">Admin Username</div>
          <div style="font-weight:700">${escapeHtml(adminUsername)}</div>
        </div>

        <div style="margin-top:16px;">
          <a href="${setupLink}" style="display:inline-block;padding:12px 14px;border-radius:12px;
            background:#6ee7ff;color:#07101f;font-weight:800;text-decoration:none;">
            Open Admin Setup Link
          </a>
          <div style="color:#93a4b8;font-size:12px;margin-top:10px;">
            Link expires: <span style="font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;">${escapeHtml(expiresAt)}</span>
          </div>
          <div style="color:#93a4b8;font-size:12px;margin-top:8px;">
            If you didn’t request this, you can ignore this email.
          </div>
        </div>
      </div>
    </div>
  </div>`;

  return { subject, text, html };
}

export function rejectionEmail({ orgName, reason }) {
  const subject = `QuantumMail: ${orgName} request update`;

  const text =
`Your QuantumMail organization request was rejected.

Org Name: ${orgName}
Reason: ${reason || "Not provided"}

You can submit a new request anytime.`;

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; background:#0b0f14; padding:24px; color:#e7eef8;">
    <div style="max-width:640px;margin:0 auto;background:#0f1620;border:1px solid #1d2a3a;border-radius:16px;">
      <div style="padding:18px;border-bottom:1px solid #1d2a3a;">
        <div style="font-weight:800;font-size:16px;">QuantumMail</div>
        <div style="color:#93a4b8;font-size:13px;margin-top:4px;">Organization request update</div>
      </div>
      <div style="padding:18px;">
        <div style="font-size:14px;line-height:1.5;">
          Your organization request for <b>${escapeHtml(orgName)}</b> was <b style="color:#fb7185;">rejected</b>.
        </div>
        ${reason ? `<div style="margin-top:12px;color:#93a4b8;font-size:13px;">
          Reason: <span style="color:#e7eef8">${escapeHtml(reason)}</span>
        </div>` : ``}
      </div>
    </div>
  </div>`;

  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
