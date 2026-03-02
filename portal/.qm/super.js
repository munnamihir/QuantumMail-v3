// /portal/.qm/super.js
(() => {
  const $ = (id) => document.getElementById(id);

  const apiBaseEl = $("apiBase");
  const tokenEl = $("token");
  const saveTokenBtn = $("saveTokenBtn");
  const loadTokenBtn = $("loadTokenBtn");
  const refreshMeBtn = $("refreshMeBtn");
  const logoutBtn = $("logoutBtn");

  const whoEl = $("who");
  const guardMsg = $("guardMsg");
  const mainCard = $("mainCard");

  const statusSel = $("statusSel");
  const reloadBtn = $("reloadBtn");
  const listMsg = $("listMsg");
  const listWrap = $("listWrap");

  // simple modal toast (uses your .modal)
  const toastModal = $("toast");
  const toastText = $("toastText");
  const toastCloseBtn = $("toastCloseBtn");

  // Storage keys (unchanged)
  const SS_SUPER = "qm_super_token";
  const SS_TOKEN = "qm_token";
  const SS_USER  = "qm_user";
  const SS_ADMIN = "qm_admin_token";
  const SS_BASE  = "qm_api_base";

  const LS_TOKEN = "qm_token";
  const LS_USER  = "qm_user";
  const LS_SUPER = "qm_super_token";
  const LS_ADMIN = "qm_admin_token";
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

  function getApiBase() {
    const v = String(apiBaseEl?.value || "").trim();
    return v ? v.replace(/\/+$/, "") : "";
  }

  function getToken() {
    return String(tokenEl?.value || "").trim();
  }

  function setLocked(msg) {
    if (mainCard) mainCard.style.display = "none";
    if (whoEl) whoEl.textContent = msg || "Access denied";
  }

  function setUnlocked(user) {
    if (mainCard) mainCard.style.display = "block";
    if (whoEl) whoEl.textContent = `${user.username} • ${user.role} • ${user.orgId}`;
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

    /*if (!res.ok) {
      const msg = (data && data.error) ? data.error : `HTTP ${res.status}`;
      throw new Error(msg);
    }*/
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      if (data) {
        if (typeof data === "string") msg = data;
        else if (data.error) msg = data.error;
        else msg = JSON.stringify(data);
      }
      throw new Error(msg);
    }
    return data;
  }

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function statusBadge(status) {
    const s = String(status || "").toLowerCase();
    if (s === "approved") return `<span class="badge"><span class="badgeDot" style="background:rgba(43,213,118,.8)"></span><strong>approved</strong></span>`;
    if (s === "rejected") return `<span class="badge"><span class="badgeDot" style="background:rgba(255,92,119,.85)"></span><strong>rejected</strong></span>`;
    return `<span class="badge"><span class="badgeDot" style="background:rgba(255,255,255,.25)"></span><strong>pending</strong></span>`;
  }

  function renderEmailStatus(r) {
    const sent = !!r.email_sent_at;
    const last = r.email_sent_at ? `Last: ${esc(r.email_sent_at)}` : "Not sent yet";
    const badge = sent
      ? `<span class="badge"><span class="badgeDot" style="background:rgba(43,213,118,.8)"></span><strong>Email:</strong> sent</span>`
      : `<span class="badge"><span class="badgeDot"></span><strong>Email:</strong> pending</span>`;

    return `
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        ${badge}
        <div class="muted">${last}</div>
      </div>
    `;
  }

  function renderPendingActions(id) {
    return `
      <div style="display:grid;gap:10px;min-width:260px">
        <div>
          <label>Approve: orgId</label>
          <input class="orgId" placeholder="ex: org_test_1" />
        </div>
        <div>
          <label>Approve: first admin username</label>
          <input class="adminUsername" placeholder="ex: admin" />
        </div>
        <button class="btn primary approveBtn" data-id="${esc(id)}" type="button">Approve + Email Setup Link</button>

        <div class="muted" style="margin-top:2px">— OR —</div>

        <div>
          <label>Reject reason</label>
          <input class="rejectReason" placeholder="Short reason (optional)" />
        </div>
        <button class="btn danger rejectBtn" data-id="${esc(id)}" type="button">Reject + Email Reason</button>

        <div class="ok mono setupOut" style="word-break:break-all;display:none"></div>
        <button class="btn secondary copyBtn" style="display:none" type="button">Copy Setup Link</button>
      </div>
    `;
  }

  function renderNonPendingActions(r) {
    const id = esc(r.id);
    const st = String(r.status || "").toLowerCase();
    if (st !== "approved" && st !== "rejected") return `<div class="muted">No actions.</div>`;

    const resendPath = st === "approved"
      ? `/super/org-requests/${encodeURIComponent(id)}/resend-approval-email`
      : `/super/org-requests/${encodeURIComponent(id)}/resend-reject-email`;

    return `
      <div style="display:grid;gap:10px;min-width:260px">
        <button class="btn" data-path="${esc(resendPath)}" type="button">Resend Email</button>
        <div class="help">Resends the ${esc(st)} email to requester.</div>
      </div>
    `;
  }

  function renderItem(r) {
    const id = esc(r.id);
    const orgName = esc(r.org_name || "");
    const reqName = esc(r.requester_name || "");
    const reqEmail = esc(r.requester_email || "");
    const notes = esc(r.notes || "");
    const st = esc(r.status || "pending");

    const approvedOrgId = esc(r.approved_org_id || "");
    const approvedAdminUserId = esc(r.approved_admin_user_id || "");

    const createdAt = esc(r.created_at || "");
    const reviewedAt = esc(r.reviewed_at || "");
    const rejectReason = esc(r.reject_reason || "");

    const left = `
      <div>
        <div class="itemTitle">${orgName || "(no org name)"}</div>
        <div class="muted mono">${id}</div>
        <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${statusBadge(st)}
          ${createdAt ? `<span class="badge"><span class="badgeDot"></span><strong>Created:</strong> ${createdAt}</span>` : ""}
          ${reviewedAt ? `<span class="badge"><span class="badgeDot"></span><strong>Reviewed:</strong> ${reviewedAt}</span>` : ""}
        </div>

        <div style="margin-top:10px">
          <div class="muted"><strong style="color:var(--text)">Requester:</strong> ${reqName}</div>
          <div class="muted mono">${reqEmail}</div>
          ${notes ? `<div class="help" style="margin-top:8px">${notes}</div>` : ""}
          ${st === "rejected" && rejectReason ? `<div class="err" style="margin-top:10px">Reject: ${rejectReason}</div>` : ""}
          ${st === "approved" && approvedOrgId ? `<div class="help" style="margin-top:10px">OrgId: <span class="mono">${approvedOrgId}</span></div>` : ""}
          ${st === "approved" && approvedAdminUserId ? `<div class="help">AdminUserId: <span class="mono">${approvedAdminUserId}</span></div>` : ""}

          ${renderEmailStatus(r)}
        </div>
      </div>
    `;

    const right = (String(st).toLowerCase() === "pending")
      ? renderPendingActions(id)
      : renderNonPendingActions(r);

    return `
      <div class="item" data-id="${id}" style="align-items:flex-start">
        <div style="flex:1;min-width:320px">${left}</div>
        <div class="itemActions" style="align-items:flex-start">${right}</div>
      </div>
    `;
  }

  async function loadList() {
    if (listMsg) listMsg.textContent = "";
    if (listWrap) listWrap.innerHTML = `<div class="item"><div class="muted">Loading…</div></div>`;

    try {
      const status = String(statusSel?.value || "pending");
      const data = await api(`/super/org-requests?status=${encodeURIComponent(status)}`);
      const items = Array.isArray(data?.items) ? data.items : [];

      if (!items.length) {
        listWrap.innerHTML = `<div class="item"><div class="muted">No requests found.</div></div>`;
        return;
      }

      listWrap.innerHTML = items.map(renderItem).join("");
      wireButtons();
    } catch (e) {
      listWrap.innerHTML = `<div class="item"><div class="err">Failed: ${esc(e.message)}</div></div>`;
      if (listMsg) listMsg.textContent = `Error: ${e.message}`;
    }
  }

  function wireButtons() {
    const items = listWrap.querySelectorAll(".item[data-id]");
    items.forEach((row) => {
      const approveBtn = row.querySelector(".approveBtn");
      const rejectBtn = row.querySelector(".rejectBtn");
      const resendBtn = row.querySelector("button[data-path]");

      approveBtn?.addEventListener("click", async () => {
        const id = row.getAttribute("data-id");
        const orgId = row.querySelector(".orgId")?.value?.trim();
        const adminUsername = row.querySelector(".adminUsername")?.value?.trim();

        if (!orgId || !adminUsername) {
          toast("orgId + adminUsername required");
          return;
        }

        approveBtn.disabled = true;
        const prevText = approveBtn.textContent;
        approveBtn.textContent = "Approving…";
        try {
          const out = await api(`/super/org-requests/${encodeURIComponent(id)}/approve`, {
            method: "POST",
            body: { orgId, adminUsername }
          });

          const setupLink = out?.setupLink || "";
          const expiresAt = out?.expiresAt || "";
          const emailSent = out?.emailSent === true;

          const outEl = row.querySelector(".setupOut");
          const copyEl = row.querySelector(".copyBtn");

          if (setupLink && outEl) {
            outEl.style.display = "block";
            outEl.textContent = `Setup Link (expires ${expiresAt}):\n${setupLink}`;
          }
          if (setupLink && copyEl) {
            copyEl.style.display = "inline-flex";
            copyEl.onclick = async () => {
              try {
                await navigator.clipboard.writeText(setupLink);
                toast("Copied setup link");
              } catch {
                toast("Copy failed (browser blocked)");
              }
            };
          }

          toast(emailSent ? "Approved ✅ Email sent" : "Approved ✅ (email NOT sent)");
          await loadList();
        } catch (e) {
          toast(`Approve failed: ${e.message}`);
        } finally {
          approveBtn.disabled = false;
          approveBtn.textContent = prevText || "Approve + Email Setup Link";
        }
      });

      rejectBtn?.addEventListener("click", async () => {
        const id = row.getAttribute("data-id");
        const reason = row.querySelector(".rejectReason")?.value?.trim() || "";

        rejectBtn.disabled = true;
        const prevText = rejectBtn.textContent;
        rejectBtn.textContent = "Rejecting…";
        try {
          const out = await api(`/super/org-requests/${encodeURIComponent(id)}/reject`, {
            method: "POST",
            body: { reason }
          });

          toast(out?.emailSent === true ? "Rejected ✅ Email sent" : "Rejected (email not sent)");
          await loadList();
        } catch (e) {
          toast(`Reject failed: ${e.message}`);
        } finally {
          rejectBtn.disabled = false;
          rejectBtn.textContent = prevText || "Reject + Email Reason";
        }
      });

      resendBtn?.addEventListener("click", async () => {
        const path = resendBtn.getAttribute("data-path");
        if (!path) return;

        resendBtn.disabled = true;
        const prev = resendBtn.textContent;
        resendBtn.textContent = "Sending…";
        try {
          await api(path, { method: "POST" });
          toast("Resent ✅");
          await loadList();
        } catch (e) {
          toast(`Resend failed: ${e.message}`);
        } finally {
          resendBtn.disabled = false;
          resendBtn.textContent = prev || "Resend Email";
        }
      });
    });
  }

  async function checkAccess() {
    if (guardMsg) guardMsg.textContent = "—";
    try {
      const me = await api("/auth/me");
      const user = me?.user;
      if (!user) throw new Error("No user returned from /auth/me");

      if (user.role !== "SuperAdmin") {
        setLocked("Not SuperAdmin");
        if (guardMsg) guardMsg.textContent = "Blocked: role is not SuperAdmin.";
        return false;
      }

      if (guardMsg) guardMsg.textContent = "OK";
      setUnlocked(user);
      await loadList();
      return true;
    } catch (e) {
      setLocked("Checking access failed");
      if (guardMsg) guardMsg.textContent = `Access check failed: ${e.message}`;
      return false;
    }
  }

  function hardLogoutAndRedirect() {
    sessionStorage.removeItem(SS_SUPER);
    sessionStorage.removeItem(SS_TOKEN);
    sessionStorage.removeItem(SS_USER);
    sessionStorage.removeItem(SS_ADMIN);
    sessionStorage.removeItem(SS_BASE);

    localStorage.removeItem(LS_SUPER);
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_USER);
    localStorage.removeItem(LS_ADMIN);
    localStorage.removeItem(LS_BASE);

    if (tokenEl) tokenEl.value = "";
    if (apiBaseEl) apiBaseEl.value = "";

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

    localStorage.setItem(LS_TOKEN, t || "");
    localStorage.setItem(LS_SUPER, t || "");
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

  refreshMeBtn?.addEventListener("click", () => checkAccess());
  reloadBtn?.addEventListener("click", () => loadList());
  statusSel?.addEventListener("change", () => loadList());

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

    checkAccess();
  })();
})();
