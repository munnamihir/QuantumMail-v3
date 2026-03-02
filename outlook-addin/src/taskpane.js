import { getSession, setSession, clearSession } from "./qm-storage.js";
import { normalizeBase, login, listOrgUsers, registerKey, createMessage } from "./qm-api.js";
import { aesEncrypt, importPublicSpkiB64, rsaWrapDek, encryptBytesWithRawDek } from "./qm-crypto.js";
import { getOrCreateRsaKeypair, getMyPublicSpkiB64 } from "./qm-keys.js";

const $ = (id) => document.getElementById(id);

let orgUsers = [];
let selectedRecipients = new Set();

function setStatus(msg) {
  $("status").textContent = String(msg || "");
}

function showLoggedInUI(isLoggedIn) {
  $("sessPill").style.display = isLoggedIn ? "inline-block" : "none";
  $("btnLogout").style.display = isLoggedIn ? "inline-block" : "none";
  $("btnReloadUsers").style.display = isLoggedIn ? "block" : "none";
  $("usersList").style.display = isLoggedIn ? "block" : "none";
  $("recipientsHint").style.display = isLoggedIn ? "none" : "block";
}

async function loadSessionIntoUI() {
  const s = await getSession();
  $("serverBase").value = s.serverBase || "https://quantummail-v2.onrender.com";
  showLoggedInUI(!!s?.token && !!s?.user?.userId);
  if (s?.token && s?.serverBase) {
    await loadUsers().catch(() => {});
  }
}

async function loadUsers() {
  const s = await getSession();
  if (!s?.token || !s?.serverBase) throw new Error("Please login first.");

  setStatus("Loading org users...");
  const out = await listOrgUsers(s.serverBase, s.token);
  const users = Array.isArray(out?.users) ? out.users : [];

  orgUsers = users
    .filter(u => u?.userId && u?.username)
    .map(u => ({
      userId: String(u.userId),
      username: String(u.username),
      publicKeySpkiB64: u.publicKeySpkiB64 || null,
      hasPublicKey: !!u.publicKeySpkiB64
    }))
    .sort((a, b) => a.username.localeCompare(b.username));

  selectedRecipients = new Set(Array.from(selectedRecipients).filter(uid => orgUsers.some(u => u.userId === uid)));
  renderUsers();
  setStatus(`Loaded ${orgUsers.length} users. Select recipients.`);
}

function renderUsers() {
  const q = String($("userSearch").value || "").toLowerCase().trim();
  const list = $("usersList");
  list.innerHTML = "";

  const filtered = orgUsers.filter(u => !q || u.username.toLowerCase().includes(q));
  if (!filtered.length) {
    list.innerHTML = `<div class="muted">No users found.</div>`;
    return;
  }

  for (const u of filtered) {
    const row = document.createElement("div");
    row.className = "user";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedRecipients.has(u.userId);
    cb.disabled = !u.hasPublicKey;
    cb.addEventListener("change", () => {
      if (cb.checked) selectedRecipients.add(u.userId);
      else selectedRecipients.delete(u.userId);
    });

    const text = document.createElement("div");
    text.innerHTML = `
      <div><strong>${escapeHtml(u.username)}</strong></div>
      <small>${u.hasPublicKey ? "Key ready" : "No key (user must login once)"}</small>
    `;

    row.appendChild(cb);
    row.appendChild(text);
    list.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function officeReady() {
  return new Promise((resolve, reject) => {
    Office.onReady((info) => {
      if (!info?.host) return reject(new Error("Office host not ready."));
      resolve(info);
    });
  });
}

function getBodyTextAsync() {
  return new Promise((resolve, reject) => {
    const item = Office.context?.mailbox?.item;
    if (!item?.body?.getAsync) return reject(new Error("No compose body available."));
    item.body.getAsync("text", (result) => {
      if (result.status !== Office.AsyncResultStatus.Succeeded) {
        return reject(new Error(result.error?.message || "Failed to read email body."));
      }
      resolve(String(result.value || ""));
    });
  });
}

function setBodyTextAsync(text) {
  return new Promise((resolve, reject) => {
    const item = Office.context?.mailbox?.item;
    if (!item?.body?.setAsync) return reject(new Error("No compose body available."));
    item.body.setAsync(String(text || ""), { coercionType: "text" }, (result) => {
      if (result.status !== Office.AsyncResultStatus.Succeeded) {
        return reject(new Error(result.error?.message || "Failed to set email body."));
      }
      resolve(true);
    });
  });
}

async function loginFlow() {
  const serverBase = normalizeBase($("serverBase").value);
  const orgId = String($("orgId").value || "").trim();
  const username = String($("username").value || "").trim();
  const password = String($("password").value || "");

  if (!serverBase || !orgId || !username || !password) {
    throw new Error("ServerBase, OrgId, Username, Password are required.");
  }

  setStatus("Logging in...");
  const out = await login(serverBase, orgId, username, password);
  const token = out?.token || "";
  const user = out?.user || null;
  if (!token || !user?.userId) throw new Error("Login failed: missing token/user.");

  setStatus("Preparing your device key...");
  await getOrCreateRsaKeypair(user.userId);

  const pubSpkiB64 = await getMyPublicSpkiB64(user.userId);
  setStatus("Registering public key...");
  await registerKey(serverBase, token, pubSpkiB64);

  await setSession({ serverBase, token, user });
  showLoggedInUI(true);

  setStatus("Login complete. Loading org users...");
  await loadUsers();
  setStatus("Ready.");
}

async function encryptFlow() {
  const s = await getSession();
  if (!s?.token || !s?.serverBase || !s?.user?.userId) throw new Error("Please login first.");

  const recipientIds = Array.from(selectedRecipients);
  if (!recipientIds.length) throw new Error("Select at least 1 recipient who has a key.");

  setStatus("Reading email body from Outlook...");
  const bodyText = (await getBodyTextAsync()).trim();
  if (!bodyText) throw new Error("Email body is empty. Type something first.");

  setStatus("Encrypting email body...");
  const aad = "outlook";
  const { ctB64Url, ivB64Url, rawDek } = await aesEncrypt(bodyText, aad);

  const files = Array.from($("filePicker").files || []);
  const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
  const totalBytes = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`Attachments too large for MVP (${Math.round(totalBytes / 1024 / 1024)}MB). Limit is 8MB.`);
  }

  setStatus(`Encrypting ${files.length} attachment(s)...`);
  const encAttachments = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    const bytes = new Uint8Array(buf);

    const ea = await encryptBytesWithRawDek(rawDek, bytes);
    encAttachments.push({
      name: f.name || "attachment",
      mimeType: f.type || "application/octet-stream",
      size: Number(f.size || bytes.length || 0),
      iv: ea.ivB64Url,
      ciphertext: ea.ctB64Url
    });
  }

  setStatus("Wrapping keys for recipients...");
  const wrappedKeys = {};
  const usersById = new Map(orgUsers.map(u => [u.userId, u]));
  let wrappedCount = 0;

  for (const uid of recipientIds) {
    const u = usersById.get(String(uid));
    if (!u?.publicKeySpkiB64) continue;

    const pub = await importPublicSpkiB64(u.publicKeySpkiB64);
    wrappedKeys[String(uid)] = await rsaWrapDek(pub, rawDek);
    wrappedCount++;
  }

  if (!wrappedCount) throw new Error("None of the selected recipients have keys registered yet.");

  setStatus("Uploading encrypted message...");
  const msgOut = await createMessage(s.serverBase, s.token, {
    iv: ivB64Url,
    ciphertext: ctB64Url,
    aad,
    wrappedKeys,
    attachments: encAttachments
  });

  const url = msgOut?.url;
  if (!url) throw new Error("Server did not return message URL.");

  setStatus("Inserting secure link into email...");
  const newBody =
`QuantumMail secure message:
${url}

(Only selected recipients can decrypt.)`;

  await setBodyTextAsync(newBody);

  setStatus(`✅ Done.\nRecipients: ${wrappedCount}\nLink inserted into the email body.\n`);
}

function wireUI() {
  $("btnLogin").addEventListener("click", async () => {
    try { await loginFlow(); } catch (e) { setStatus(`❌ ${e?.message || e}`); }
  });

  $("btnLogout").addEventListener("click", async () => {
    await clearSession();
    orgUsers = [];
    selectedRecipients = new Set();
    $("usersList").innerHTML = "";
    showLoggedInUI(false);
    setStatus("Logged out.");
  });

  $("btnReloadUsers").addEventListener("click", async () => {
    try { await loadUsers(); } catch (e) { setStatus(`❌ ${e?.message || e}`); }
  });

  $("userSearch").addEventListener("input", () => renderUsers());

  $("filePicker").addEventListener("change", () => {
    const files = Array.from($("filePicker").files || []);
    $("filesHint").textContent = `Selected: ${files.length}`;
  });

  $("btnEncrypt").addEventListener("click", async () => {
    try { await encryptFlow(); } catch (e) { setStatus(`❌ ${e?.message || e}`); }
  });
}

(async function main() {
  try {
    await officeReady();
    wireUI();
    await loadSessionIntoUI();
    setStatus("Ready.");
  } catch (e) {
    setStatus(`Office not ready: ${e?.message || e}`);
  }
})();
