// portal/setup-admin.js
const $ = (id) => document.getElementById(id);

function setErr(msg) {
  const el = $("err");
  if (el) el.textContent = msg || "";
}
function setOk(msg) {
  const el = $("ok");
  if (el) el.textContent = msg || "";
}

function mSetErr(msg) {
  const el = $("mErr");
  if (el) el.textContent = msg || "";
}
function mSetOk(msg) {
  const el = $("mOk");
  if (el) el.textContent = msg || "";
}

function qs() {
  const u = new URL(window.location.href);
  return {
    orgId: u.searchParams.get("orgId") || "",
    token: u.searchParams.get("token") || ""
  };
}

async function apiJson(path, { method = "GET", body = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const raw = await res.text().catch(() => "");
  let data = {};
  try { data = JSON.parse(raw || "{}"); } catch { data = { error: raw }; }

  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

function openModal() {
  const bd = $("backdrop");
  if (bd) bd.style.display = "flex";
}
function closeModal() {
  const bd = $("backdrop");
  if (bd) bd.style.display = "none";
}

function setVerifiedUi() {
  $("btnShowActivate").disabled = false;
  setOk("Email verified ✅ You can activate your admin account now.");
}

async function loadSetupInfo() {
  setErr("");
  setOk("");

  const { orgId, token } = qs();
  if (!orgId || !token) {
    setErr("Missing orgId/token in setup link.");
    return;
  }

  const info = await apiJson(`/public/setup-admin-info?orgId=${encodeURIComponent(orgId)}&token=${encodeURIComponent(token)}`);

  $("orgId").value = info.orgId || orgId;
  $("email").value = info.email || "";
  $("mEmail").value = info.email || "";

  // already verified?
  if (info.emailVerified) {
    setVerifiedUi();
  } else {
    $("btnShowActivate").disabled = true;
  }
}

async function sendCode() {
  mSetErr("");
  mSetOk("");

  const { orgId, token } = qs();
  if (!orgId || !token) throw new Error("Missing orgId/token.");

  const out = await apiJson("/auth/setup-admin/send-code", {
    method: "POST",
    body: { orgId, token }
  });

  if (out.alreadyVerified) {
    mSetOk("Already verified ✅");
    setVerifiedUi();
    closeModal();
    return;
  }

  mSetOk("Code sent ✅ Check your email.");
}

async function verifyCode() {
  mSetErr("");
  mSetOk("");

  const code = String($("mCode").value || "").trim();
  if (!/^\d{6}$/.test(code)) {
    mSetErr("Enter a valid 6-digit code.");
    return;
  }

  const { orgId, token } = qs();
  if (!orgId || !token) throw new Error("Missing orgId/token.");

  const out = await apiJson("/auth/setup-admin/verify-code", {
    method: "POST",
    body: { orgId, token, code }
  });

  if (out.alreadyVerified) {
    mSetOk("Already verified ✅");
  } else {
    mSetOk("Verified ✅");
  }

  setVerifiedUi();
  closeModal();
}

function showActivateBox() {
  const box = $("activateBox");
  if (box) box.style.display = "block";
  $("pw")?.focus();
}

async function activateNow() {
  setErr("");
  setOk("");

  const pw = String($("pw").value || "");
  if (pw.length < 12) {
    setErr("Password must be at least 12 characters.");
    return;
  }

  const { orgId, token } = qs();
  if (!orgId || !token) {
    setErr("Missing orgId/token.");
    return;
  }

  $("btnActivateNow").disabled = true;
  $("btnActivateNow").textContent = "Activating...";

  try {
    await apiJson("/auth/setup-admin", {
      method: "POST",
      body: { orgId, token, newPassword: pw }
    });

    // ✅ Redirect to login page and open login tab
    window.location.href = "/portal/index.html#login";
  } catch (e) {
    setErr(e?.message || String(e));
  } finally {
    $("btnActivateNow").disabled = false;
    $("btnActivateNow").textContent = "Activate";
  }
}

/* =========================
   Wire up buttons
========================= */
$("btnVerify")?.addEventListener("click", () => {
  mSetErr(""); mSetOk("");
  $("mCode").value = "";
  $("mEmail").value = $("email").value || "";
  openModal();
});

$("btnClose")?.addEventListener("click", () => closeModal());

$("backdrop")?.addEventListener("click", (e) => {
  // click outside modal closes
  if (e.target?.id === "backdrop") closeModal();
});

$("btnSendCode")?.addEventListener("click", () => {
  $("btnSendCode").disabled = true;
  sendCode()
    .catch((e) => mSetErr(e?.message || String(e)))
    .finally(() => ($("btnSendCode").disabled = false));
});

$("btnVerifyCode")?.addEventListener("click", () => {
  $("btnVerifyCode").disabled = true;
  verifyCode()
    .catch((e) => mSetErr(e?.message || String(e)))
    .finally(() => ($("btnVerifyCode").disabled = false));
});

$("btnShowActivate")?.addEventListener("click", () => showActivateBox());
$("btnActivateNow")?.addEventListener("click", () => activateNow());

/* =========================
   Init
========================= */
loadSetupInfo().catch((e) => setErr(e?.message || String(e)));
