// portal/alerts.js
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

async function api(path) {
  const token = getToken();
  const headers = { Authorization: `Bearer ${token}` };

  const res = await fetch(path, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function setErr(msg) { const e = $("err"); if (e) e.textContent = msg || ""; }
function setOut(msg) { const o = $("out"); if (o) o.textContent = msg || ""; }

async function refresh() {
  setErr(""); setOut("Loading…");
  requireAdminOrBounce();

  const minutes = Math.max(5, parseInt($("minutes")?.value || "60", 10) || 60);
  const out = await api(`/admin/alerts?minutes=${encodeURIComponent(minutes)}`);

  setOut(`Denied decrypts: ${out.summary?.denied ?? 0} • Failed logins: ${out.summary?.failedLogins ?? 0}`);

  const list = $("list");
  if (!list) return;

  list.innerHTML = "";

  const alerts = Array.isArray(out.alerts) ? out.alerts : [];
  if (!alerts.length) {
    list.innerHTML = `<div class="muted" style="margin-top:10px;">No alerts ✅</div>`;
    return;
  }

  for (const a of alerts) {
    const div = document.createElement("div");
    div.className = `alert ${a.severity || ""}`.trim();
    div.innerHTML = `<b>${a.code}</b><div class="muted" style="margin-top:4px;">${a.message}</div>`;
    list.appendChild(div);
  }
}

$("btnRefresh")?.addEventListener("click", () => refresh().catch(e => setErr(e.message)));
refresh().catch(e => setErr(e.message));
