// /portal/recover.js
(() => {
  const $ = (id) => document.getElementById(id);

  const apiBaseEl = $("apiBase");
  const orgIdEl = $("orgId");
  const emailEl = $("email");

  const usernameBtn = $("usernameBtn");
  const resetLinkBtn = $("resetLinkBtn");
  const saveBtn = $("saveBtn");
  const openResetLink = $("openResetLink");

  const msg1 = $("msg1");
  const err1 = $("err1");

  const tokenEl = $("token");
  const codeEl = $("code");
  const newPwEl = $("newPw");

  const sendCodeBtn = $("sendCodeBtn");
  const completeBtn = $("completeBtn");

  const msg2 = $("msg2");
  const err2 = $("err2");

  const LS_BASE = "qm_api_base";
  const LS_ORG = "qm_org_id";
  const LS_EMAIL = "qm_recovery_email";

  function set1(okMsg = "", errMsg = "") {
    if (msg1) msg1.textContent = String(okMsg || "");
    if (err1) err1.textContent = String(errMsg || "");
  }

  function set2(okMsg = "", errMsg = "") {
    if (msg2) msg2.textContent = String(okMsg || "");
    if (err2) err2.textContent = String(errMsg || "");
  }

  function normalizeBase(v) {
    const s = String(v || "").trim();
    return s ? s.replace(/\/+$/, "") : "";
  }

  function readQueryPrefill() {
    const u = new URL(window.location.href);
    const base = u.searchParams.get("base") || "";
    const orgId = u.searchParams.get("orgId") || "";
    const token = u.searchParams.get("token") || ""; // if someone opens recover with token

    if (base && apiBaseEl) apiBaseEl.value = base;
    if (orgId && orgIdEl) orgIdEl.value = orgId;
    if (token && tokenEl) tokenEl.value = token;
  }

  function saveLocal() {
    localStorage.setItem(LS_BASE, normalizeBase(apiBaseEl?.value));
    localStorage.setItem(LS_ORG, String(orgIdEl?.value || "").trim());
    localStorage.setItem(LS_EMAIL, String(emailEl?.value || "").trim().toLowerCase());
    set1("Saved.", "");
  }

  function loadLocal() {
    const base = localStorage.getItem(LS_BASE) || "";
    const orgId = localStorage.getItem(LS_ORG) || "";
    const email = localStorage.getItem(LS_EMAIL) || "";

    if (apiBaseEl && !apiBaseEl.value) apiBaseEl.value = base;
    if (orgIdEl && !orgIdEl.value) orgIdEl.value = orgId;
    if (emailEl && !emailEl.value) emailEl.value = email;
  }

  async function post(path, body) {
    const base = normalizeBase(apiBaseEl?.value);
    const url = base ? `${base}${path}` : path;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });

    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => null);

    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  async function sendUsernameEmail() {
    set1("", "");
    const orgId = String(orgIdEl?.value || "").trim();
    const email = String(emailEl?.value || "").trim().toLowerCase();
    if (!orgId || !email) return set1("", "Org ID and Email are required.");

    try {
      saveLocal();
      const out = await post("/auth/forgot-username", { orgId, email });
      set1(out?.message || "If an account exists, you will receive an email shortly.", "");
    } catch (e) {
      set1("", `Request failed: ${e.message}`);
    }
  }

  async function sendResetLink() {
    set1("", "");
    const orgId = String(orgIdEl?.value || "").trim();
    const email = String(emailEl?.value || "").trim().toLowerCase();
    if (!orgId || !email) return set1("", "Org ID and Email are required.");

    try {
      saveLocal();
      const out = await post("/auth/forgot-password", { orgId, email });
      set1(out?.message || "If an account exists, you’ll receive a reset link shortly.", "");
    } catch (e) {
      set1("", `Request failed: ${e.message}`);
    }
  }

  async function sendResetCode() {
    set2("", "");
    const orgId = String(orgIdEl?.value || "").trim();
    const token = String(tokenEl?.value || "").trim();
    if (!orgId || !token) return set2("", "Org ID and Reset Token are required.");

    try {
      const out = await post("/auth/reset/send-code", { orgId, token });
      if (out?.ok) set2("Code sent. Check your email (and spam).", "");
      else set2("If an account exists, you will receive a code shortly.", "");
    } catch (e) {
      set2("", `Send code failed: ${e.message}`);
    }
  }

  async function completeReset() {
    set2("", "");
    const orgId = String(orgIdEl?.value || "").trim();
    const token = String(tokenEl?.value || "").trim();
    const code = String(codeEl?.value || "").trim();
    const newPassword = String(newPwEl?.value || "");

    if (!orgId || !token || !code || !newPassword) {
      return set2("", "Org ID, Token, Code, and New Password are required.");
    }

    try {
      const out = await post("/auth/reset/confirm", { orgId, token, code, newPassword });
      if (out?.ok) {
        set2("Password reset successful. You can go back and login.", "");
      } else {
        set2("", "Reset failed. Please try again.");
      }
    } catch (e) {
      set2("", `Reset failed: ${e.message}`);
    }
  }

  usernameBtn?.addEventListener("click", sendUsernameEmail);
  resetLinkBtn?.addEventListener("click", sendResetLink);
  saveBtn?.addEventListener("click", saveLocal);

  sendCodeBtn?.addEventListener("click", sendResetCode);
  completeBtn?.addEventListener("click", completeReset);

  openResetLink?.addEventListener("click", (e) => {
    e.preventDefault();
    // just scroll to Step 2
    tokenEl?.scrollIntoView({ behavior: "smooth", block: "center" });
    tokenEl?.focus?.();
  });

  // init
  readQueryPrefill();
  loadLocal();
})();
