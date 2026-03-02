// portal/invites.js
const $ = (id) => document.getElementById(id);
function ok(id, msg){ const el=$(id); if(el) el.textContent = msg||""; }
function err(id, msg){ const el=$(id); if(el) el.textContent = msg||""; }

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
  if (!token) throw new Error("Not logged in (admin).");
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function isValidEmailOptional(email) {
  const e = String(email || "").trim();
  if (!e) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function setSlots(text) {
  const compact = String(text || "").replace(/[^0-9]/g, "").padEnd(6, "-");
  for (let i=0;i<5;i++){
    const el = $(`slot${i+1}`);
    if (!el) continue;
    if (i < 4) el.textContent = compact[i] || "-";
    else el.textContent = compact.slice(4,6);
  }
}

function animateTo(finalCode) {
  const compact = String(finalCode || "").replace(/[^0-9]/g, "").padEnd(6, "-");
  const duration = 1200;
  const start = Date.now();

  const tick = () => {
    const progress = Math.min(1, (Date.now() - start) / duration);

    if (progress < 0.9) {
      const rnd = Array.from({length:6}, () => String(Math.floor(Math.random()*10)));
      for (let i=0;i<5;i++){
        const el = $(`slot${i+1}`);
        if (!el) continue;
        if (i < 4) el.textContent = rnd[i];
        else el.textContent = rnd[4] + rnd[5];
      }
      requestAnimationFrame(tick);
    } else {
      for (let i=0;i<5;i++){
        const el = $(`slot${i+1}`);
        if (!el) continue;
        if (i < 4) el.textContent = compact[i];
        else el.textContent = compact.slice(4,6);
      }
    }
  };
  requestAnimationFrame(tick);
}

async function generateInvite() {
  ok("invOk",""); err("invErr","");
  requireAdminOrBounce();

  const role = String($("selRole")?.value || "Member");
  const expires = Number($("expiresMinutes")?.value) || 60;

  // NEW: email
  const email = String($("invEmail")?.value || "").trim().toLowerCase();
  if (!isValidEmailOptional(email)) {
    err("invErr", "Invalid email format.");
    return;
  }

  const out = await api("/admin/invites/generate", {
    method: "POST",
    body: { role, expiresMinutes: expires, email }
  });

  const code = out.code;

  animateTo(code);
  $("btnCopy").style.display = "";
  $("btnCopy").dataset.code = code;

  const emailNote = out.email ? ` • email ${out.email}` : "";
  $("generatedNote").textContent = `Code ${code}${emailNote} • expires ${new Date(out.expiresAt).toLocaleString()}`;

  ok("invOk", "Invite generated ✅");
  await refreshRecent();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function refreshRecent() {
  ok("invOk",""); err("invErr","");
  requireAdminOrBounce();

  const out = await api("/admin/invites");
  const items = Array.isArray(out.items) ? out.items : [];

  const container = $("recentContainer");
  if (!container) return;

  if (!items.length) {
    container.innerHTML = `<div class="muted">No invites generated yet.</div>`;
    return;
  }

  container.innerHTML = items.map(i => `
    <div class="invRow">
      <div>
        <div>
          <b>${escapeHtml(i.code)}</b>
          <span class="invMeta">• ${escapeHtml(i.role)}</span>
          ${i.email ? `<span class="invMeta">• ${escapeHtml(i.email)}</span>` : ``}
        </div>
        <div class="invMeta">
          created ${new Date(i.createdAt).toLocaleString()} • expires ${new Date(i.expiresAt).toLocaleString()}
        </div>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button class="small" data-copy="${escapeHtml(i.code)}">Copy</button>
        <div class="invMeta">${i.usedAt ? `Used: ${new Date(i.usedAt).toLocaleString()}` : `<b>unused</b>`}</div>
      </div>
    </div>
  `).join("");

  container.querySelectorAll("button[data-copy]").forEach(b => {
    b.addEventListener("click", async () => {
      const c = b.getAttribute("data-copy");
      try {
        await navigator.clipboard.writeText(c);
        ok("invOk", "Copied to clipboard ✅");
      } catch {
        err("invErr", "Copy failed — please copy manually.");
      }
    });
  });
}

(function init(){
  requireAdminOrBounce();

  setSlots("------");

  $("btnGenerate")?.addEventListener("click", () => generateInvite().catch(e => err("invErr", e.message)));
  $("btnRefresh")?.addEventListener("click", () => refreshRecent().catch(e => err("invErr", e.message)));

  $("btnCopy")?.addEventListener("click", async () => {
    const code = $("btnCopy")?.dataset.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      ok("invOk", "Copied to clipboard ✅");
    } catch {
      err("invErr", "Copy failed — please copy manually.");
    }
  });

  $("btnLogout")?.addEventListener("click", () => {
    localStorage.removeItem("qm_token");
    localStorage.removeItem("qm_user");
    window.location.href = "/portal/index.html";
  });

  refreshRecent().catch(()=>{});
})();
