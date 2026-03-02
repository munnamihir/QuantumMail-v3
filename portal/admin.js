// portal/admin.js
const $ = (id) => document.getElementById(id);

/* =========================================================
   Storage (ONE source of truth)
========================================================= */
function getToken() {
  return localStorage.getItem("qm_token") || "";
}
function getUser() {
  try { return JSON.parse(localStorage.getItem("qm_user") || "null"); }
  catch { return null; }
}
function clearSession() {
  localStorage.removeItem("qm_token");
  localStorage.removeItem("qm_user");
  localStorage.removeItem("qm_role");
  localStorage.removeItem("qm_orgId");
  localStorage.removeItem("qm_username");

  // cleanup old stuff you used earlier
  sessionStorage.removeItem("qm_admin_token");
  sessionStorage.removeItem("qm_super_token");
  sessionStorage.removeItem("qm_token");
  sessionStorage.removeItem("qm_user");
}

/* =========================================================
   UI helpers
========================================================= */
function setText(id, msg) {
  const el = $(id);
  if (el) el.textContent = msg || "";
}
function ok(id, msg) { setText(id, msg); }
function err(id, msg) { setText(id, msg); }

function setDot(state /* "good"|"bad"|null */) {
  const dot = $("sessionDot");
  if (!dot) return;
  dot.classList.remove("good", "bad");
  if (state === "good") dot.classList.add("good");
  if (state === "bad") dot.classList.add("bad");
}

function setAuthedUI(isAuthed) {
  const authedNav = $("authedNav");
  const authedActions = $("authedActions");
  if (authedNav) authedNav.style.display = isAuthed ? "" : "none";
  if (authedActions) authedActions.style.display = isAuthed ? "" : "none";
}

function setSessionPill() {
  const token = getToken();
  const user = getUser();
  const who = $("whoText");

  const isAuthed = Boolean(token && user?.username);
  if (who) {
    who.textContent = isAuthed
      ? `${user.username}@${user.orgId} (${user.role})`
      : "Not logged in";
  }

  setDot(isAuthed ? "good" : null);
  setAuthedUI(isAuthed);
}

/* =========================================================
   Validation helpers
========================================================= */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function isValidEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return false;
  // simple + strict enough for UI
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("`", "&#096;");
}

/* =========================================================
   API
========================================================= */
async function api(path, { method = "GET", body = null } = {}) {
  const token = getToken();
  if (!token) throw new Error("Not logged in.");

  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* =========================================================
   Formatting
========================================================= */
function fmtIso(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
function daysOld(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

/* =========================================================
   Users table
   NOTE: supports email if backend returns it (u.email)
========================================================= */
function renderUsers(users) {
  const tbody = $("usersTbody");
  if (!tbody) return;

  if (!Array.isArray(users) || users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">No users found.</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map((u) => {
    const keyAge = u.publicKeyRegisteredAt ? daysOld(u.publicKeyRegisteredAt) : null;
    const keyHealth = u.hasPublicKey
      ? `✅ Registered${keyAge != null ? ` • ${keyAge}d` : ""}`
      : `— None`;

    const email = u.email ? String(u.email) : "";

    return `
      <tr>
        <td>
          <b>${escapeHtml(u.username || "")}</b>
          <br/>
          <span class="muted">${escapeHtml(u.userId || "")}</span>
        </td>
        <td>${escapeHtml(email || "—")}</td>
        <td>${escapeHtml(u.role || "Member")}</td>
        <td>${escapeHtml(u.status || "Active")}</td>
        <td>${escapeHtml(keyHealth)}</td>
        <td>${escapeHtml(fmtIso(u.lastLoginAt))}</td>
        <td>
          <button data-action="clearKey" data-userid="${escapeAttr(u.userId)}" class="secondary">Force Re-key</button>
          <button data-action="removeUser" data-userid="${escapeAttr(u.userId)}" class="danger">Remove</button>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-action");
      const userId = btn.getAttribute("data-userid");
      if (!action || !userId) return;

      try {
        ok("usersOk", ""); err("usersErr", "");

        if (action === "removeUser") {
          await api(`/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
          ok("usersOk", "User removed ✅");
        }
        if (action === "clearKey") {
          await api(`/admin/users/${encodeURIComponent(userId)}/clear-key`, { method: "POST" });
          ok("usersOk", "Public key cleared ✅");
        }

        await refreshUsers();
      } catch (e) {
        err("usersErr", e?.message || String(e));
      }
    });
  });
}

async function refreshUsers() {
  ok("usersOk", ""); err("usersErr", "");
  const out = await api("/admin/users");
  renderUsers(out.users || []);
}

async function createUser() {
  ok("usersOk", ""); err("usersErr", "");

  const username = String($("newUsername")?.value || "").trim();
  const emailRaw = String($("newEmail")?.value || "");
  const email = normalizeEmail(emailRaw);
  const password = String($("newPassword")?.value || "");
  const role = String($("newRole")?.value || "Member").trim() || "Member";

  if (!username || !password) {
    err("usersErr", "New Username and New Password are required.");
    return;
  }
  if (!email) {
    err("usersErr", "Email is required.");
    return;
  }
  if (!isValidEmail(email)) {
    err("usersErr", "Email is invalid.");
    return;
  }

  await api("/admin/users", { method: "POST", body: { username, email, password, role } });

  // Store so you can re-use later (Join tab or elsewhere)
  localStorage.setItem("qm_last_created_username", username);
  localStorage.setItem("qm_last_created_email", email);

  ok("usersOk", `User created ✅ (${username})`);

  $("newUsername").value = "";
  if ($("newEmail")) $("newEmail").value = "";
  $("newPassword").value = "";
  await refreshUsers();
}

async function loadOrgHeader() {
  try {
    const orgRes = await api("/org/me");
    const org = orgRes?.org || {};

    const companyName = org.companyName || "—";
    const orgName = org.orgName || org.orgId || getUser()?.orgId || "—";
    const orgId = org.orgId || getUser()?.orgId || "—";

    const companyLine = $("companyLine");
    if (companyLine) {
      companyLine.textContent = `Company: ${companyName} • Org: ${orgName} (${orgId})`;
    }

    // Optional: make top pill more informative (safe)
    const who = $("whoText");
    const u = getUser();
    if (who && u?.username) {
      who.textContent = `${u.username}@${orgId} (${u.role})`;
    }
  } catch (e) {
    // If org/me fails, don't break the page; show fallback
    const u = getUser();
    const companyLine = $("companyLine");
    if (companyLine) {
      companyLine.textContent = `Org: ${u?.orgId || "—"}`;
    }
  }
}

/* =========================================================
   Alerts badge
========================================================= */
async function refreshAlertsBadge() {
  const badge = $("alertBadge");
  if (!badge) return;

  try {
    const out = await api("/admin/alerts?minutes=60");
    const count = Array.isArray(out.alerts) ? out.alerts.length : 0;

    if (count > 0) {
      badge.textContent = String(count);
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
  } catch {
    badge.style.display = "none";
  }
}

/* =========================================================
   Profile modal
========================================================= */
function openProfileModal() {
  const m = $("profileModal");
  if (m) m.style.display = "";
}
function closeProfileModal() {
  const m = $("profileModal");
  if (m) m.style.display = "none";
}
function setPwMsg(okMsg, errMsg) {
  setText("pwOk", okMsg || "");
  setText("pwErr", errMsg || "");
}

async function loadProfile() {
  setPwMsg("", "");
  const me = await api("/auth/me");
  const org = await api("/org/me");

  const user = me?.user;
  const orgInfo = org?.org;
  const companyLine = document.getElementById("companyLine");
  if (companyLine) {
    const cn = orgInfo?.companyName || "—";
    const oid = orgInfo?.orgId || user?.orgId || "—";
    const on = orgInfo?.orgName || "—";
    companyLine.textContent = `Company: ${cn} • Org: ${on} (${oid})`;
  }
  $("profileMeta").textContent =
    user ? `${user.username}@${user.orgId} • ${user.role}` : "—";

  $("profileOrgName").textContent = orgInfo?.orgName || "—";
  $("profileOrgId").textContent = user?.orgId || orgInfo?.orgId || "—";
  $("profileUsername").textContent = user?.username || "—";
}

function showChangePasswordBox() {
  $("pwBox").style.display = "";
  $("curPw").value = "";
  $("newPw").value = "";
  $("newPw2").value = "";
  setPwMsg("", "");
}

async function changePassword() {
  setPwMsg("", "");

  const currentPassword = String($("curPw").value || "");
  const newPassword = String($("newPw").value || "");
  const confirm = String($("newPw2").value || "");

  if (!currentPassword || !newPassword) return setPwMsg("", "Current and new password are required.");
  if (newPassword.length < 12) return setPwMsg("", "New password must be at least 12 characters.");
  if (newPassword !== confirm) return setPwMsg("", "Confirmation does not match.");

  await api("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });

  setPwMsg("Password updated ✅", "");
  $("curPw").value = "";
  $("newPw").value = "";
  $("newPw2").value = "";
}

/* =========================================================
   Logout
========================================================= */
function doLogout() {
  clearSession();
  setSessionPill();

  // reset table + badge
  const tbody = $("usersTbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="muted">Login to load users…</td></tr>`;
  const badge = $("alertBadge");
  if (badge) badge.style.display = "none";

  // bounce to index login
  window.location.href = "/portal/index.html";
}

/* =========================================================
   Wiring + boot
========================================================= */
$("btnCreateUser")?.addEventListener("click", () => createUser().catch(e => err("usersErr", e.message)));
$("btnRefreshUsers")?.addEventListener("click", () => refreshUsers().catch(e => err("usersErr", e.message)));

$("btnLogout")?.addEventListener("click", doLogout);
$("btnLogoutTop")?.addEventListener("click", doLogout);

$("btnProfile")?.addEventListener("click", async () => {
  try {
    await loadProfile();
    openProfileModal();
  } catch (e) {
    window.location.href = "/portal/index.html";
  }
});

$("btnCloseProfile")?.addEventListener("click", closeProfileModal);
$("profileModal")?.addEventListener("click", (e) => {
  if (e.target?.id === "profileModal") closeProfileModal();
});
$("btnShowChangePw")?.addEventListener("click", showChangePasswordBox);
$("btnChangePw")?.addEventListener("click", () => changePassword().catch(e => setPwMsg("", e.message)));

(function boot() {
  setSessionPill();

  // If not logged in, bounce to login
  if (!getToken() || !getUser()) {
    window.location.href = "/portal/index.html";
    return;
  }
  loadOrgHeader().catch(() => {})
  refreshUsers().catch(e => err("usersErr", e.message));
  refreshAlertsBadge().catch(() => {});
})();
