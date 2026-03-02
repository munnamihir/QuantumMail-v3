import {
  getSession,
  normalizeBase,
  createEncryptedKeyBackup,
  restoreKeyFromBackup,
  apiJson
} from "./qm.js";

const $ = (id) => document.getElementById(id);
const ok = (m) => (($("ok").textContent = m || ""), ($("err").textContent = ""));
const err = (m) => (($("err").textContent = m || ""), ($("ok").textContent = ""));

async function loadStatus() {
  const s = await getSession();
  const { token, serverBase, user } = s;

  if (!token || !serverBase || !user?.userId) {
    $("status").textContent = "Not logged in in the extension. Login once first.";
    return null;
  }

  const base = normalizeBase(serverBase);
  const st = await apiJson(base, "/org/key-backup/status", { token });
  $("status").textContent =
    `Logged in as ${user.username}@${user.orgId} • backup: ${st.hasBackup ? "YES" : "NO"}${st.createdAt ? " • " + st.createdAt : ""}`;
  return { token, base, user };
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
    const backup = await createEncryptedKeyBackup(ctx.user.userId, passphrase);

    await apiJson(ctx.base, "/org/key-backup", { method: "POST", token: ctx.token, body: backup });

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

    const out = await apiJson(ctx.base, "/org/key-backup", { token: ctx.token });
    await restoreKeyFromBackup(ctx.user.userId, passphrase, out.keyBackup);

    ok("Key restored ✅");
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

    await apiJson(ctx.base, "/org/key-backup", { method: "DELETE", token: ctx.token });
    ok("Backup deleted ✅");
    await loadStatus();
  } catch (e) {
    err(e?.message || String(e));
  }
});

loadStatus().catch((e) => err(e?.message || String(e)));
