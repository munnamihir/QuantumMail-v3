// /portal/decrypt.js
const $ = (id) => document.getElementById(id);

function getMsgIdFromPath() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] === "m" && parts[1]) return parts[1];
  return "";
}

function ok(msg) { $("ok").textContent = msg || ""; }
function err(msg) { $("err").textContent = msg || ""; }

function setBusy(busy) {
  const btn = $("btnDecrypt");
  if (!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? "Decrypting…" : "Login & Decrypt";
}

function bytesToBlobUrl(bytesArr, mimeType) {
  const bytes = new Uint8Array(bytesArr || []);
  const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
  return URL.createObjectURL(blob);
}

function renderAttachments(list) {
  const wrap = $("attachments");
  const host = $("attList");
  if (!wrap || !host) return;

  host.innerHTML = "";
  if (!Array.isArray(list) || list.length === 0) {
    wrap.style.display = "none";
    return;
  }

  wrap.style.display = "";
  for (const a of list) {
    const url = bytesToBlobUrl(a.bytes, a.mimeType);
    const row = document.createElement("div");
    row.className = "attItem";

    const link = document.createElement("a");
    link.href = url;
    link.download = a.name || "attachment";
    const kb = a.size ? Math.round(a.size / 1024) : null;
    link.textContent = `⬇ ${a.name || "attachment"}${kb ? ` • ${kb} KB` : ""}`;

    row.appendChild(link);
    host.appendChild(row);
  }
}

const msgId = getMsgIdFromPath();
$("msgId").textContent = msgId || "-";

// timers (avoid false "not detected")
function clearTimers() {
  if (window.__qmSlowTimer) {
    clearTimeout(window.__qmSlowTimer);
    window.__qmSlowTimer = null;
  }
  if (window.__qmHardTimer) {
    clearTimeout(window.__qmHardTimer);
    window.__qmHardTimer = null;
  }
}

function requestDecrypt() {
  ok(""); err("");
  $("out").value = "";
  renderAttachments([]);
  clearTimers();

  if (!msgId) { err("No message id in URL."); return; }

  const orgId = String($("orgId").value || "").trim();
  const username = String($("username").value || "").trim();
  const password = String($("password").value || "");

  if (!orgId || !username || !password) {
    err("Please enter orgId, username, and password.");
    return;
  }

  setBusy(true);
  ok("Contacting extension…");

  // ✅ after 1.2s: show slow message (NOT "not detected")
  window.__qmSlowTimer = setTimeout(() => {
    ok("Still working… (login + decrypt can take a few seconds)");
  }, 1200);

  // ✅ after 25s: now we can reasonably say not detected / no response
  window.__qmHardTimer = setTimeout(() => {
    setBusy(false);
    err(
      "No response from QuantumMail extension.\n" +
      "1) Install/enable the extension\n" +
      "2) Refresh this page\n" +
      "3) Try again"
    );
  }, 25000);

  window.postMessage(
    {
      source: "quantummail-portal",
      type: "QM_LOGIN_AND_DECRYPT_REQUEST",
      msgId,
      serverBase: window.location.origin,
      orgId,
      username,
      password
    },
    "*"
  );
}

window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data?.source !== "quantummail-extension") return;
  if (data?.type !== "QM_DECRYPT_RESULT") return;

  // ✅ any response means extension is detected — stop timers
  clearTimers();
  setBusy(false);

  if (data.ok) {
    ok(data.message || "Decrypted ✅ (access audited)");
    $("out").value = data.plaintext || "";
    renderAttachments(data.attachments || []);
  } else {
    err(data.error || "Decrypt failed");
    renderAttachments([]);
  }
});

$("btnDecrypt").addEventListener("click", requestDecrypt);
$("password")?.addEventListener("keydown", (e) => { if (e.key === "Enter") requestDecrypt(); });
