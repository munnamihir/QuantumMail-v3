import {
  getSession,
  normalizeBase,
  createEncryptedKeyBackup,
  restoreKeyFromBackup
} from "./qm.js";

const $ = (id) => document.getElementById(id);
const ok = (m) => (($("ok").textContent = m || ""), ($("err").textContent = ""));
const err = (m) => (($("err").textContent = m || ""), ($("ok").textContent = ""));

async function api(serverBase, path, token, { method = "GET", body = null } = {}) {
  const base = normalizeBase(serverBase);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

async function loadStatus() {
  const s = await getSession();
  const { token, serverBase, user } = s;

  if (!token || !serverBase || !user?.id) {
    $("status").textContent = "Not logged in in the extension. Login once first.";
    return null;
  }

  const st = await api(serverBase, "/org/key-backup/status", token);
  $("status").textContent =
    `Logged in as ${user.username}@${user.orgId} • backup: ${st.hasBackup ? "YES" : "NO"}${st.createdAt ? " • " + st.createdAt : ""}`;
  return { token, serverBase, user };
}

function requireBackupPassphrase() {
  const p1 = String($("pw1").value || "");
  const p2 = String($("pw2").value || "");
  if (!p1 || p1.length < 10) throw new Error("Use a passphrase of at least 10 characters.");
  if (p1 !== p2) throw new Error("Passphrase confirmation does not match.");
  return p1;
}

$("btnBackup").addEventListener("click", async () => {
  try {
    ok("");
    const ctx = await loadStatus();
    if (!ctx) return;

    const passphrase = requireBackupPassphrase();
    const backup = await createEncryptedKeyBackup(ctx.user.id, passphrase);
    await api(ctx.serverBase, "/org/key-backup", ctx.token, { method: "POST", body: backup });

    ok("Backup saved ✅\n(Server stored ciphertext only.)");
    await loadStatus();
  } catch (e) {
    err(e?.message || String(e));
  }
});

$("btnRestore").addEventListener("click", async () => {
  try {
    ok("");
    const ctx = await loadStatus();
    if (!ctx) return;

    const passphrase = String($("pw1").value || "");
    if (!passphrase) throw new Error("Enter your passphrase (no confirm needed for restore).");

    const out = await api(ctx.serverBase, "/org/key-backup", ctx.token);
    await restoreKeyFromBackup(ctx.user.id, passphrase, out.keyBackup);

    ok("Key restored ✅\nIf public key is missing, regenerate + re-register on next login.");
    await loadStatus();
  } catch (e) {
    err(e?.message || String(e));
  }
});

$("btnDelete").addEventListener("click", async () => {
  try {
    ok("");
    const ctx = await loadStatus();
    if (!ctx) return;

    await api(ctx.serverBase, "/org/key-backup", ctx.token, { method: "DELETE" });
    ok("Backup deleted ✅");
    await loadStatus();
  } catch (e) {
    err(e?.message || String(e));
  }
});

loadStatus().catch((e) => err(e?.message || String(e)));
