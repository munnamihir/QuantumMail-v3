// extension/background.js (UPDATED)

import {
  normalizeBase,
  getSession,
  setSession,
  ensureKeypairAndRegister,
  aesEncrypt,
  aesDecrypt,
  importPublicSpkiB64,
  rsaWrapDek,
  b64UrlToBytes,
  getOrCreateRsaKeypair
} from "./qm.js";

/* =========================
   Robust helpers
========================= */

function shortenText(s, n = 280) {
  const str = String(s || "");
  return str.length <= n ? str : str.slice(0, n) + "…";
}

async function readResponseSmart(res) {
  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  const raw = await res.text().catch(() => "");
  if (ct.includes("application/json")) {
    try {
      return { kind: "json", data: JSON.parse(raw || "{}"), raw };
    } catch {
      return { kind: "text", data: raw, raw };
    }
  }
  return { kind: "text", data: raw, raw };
}

async function apiJson(serverBase, path, { method = "GET", token = "", body = null } = {}) {
  const base = normalizeBase(serverBase);
  const url = `${base}${path}`;

  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error(`[NET] ${method} ${path} -> ${e?.message || e}`);
  }

  const parsed = await readResponseSmart(res);

  if (!res.ok) {
    const msg =
      (parsed.kind === "json" && (parsed.data?.error || parsed.data?.message)) ||
      shortenText(parsed.raw || parsed.data || "", 320) ||
      `Request failed (${res.status})`;

    throw new Error(`[HTTP ${res.status}] ${method} ${path} -> ${msg}`);
  }

  if (parsed.kind === "json") return parsed.data;
  return { ok: true, raw: parsed.data };
}

/* =========================
   Chrome tab messaging
========================= */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  return tab;
}

async function sendToTab(tabId, msg, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("Timed out talking to content script. Refresh the Gmail/Outlook tab and try again."));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (done) return;
      done = true;
      clearTimeout(t);

      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp);
    });
  });
}

function aadFromTabUrl(tabUrl) {
  const u = String(tabUrl || "").toLowerCase();
  if (u.includes("mail.google.com")) return "gmail";
  if (u.includes("outlook.office.com")) return "outlook";
  if (u.includes("outlook.live.com")) return "outlook";
  return "web";
}

/* =========================
   Base64URL (safe for larger data)
========================= */

function bytesToB64Url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = "";
  const chunkSize = 0x2000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/* =========================
   Attachment crypto
========================= */

function attachmentToU8(a) {
  if (!a) return new Uint8Array();
  if (Array.isArray(a.bytes)) return new Uint8Array(a.bytes);
  if (a.buffer instanceof ArrayBuffer) return new Uint8Array(a.buffer);
  if (a.buffer?.byteLength != null && typeof a.buffer.slice === "function") return new Uint8Array(a.buffer);
  return new Uint8Array();
}

async function encryptBytesWithRawDek(rawDekBytes, plainBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawDekBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);
  return { iv: bytesToB64Url(iv), ciphertext: bytesToB64Url(new Uint8Array(ct)) };
}

async function decryptBytesWithRawDek(rawDekBytes, ivB64Url, ctB64Url) {
  const iv = b64UrlToBytes(ivB64Url);
  const ct = b64UrlToBytes(ctB64Url);
  const key = await crypto.subtle.importKey("raw", rawDekBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(pt);
}

async function rsaUnwrapDek(privateKey, wrappedDekB64Url) {
  const wrappedBytes = b64UrlToBytes(wrappedDekB64Url);
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, wrappedBytes);
  return new Uint8Array(raw);
}

/* =========================
   Session + login
========================= */

async function loginAndStoreSession({ serverBase, orgId, username, password }) {
  const base = normalizeBase(serverBase);

  const out = await apiJson(base, "/auth/login", {
    method: "POST",
    body: { orgId, username, password }
  });

  const token = out?.token || "";
  const user = out?.user || null;
  if (!token || !user?.userId) throw new Error("Login failed: missing token/user.");

  // ✅ register per-user key (OperationError fix)
  await ensureKeypairAndRegister(base, token, user.userId);

  await setSession({ serverBase: base, token, user });
  return { base, token, user };
}

/* =========================
   Org users (for autocomplete)
========================= */

async function listOrgUsersForAutocomplete() {
  const s = await getSession();
  if (!s?.token || !s?.serverBase) throw new Error("Please login first.");

  const usersOut = await apiJson(s.serverBase, "/org/users", { token: s.token });
  const users = Array.isArray(usersOut?.users) ? usersOut.users : [];

  // Keep only what popup needs
  return users
    .filter(u => u?.userId && u?.username)
    .map(u => ({
      userId: u.userId,
      username: u.username,
      hasKey: !!u.publicKeySpkiB64
    }))
    .sort((a, b) => String(a.username).localeCompare(String(b.username)));
}

/* =========================
   Encrypt selection (optionally recipients)
========================= */

async function assertContentScriptAvailable(tabId) {
  try {
    const r = await sendToTab(tabId, { type: "QM_PING" }, 900);
    if (!r?.ok) throw new Error("Ping failed");
  } catch (e) {
    throw new Error(
      `Content script not available in this tab.\n` +
        `Fix:\n` +
        `1) Open Gmail/Outlook compose window\n` +
        `2) Refresh the tab (Cmd/Ctrl+R)\n` +
        `3) Re-open the popup and try again\n\n` +
        `Details: ${e.message}`
    );
  }
}

async function encryptSelectionOrgWide({ attachments = [], recipientUserIds = [] } = {}) {
  const s = await getSession();
  if (!s?.token || !s?.serverBase) throw new Error("Please login first in the popup.");

  const list = Array.isArray(attachments) ? attachments : [];
  const totalBytes = list.reduce((sum, a) => sum + Number(a?.size || 0), 0);
  const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`Attachments too large for MVP (${Math.round(totalBytes / 1024 / 1024)}MB). Limit is 8MB.`);
  }

  const tab = await getActiveTab();
  const tabId = tab.id;
  const aad = aadFromTabUrl(tab.url);

  await assertContentScriptAvailable(tabId);

  const sel = await sendToTab(tabId, { type: "QM_GET_SELECTION" });
  const plaintext = String(sel?.text || "").trim();
  if (!plaintext) throw new Error("Select text in the email body first (compose body).");

  const { ctB64Url, ivB64Url, rawDek } = await aesEncrypt(plaintext, aad);

  // Encrypt attachments with SAME rawDek
  const encAttachments = [];
  for (const a of list) {
    const bytes = attachmentToU8(a);
    if (!bytes || bytes.length === 0) continue;

    const ea = await encryptBytesWithRawDek(rawDek, bytes);
    encAttachments.push({
      name: a.name || "attachment",
      mimeType: a.mimeType || "application/octet-stream",
      size: Number(a.size || bytes.length || 0),
      iv: ea.iv,
      ciphertext: ea.ciphertext
    });
  }

  // Fetch org users once
  const usersOut = await apiJson(s.serverBase, "/org/users", { token: s.token });
  const users = Array.isArray(usersOut?.users) ? usersOut.users : [];

  // If recipients chosen -> restrict wrapping set
  const restrict = Array.isArray(recipientUserIds) && recipientUserIds.length
    ? new Set(recipientUserIds.map(String))
    : null;

  const wrappedKeys = {};
  let wrappedCount = 0;
  let skippedNoKey = 0;
  let skippedNotSelected = 0;

  for (const u of users) {
    if (!u?.userId) continue;
    const uid = String(u.userId);

    if (restrict && !restrict.has(uid)) {
      skippedNotSelected++;
      continue;
    }

    if (!u.publicKeySpkiB64) {
      skippedNoKey++;
      continue;
    }

    const pub = await importPublicSpkiB64(u.publicKeySpkiB64);
    const wrappedDek = await rsaWrapDek(pub, rawDek);
    wrappedKeys[uid] = wrappedDek;
    wrappedCount++;
  }

  if (wrappedCount === 0) {
    throw new Error(
      restrict
        ? "None of the selected recipients have keys registered yet."
        : "No org users have public keys registered yet. Have at least one user login once."
    );
  }

  const msgOut = await apiJson(s.serverBase, "/api/messages", {
    method: "POST",
    token: s.token,
    body: {
      iv: ivB64Url,
      ciphertext: ctB64Url,
      aad,
      wrappedKeys,
      attachments: encAttachments
    }
  });

  const url = msgOut?.url;
  if (!url) throw new Error("Server did not return message URL.");

  const rep = await sendToTab(tabId, { type: "QM_REPLACE_SELECTION_WITH_LINK", url });
  if (!rep?.ok) throw new Error(rep?.error || "Failed to insert link into email.");

  return {
    url,
    wrappedCount,
    skippedNoKey,
    skippedNotSelected,
    warning: rep?.warning || null
  };
}

/* =========================
   Login + decrypt message
========================= */

async function loginAndDecrypt({ msgId, serverBase, orgId, username, password }) {
  const { base, token, user } = await loginAndStoreSession({ serverBase, orgId, username, password });

  const payload = await apiJson(base, `/api/messages/${encodeURIComponent(msgId)}`, { token });
  if (!payload?.wrappedDek) throw new Error("Missing wrappedDek in payload.");

  const kp = await getOrCreateRsaKeypair(user.userId);

  let rawDek;
  try {
    rawDek = await rsaUnwrapDek(kp.privateKey, payload.wrappedDek);
  } catch {
    throw new Error(
      "Decrypt failed: your device key does not match the key used when this link was created.\n" +
      "This happens after reinstall/re-key/cleared storage.\n" +
      "Ask the sender to re-encrypt and send a fresh link."
    );
  }

  const plaintext = await aesDecrypt(payload.iv, payload.ciphertext, payload.aad || "web", rawDek);

  const outAttachments = [];
  const encAtts = Array.isArray(payload.attachments) ? payload.attachments : [];
  for (const a of encAtts) {
    if (!a?.iv || !a?.ciphertext) continue;
    const ptBytes = await decryptBytesWithRawDek(rawDek, a.iv, a.ciphertext);
    outAttachments.push({
      name: a.name || "attachment",
      mimeType: a.mimeType || "application/octet-stream",
      size: Number(a.size || ptBytes.length || 0),
      bytes: Array.from(ptBytes)
    });
  }

  return { plaintext, attachments: outAttachments };
}

/* =========================
   Message router
========================= */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "QM_LOGIN") {
        const { serverBase, orgId, username, password } = msg;
        await loginAndStoreSession({ serverBase, orgId, username, password });
        sendResponse({ ok: true });
        return;
      }

      // ✅ NEW: recipients list for autocomplete
      if (msg?.type === "QM_RECIPIENTS") {
        const users = await listOrgUsersForAutocomplete();
        sendResponse({ ok: true, users });
        return;
      }

      if (msg?.type === "QM_ENCRYPT_SELECTION") {
        const out = await encryptSelectionOrgWide({
          attachments: msg.attachments || [],
          recipientUserIds: msg.recipientUserIds || []
        });
        sendResponse({ ok: true, ...out });
        return;
      }

      if (msg?.type === "QM_LOGIN_AND_DECRYPT") {
        const { msgId, serverBase, orgId, username, password } = msg;
        const out = await loginAndDecrypt({ msgId, serverBase, orgId, username, password });
        sendResponse({ ok: true, plaintext: out.plaintext, attachments: out.attachments });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (e) {
      console.error("QuantumMail background error:", e);
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true;
});

chrome.runtime.onInstalled?.addListener(() => {});
