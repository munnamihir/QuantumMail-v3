// portal/policies.js
const $ = (id) => document.getElementById(id);

function getToken() { return localStorage.getItem("qm_token") || ""; }
function getUser() {
  try { return JSON.parse(localStorage.getItem("qm_user") || "null"); }
  catch { return null; }
}
function requireAdminOrBounce() {
  const t = getToken();
  const u = getUser();
  const ok = Boolean(t && u && (u.role === "Admin" || u.role === "SuperAdmin"));
  if (!ok) window.location.href = "/portal/index.html";
  return ok;
}

async function api(path, { method="GET", body=null } = {}) {
  const token = getToken();
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function setOk(msg){ const el=$("ok"); if(el) el.textContent = msg || ""; }
function setErr(msg){ const el=$("err"); if(el) el.textContent = msg || ""; }

async function load() {
  setOk(""); setErr("");
  requireAdminOrBounce();

  const out = await api("/admin/policies");
  const p = out.policies || {};

  $("forceAttachmentEncryption").checked = !!p.forceAttachmentEncryption;
  $("disablePassphraseMode").checked = !!p.disablePassphraseMode;
  $("requireReauthForDecrypt").checked = !!p.requireReauthForDecrypt;
  $("enforceKeyRotationDays").value = String(p.enforceKeyRotationDays || 0);

  setOk("Loaded ✅");
}

async function save() {
  setOk(""); setErr("");
  requireAdminOrBounce();

  const body = {
    forceAttachmentEncryption: $("forceAttachmentEncryption").checked,
    disablePassphraseMode: $("disablePassphraseMode").checked,
    requireReauthForDecrypt: $("requireReauthForDecrypt").checked,
    enforceKeyRotationDays: parseInt($("enforceKeyRotationDays").value || "0", 10) || 0
  };

  const out = await api("/admin/policies", { method:"POST", body });
  setOk(`Saved ✅\n${JSON.stringify(out.policies, null, 2)}`);
}

$("btnLoad")?.addEventListener("click", () => load().catch(e => setErr(e.message)));
$("btnSave")?.addEventListener("click", () => save().catch(e => setErr(e.message)));

load().catch(() => {});
