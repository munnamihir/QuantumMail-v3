// /portal/org.js
(() => {
  const $ = (id) => document.getElementById(id);

  const apiBaseEl = $("apiBase");
  const tokenEl = $("token");
  const saveTokenBtn = $("saveTokenBtn");
  const loadTokenBtn = $("loadTokenBtn");
  const reloadBtn = $("reloadBtn");
  const logoutBtn = $("logoutBtn");

  const titleEl = $("title");
  const subtitleEl = $("subtitle");
  const companyBadge = $("companyBadge");
  const guardMsg = $("guardMsg");
  const mainCard = $("mainCard");

  const overviewBadges = $("overviewBadges");
  const overviewHelp = $("overviewHelp");
  const adminsWrap = $("adminsWrap");
  const securityWrap = $("securityWrap");
  const activityWrap = $("activityWrap");
  const msgEl = $("msg");

  const toastModal = $("toast");
  const toastText = $("toastText");
  const toastCloseBtn = $("toastCloseBtn");

  const SS_SUPER = "qm_super_token";
  const SS_TOKEN = "qm_token";
  const SS_BASE  = "qm_api_base";
  const LS_SUPER = "qm_super_token";
  const LS_TOKEN = "qm_token";
  const LS_BASE  = "qm_api_base";

  function toast(msg) {
    if (!toastModal || !toastText) return;
    toastText.textContent = String(msg || "");
    toastModal.style.display = "block";
  }
  function toastClose() {
    if (!toastModal) return;
    toastModal.style.display = "none";
  }
  toastCloseBtn?.addEventListener("click", toastClose);
  toastModal?.addEventListener("click", (e) => {
    if (e.target === toastModal) toastClose();
  });

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function badge(label, value, dotStyle = "") {
    return `
      <span class="badge">
        <span class="badgeDot" style="${dotStyle}"></span>
        <strong>${esc(label)}:</strong> ${esc(value)}
      </span>
    `;
  }

  function getApiBase() {
    const v = String(apiBaseEl?.value || "").trim();
    return v ? v.replace(/\/+$/, "") : "";
  }

  function getToken() {
    return String(tokenEl?.value || "").trim();
  }

  async function api(path, { method = "GET", body } = {}) {
    const base = getApiBase();
    const url = base ? `${base}${path}` : path;

    const token = getToken();
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try { data = await res.json(); } catch {}
    } else {
      try { data = await res.text(); } catch {}
    }

    if (!res.ok) {
      const m = (data && data.error) ? data.error : `HTTP ${res.status}`;
      throw new Error(m);
    }
    return data;
  }

  async function checkAccess() {
    if (guardMsg) guardMsg.textContent = "—";
    try {
      const me = await api("/auth/me");
      const user = me?.user;
      if (!user) throw new Error("No user returned from /auth/me");

      if (user.role !== "SuperAdmin") {
        if (mainCard) mainCard.style.display = "none";
        if (guardMsg) guardMsg.textContent = "Blocked: role is not SuperAdmin.";
        return false;
      }

      if (guardMsg) guardMsg.textContent = "OK";
      if (mainCard) mainCard.style.display = "block";
      return true;
    } catch (e) {
      if (mainCard) mainCard.style.display = "none";
      if (guardMsg) guardMsg.textContent = `Access check failed: ${e.message}`;
      return false;
    }
  }

  function getParams() {
    const u = new URL(window.location.href);
    return {
      companyId: u.searchParams.get("companyId") || "",
      orgId: u.searchParams.get("orgId") || ""
    };
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }

  function renderList(target, rows) {
    if (!target) return;
    if (!rows || rows.length === 0) {
      target.innerHTML = `<div class="item"><div class="muted">No data.</div></div>`;
      return;
    }
    target.innerHTML = rows.join("");
  }

  async function loadOrg() {
    const { companyId, orgId } = getParams();
    if (!orgId) {
      if (msgEl) msgEl.textContent = "Missing orgId in URL.";
      return;
    }

    if (companyBadge) companyBadge.textContent = companyId || "—";
    if (titleEl) titleEl.textContent = `Org: ${orgId}`;
    if (subtitleEl) subtitleEl.textContent = `Company: ${companyId || "—"}`;

    if (msgEl) msgEl.textContent = "";
    if (overviewBadges) overviewBadges.innerHTML = "";
    if (overviewHelp) overviewHelp.textContent = "";

    if (adminsWrap) adminsWrap.innerHTML = `<div class="item"><div class="muted">Loading…</div></div>`;
    if (securityWrap) securityWrap.innerHTML = `<div class="item"><div class="muted">Loading…</div></div>`;
    if (activityWrap) activityWrap.innerHTML = `<div class="item"><div class="muted">Loading…</div></div>`;

    try {
      const out = await api(`/super/orgs/${encodeURIComponent(orgId)}/overview`);

      const org = out?.org || {};
      const counts = out?.counts || {};
      const security = out?.security || {};
      const activity = out?.activity || {};
      const admins = Array.isArray(out?.admins) ? out.admins : [];

      const name = org.orgName || orgId;
      if (titleEl) titleEl.textContent = `${name}`;
      if (subtitleEl) subtitleEl.textContent = `${orgId} • Company: ${companyId || org.companyId || "—"}`;

      if (overviewBadges) {
        overviewBadges.innerHTML = [
          badge("Users", counts.totalUsers ?? 0),
          badge("Admins", counts.admins ?? 0),
          badge("Members", counts.members ?? 0),
          badge(
            "Key coverage",
            `${counts.keyCoveragePct ?? 0}%`,
            (counts.keyCoveragePct ?? 0) >= 90
              ? "background:rgba(43,213,118,.8)"
              : "background:rgba(255,92,119,.85)"
          ),
          badge("Last activity", fmtTime(org.lastActivityAt)),
          badge("Created", fmtTime(org.createdAt))
        ].join("");
      }

      if (overviewHelp) overviewHelp.textContent = org.notes ? String(org.notes) : "";

      renderList(adminsWrap, admins.map((a) => `
        <div class="item">
          <div>
            <div class="itemTitle">${esc(a.username || a.userId || "admin")}</div>
            <div class="muted mono">${esc(a.userId || "")}</div>
            <div class="help">${esc(a.email || "")}</div>
          </div>
          <div class="muted">${esc(a.status || "active")}</div>
        </div>
      `));

      renderList(securityWrap, [
        `<div class="item">
          <div>
            <div class="itemTitle">Org policy</div>
            <div class="help">
              Recovery: <strong>${esc(security.recoveryEnabled ? "enabled" : "disabled")}</strong><br/>
              Link TTL: <strong>${esc(security.linkTtlMinutes ?? "—")}</strong> min<br/>
              Require device-key: <strong>${esc(security.requireDeviceKey ? "yes" : "no")}</strong><br/>
              Allowed domains: <strong>${esc((security.allowedDomains || []).join(", ") || "—")}</strong>
            </div>
          </div>
        </div>`,
        `<div class="item">
          <div>
            <div class="itemTitle">Key inventory</div>
            <div class="help">
              Users with keys: <strong>${esc(counts.usersWithKeys ?? 0)}</strong><br/>
              Users missing keys: <strong>${esc(counts.usersMissingKeys ?? 0)}</strong><br/>
              Last key rotation: <strong>${esc(fmtTime(security.lastKeyRotationAt))}</strong>
            </div>
          </div>
        </div>`
      ]);

      renderList(activityWrap, [
        `<div class="item">
          <div>
            <div class="itemTitle">Usage</div>
            <div class="help">
              Encrypts: <strong>${esc(activity.encrypts30d ?? 0)}</strong><br/>
              Decrypts: <strong>${esc(activity.decrypts30d ?? 0)}</strong><br/>
              Failures: <strong>${esc(activity.failures30d ?? 0)}</strong><br/>
              Avg decrypt time: <strong>${esc(activity.avgDecryptMs ?? "—")}</strong> ms
            </div>
          </div>
          <div class="muted">Last 30 days</div>
        </div>`,
        `<div class="item">
          <div>
            <div class="itemTitle">Email delivery</div>
            <div class="help">
              Setup emails sent: <strong>${esc(activity.setupEmails30d ?? 0)}</strong><br/>
              Rejections sent: <strong>${esc(activity.rejectEmails30d ?? 0)}</strong>
            </div>
          </div>
          <div class="muted">Last 30 days</div>
        </div>`
      ]);

    } catch (e) {
      if (msgEl) msgEl.textContent = `Org load error: ${e.message}`;
      toast(`Org load failed: ${e.message}`);
    }
  }

  function hardLogoutAndRedirect() {
    sessionStorage.removeItem(SS_SUPER);
    sessionStorage.removeItem(SS_TOKEN);
    sessionStorage.removeItem(SS_BASE);
    localStorage.removeItem(LS_SUPER);
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_BASE);

    window.location.href = "/portal/index.html";
  }

  saveTokenBtn?.addEventListener("click", () => {
    const t = getToken();
    const b = String(apiBaseEl?.value || "").trim();

    if (t) {
      sessionStorage.setItem(SS_SUPER, t);
      sessionStorage.setItem(SS_TOKEN, t);
    }
    sessionStorage.setItem(SS_BASE, b);

    localStorage.setItem(LS_SUPER, t || "");
    localStorage.setItem(LS_TOKEN, t || "");
    localStorage.setItem(LS_BASE, b);

    toast("Saved token");
  });

  loadTokenBtn?.addEventListener("click", () => {
    const t =
      sessionStorage.getItem(SS_SUPER) ||
      sessionStorage.getItem(SS_TOKEN) ||
      localStorage.getItem(LS_SUPER) ||
      localStorage.getItem(LS_TOKEN) ||
      "";

    const b =
      sessionStorage.getItem(SS_BASE) ||
      localStorage.getItem(LS_BASE) ||
      "";

    if (tokenEl) tokenEl.value = t;
    if (apiBaseEl) apiBaseEl.value = b;

    toast("Loaded saved token");
  });

  reloadBtn?.addEventListener("click", () => loadOrg());
  logoutBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    toast("Logging out…");
    setTimeout(() => hardLogoutAndRedirect(), 250);
  });

  (function init() {
    const t =
      sessionStorage.getItem(SS_SUPER) ||
      sessionStorage.getItem(SS_TOKEN) ||
      localStorage.getItem(LS_SUPER) ||
      localStorage.getItem(LS_TOKEN) ||
      "";

    const b =
      sessionStorage.getItem(SS_BASE) ||
      localStorage.getItem(LS_BASE) ||
      "";

    if (tokenEl) tokenEl.value = t;
    if (apiBaseEl) apiBaseEl.value = b;

    (async () => {
      const ok = await checkAccess();
      if (ok) await loadOrg();
    })();
  })();
})();
