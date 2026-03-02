const $ = (id) => document.getElementById(id);
function ok(msg){ const el=$("ok"); if(el) el.textContent = msg || ""; }
function err(msg){ const el=$("err"); if(el) el.textContent = msg || ""; }

function q(name){
  const u = new URL(window.location.href);
  return u.searchParams.get(name) || "";
}

async function api(path, { method="GET", body=null } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function boot() {
  const orgId = q("orgId");
  const token = q("token");
  $("orgId").value = orgId;
  $("token").value = token;

  if (!orgId || !token) {
    err("Invalid reset link. Please request a new reset from the Login page.");
    $("btnSendCode").disabled = true;
    $("btnReset").disabled = true;
  }
}

async function sendCode() {
  ok(""); err("");
  const orgId = $("orgId").value;
  const token = $("token").value;

  await api("/auth/reset/send-code", { method: "POST", body: { orgId, token } });
  ok("Code sent ✅ Check your email.");
}

async function doReset() {
  ok(""); err("");
  const orgId = $("orgId").value;
  const token = $("token").value;
  const code = String($("code").value || "").trim();
  const pw1 = String($("newPassword").value || "");
  const pw2 = String($("newPassword2").value || "");

  if (!code || code.length !== 6) return err("Enter the 6-digit code.");
  if (!pw1 || pw1.length < 12) return err("New password must be at least 12 characters.");
  if (pw1 !== pw2) return err("Password confirmation does not match.");

  await api("/auth/reset/confirm", {
    method: "POST",
    body: { orgId, token, code, newPassword: pw1 }
  });

  ok("Password updated ✅ Redirecting to Login…");

  setTimeout(() => {
    window.location.href = `/portal/index.html?tab=login&orgId=${encodeURIComponent(orgId)}`;
  }, 900);
}

$("btnSendCode")?.addEventListener("click", () => sendCode().catch(e => err(e.message)));
$("btnReset")?.addEventListener("click", () => doReset().catch(e => err(e.message)));

boot();
