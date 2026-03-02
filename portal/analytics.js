// portal/analytics.js
const $ = (id) => document.getElementById(id);

let coreChart = null;
let attChart = null;

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
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });

  const raw = await res.text().catch(() => "");
  let data = {};
  try { data = JSON.parse(raw || "{}"); } catch { data = { error: raw }; }

  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function setErr(msg) { const e = $("err"); if (e) e.textContent = msg || ""; }
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function setText(id, v) {
  const el = $(id);
  if (el) el.textContent = String(v ?? "—");
}

function setKpis(out) {
  const c = out.counts || {};
  setText("kEncrypted", c.encryptedMessages ?? "—");
  setText("kDecrypts", c.decrypts ?? "—");
  setText("kDenied", c.deniedDecrypts ?? "—");
  setText("kFailed", c.failedLogins ?? "—");

  const seats = out.seats || {};
  setText("kActiveSeats", `${seats.activeUsers ?? 0} / ${seats.totalUsers ?? 0}`);
  setText("kWAU", `${seats.activeUsers7d ?? 0}`);
  setText("kKeyCoverage", `${seats.keyCoveragePct ?? 0}%`);
  setText("kDecryptRate", `${out.rates?.decryptSuccessRatePct ?? 0}%`);
}

function renderTopUsers(list) {
  const tbody = $("tbodyUsers");
  if (!tbody) return;

  if (!Array.isArray(list) || !list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No data.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(u => `
    <tr>
      <td>${escapeHtml(u.username || "—")}<div class="muted">${escapeHtml(u.userId || "")}</div></td>
      <td>${escapeHtml(u.role || "Member")}</td>
      <td>${escapeHtml(u.encrypts ?? 0)}</td>
      <td>${escapeHtml(u.decrypts ?? 0)}</td>
      <td>${escapeHtml(u.denied ?? 0)}</td>
      <td>${escapeHtml(u.logins ?? 0)}</td>
    </tr>
  `).join("");
}

function renderKeyHealth(out) {
  const kh = out.keyHealth || {};
  const missing = kh.missingKeys || [];
  const stale = kh.staleKeys || [];
  const staleDays = kh.staleKeyDays ?? 90;

  setText("kMissingKeys", kh.missingKeysCount ?? missing.length);
  setText("kStaleKeys", kh.staleKeysCount ?? stale.length);
  setText("staleKeyDaysLabel", staleDays);

  const tbMissing = $("tbodyMissingKeys");
  if (tbMissing) {
    tbMissing.innerHTML = !missing.length
      ? `<tr><td colspan="4" class="muted">None ✅</td></tr>`
      : missing.map(u => `
          <tr>
            <td>${escapeHtml(u.username || "—")}<div class="muted">${escapeHtml(u.userId || "")}</div></td>
            <td>${escapeHtml(u.role || "Member")}</td>
            <td class="muted">${escapeHtml(u.lastLoginAt || "—")}</td>
            <td><span class="muted">Register key on next login</span></td>
          </tr>
        `).join("");
  }

  const tbStale = $("tbodyStaleKeys");
  if (tbStale) {
    tbStale.innerHTML = !stale.length
      ? `<tr><td colspan="4" class="muted">None ✅</td></tr>`
      : stale.map(u => `
          <tr>
            <td>${escapeHtml(u.username || "—")}<div class="muted">${escapeHtml(u.userId || "")}</div></td>
            <td>${escapeHtml(u.role || "Member")}</td>
            <td class="muted">${escapeHtml(u.publicKeyRegisteredAt || "—")}</td>
            <td><b>${escapeHtml(u.keyAgeDays ?? "—")}</b></td>
          </tr>
        `).join("");
  }
}

function renderInvites(out) {
  const inv = out.invites || {};
  setText("kInvActive", inv.active ?? 0);
  setText("kInvUsed", inv.used ?? 0);
  setText("kInvExpired", inv.expired ?? 0);
}

function drawCore(series) {
  const ctx = $("chartCore");
  if (!ctx || typeof Chart === "undefined") return;

  const labels = series.map(x => x.day);
  const data = {
    labels,
    datasets: [
      { label: "Encrypted", data: series.map(x => x.encrypted || 0) },
      { label: "Decrypts", data: series.map(x => x.decrypts || 0) },
      { label: "Denied", data: series.map(x => x.denied || 0) },
      { label: "Failed Logins", data: series.map(x => x.failedLogins || 0) },
    ]
  };

  if (coreChart) coreChart.destroy();
  coreChart = new Chart(ctx, { type: "line", data });
}

function drawAttachment(series) {
  const ctx = $("chartAtt");
  if (!ctx || typeof Chart === "undefined") return;

  const labels = series.map(x => x.day);
  const vals = series.map(x => x.attachmentsBytes || 0);

  const data = { labels, datasets: [{ label: "Attachment Bytes", data: vals }] };

  if (attChart) attChart.destroy();
  attChart = new Chart(ctx, { type: "line", data });
}

async function refresh() {
  setErr("");
  requireAdminOrBounce();

  const days = Math.min(365, Math.max(1, parseInt($("days")?.value || "30", 10) || 30));
  const staleKeyDays = Math.min(3650, Math.max(7, parseInt($("staleKeyDays")?.value || "90", 10) || 90));

  const out = await api(`/admin/analytics?days=${encodeURIComponent(days)}&staleKeyDays=${encodeURIComponent(staleKeyDays)}`);

  setKpis(out);
  renderInvites(out);
  renderKeyHealth(out);
  renderTopUsers(out.topUsers || []);

  const series = out.activitySeries || [];
  drawCore(series);
  drawAttachment(series);
}

$("btnRefresh")?.addEventListener("click", () => refresh().catch(e => setErr(e.message)));
refresh().catch(e => setErr(e.message));
