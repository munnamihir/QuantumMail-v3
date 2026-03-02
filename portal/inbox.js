// portal/inbox.js
const $ = (id) => document.getElementById(id);

function ok(id, msg) { const el = $(id); if (el) el.textContent = msg || ""; }
function err(id, msg) { const el = $(id); if (el) el.textContent = msg || ""; }

function getToken() { return localStorage.getItem("qm_token") || ""; }
function getUser() {
  try { return JSON.parse(localStorage.getItem("qm_user") || "null"); }
  catch { return null; }
}

async function api(path, { method = "GET", body = null } = {}) {
  const token = getToken();
  if (!token) throw new Error("Not logged in.");

  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function logout() {
  localStorage.removeItem("qm_token");
  localStorage.removeItem("qm_user");
  localStorage.removeItem("qm_role");
  localStorage.removeItem("qm_orgId");
  localStorage.removeItem("qm_username");
  window.location.href = "/portal/index.html";
}

async function initRoleUI() {
  try {
    const me = await api("/auth/me");
    const role = me?.user?.role;

    // Keep local copy updated (useful if server returns fresher status)
    const u = getUser() || {};
    const merged = { ...u, ...(me?.user || {}) };
    localStorage.setItem("qm_user", JSON.stringify(merged));

    // Admin buttons (only if they exist on the page)
    const btnAdminDash = $("btnAdminDash");
    const btnInvites = $("btnInvites");

    const isAdmin = role === "Admin" || role === "SuperAdmin";

    if (btnAdminDash) btnAdminDash.style.display = isAdmin ? "" : "none";
    if (btnInvites) btnInvites.style.display = isAdmin ? "" : "none";

  } catch {
    // token invalid -> bounce
    logout();
  }
}

function fmt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render(items) {
  const list = $("list");
  if (!list) return;

  if (!Array.isArray(items) || items.length === 0) {
    list.innerHTML = `<div class="muted" style="padding:12px;">No encrypted messages yet.</div>`;
    return;
  }

  list.innerHTML = items.map((m) => `
    <div class="item">
      <div class="itemMain">
        <div class="itemTitle">Encrypted message</div>
        <div class="muted">
          ${m.from ? `From: <b>${escapeHtml(m.from)}</b> • ` : ``}
          ${escapeHtml(fmt(m.createdAt))}
          ${m.attachmentCount ? ` • Attachments: ${escapeHtml(m.attachmentCount)}` : ``}
        </div>
      </div>
      <div class="itemActions">
        <a class="btn primary" href="/m/${encodeURIComponent(m.id)}">Decrypt</a>
      </div>
    </div>
  `).join("");
}

async function loadOrgHeader() {
  try {
    const out = await api("/org/me");
    const org = out?.org || {};

    const cn = org.companyName || "—";
    const on = org.orgName || org.orgId || "—";
    const oid = org.orgId || "—";

    const wrap = $("orgLine");
    if (wrap) wrap.style.display = "";

    const companyName = $("companyName");
    const orgName = $("orgName");
    const orgIdSmall = $("orgIdSmall");

    if (companyName) companyName.textContent = cn;
    if (orgName) orgName.textContent = on;
    if (orgIdSmall) orgIdSmall.textContent = `(${oid})`;

    // nice tooltips if text is long
    $("companyBadge")?.setAttribute("title", cn);
    $("orgBadge")?.setAttribute("title", `${on} (${oid})`);
  } catch {
    // If it fails, keep header clean
    const wrap = $("orgLine");
    if (wrap) wrap.style.display = "none";
  }
}

async function refresh() {
  err("inboxErr", "");
  const out = await api("/api/inbox");
  render(out.items || []);
}

// Profile modal
function openProfile() {
  ok("pwOk", ""); err("pwErr", "");
  const u = getUser();
  const meta = $("profileMeta");
  if (meta) meta.textContent = u ? `${u.username}@${u.orgId} • ${u.role}` : "—";

  const curPw = $("curPw"); const newPw = $("newPw"); const newPw2 = $("newPw2");
  if (curPw) curPw.value = "";
  if (newPw) newPw.value = "";
  if (newPw2) newPw2.value = "";

  const modal = $("profileModal");
  if (modal) modal.style.display = "";
}
function closeProfile() {
  const modal = $("profileModal");
  if (modal) modal.style.display = "none";
}

async function changePassword() {
  ok("pwOk", ""); err("pwErr", "");

  const currentPassword = String($("curPw")?.value || "");
  const newPassword = String($("newPw")?.value || "");
  const newPassword2 = String($("newPw2")?.value || "");

  if (!currentPassword || !newPassword) { err("pwErr", "Current and new password are required."); return; }
  if (newPassword.length < 8) { err("pwErr", "New password must be at least 8 characters."); return; }
  if (newPassword !== newPassword2) { err("pwErr", "Confirmation does not match."); return; }

  await api("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });

  ok("pwOk", "Password updated ✅");
  if ($("curPw")) $("curPw").value = "";
  if ($("newPw")) $("newPw").value = "";
  if ($("newPw2")) $("newPw2").value = "";
}

(function init() {
  const token = getToken();
  const u = getUser();
  if (!token || !u) return logout();

  const who = $("who");
  if (who) who.textContent = `${u.username}@${u.orgId} • ${u.role}`;

  $("btnRefresh")?.addEventListener("click", () => refresh().catch(e => err("inboxErr", e.message)));
  $("btnLogout")?.addEventListener("click", logout);

  $("btnProfile")?.addEventListener("click", openProfile);
  $("btnCloseProfile")?.addEventListener("click", closeProfile);
  $("profileModal")?.addEventListener("click", (e) => {
    if (e.target?.id === "profileModal") closeProfile();
  });
  $("btnChangePw")?.addEventListener("click", () => changePassword().catch(e => err("pwErr", e.message)));

  initRoleUI().catch(() => {});
  loadOrgHeader().catch(() => {});
  refresh().catch(e => err("inboxErr", e.message));
})();
