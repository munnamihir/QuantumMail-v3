// extension/background.js (FULL UPDATED)

// IMPORTANT:
// - Do NOT redeclare apiJson or rsaUnwrapDek here.
// - Use qm.js as the single source of truth for crypto + API helpers.

import {
  normalizeBase,
  apiJson,
  getSession,
  setSession,
  getOrCreateRsaKeypair,
  ensureKeypairAndRegister,
  aesEncrypt,
  aesDecrypt,
  importPublicSpkiB64,
  rsaWrapDek,
  rsaUnwrapDek,
  signNonceB64,
  bytesToB64Url,
  b64UrlToBytes
} from "./qm.js";

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
      reject(new Error("Timed out talking to content script. Refresh the tab and try again."));
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

function aadFromTabUrl(tabUrl) {
  const u = String(tabUrl || "").toLowerCase();
  if (u.includes("mail.google.com")) return "gmail";
  if (u.includes("outlook.office.com")) return "outlook";
  if (u.includes("outlook.live.com")) return "outlook";
  return "web";
}

/* =========================
   Attachment crypto (AES-GCM using same rawDek)
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

  // Register device public key with server (your existing idea)
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

  return users
    .filter((u) => u?.userId && u?.username)
    .map((u) => ({
      userId: u.userId,
      username: u.username,
      hasKey: !!u.publicKeySpkiB64
    }))
    .sort((a, b) => String(a.username).localeCompare(String(b.username)));
}

/* =========================
   Encrypt selection (optionally recipients)
========================= */

async function encryptSelectionOrgWide({ attachments = [], recipientUserIds = [] } = {}) {
  const s = await getSession();
  if (!s?.token || !s?.serverBase) throw new Error("Please login first in the popup.");

  const list = Array.isArray(attachments) ? attachments : [];
  const totalBytes = list.reduce((sum, a) => sum + Number(a?.size || 0), 0);
  const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8MB MVP limit
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

  // Encrypt text
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

  // Fetch org users
  const usersOut = await apiJson(s.serverBase, "/org/users", { token: s.token });
  const users = Array.isArray(usersOut?.users) ? usersOut.users : [];

  // If recipients chosen -> restrict wrapping set
  const restrict =
    Array.isArray(recipientUserIds) && recipientUserIds.length
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
    const wrappedDekB64Url = await rsaWrapDek(pub, rawDek);
    wrappedKeys[uid] = wrappedDekB64Url;
    wrappedCount++;
  }

  if (wrappedCount === 0) {
    throw new Error(
      restrict
        ? "None of the selected recipients have keys registered yet."
        : "No org users have public keys registered yet. Have at least one user login once."
    );
  }

  // Create message on server
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

  // Replace selection with link
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
   Login + decrypt message (password flow)
========================= */

async function loginAndDecrypt({ msgId, serverBase, orgId, username, password }) {
  const { base, token, user } = await loginAndStoreSession({ serverBase, orgId, username, password });

  const payload = await apiJson(base, `/api/messages/${encodeURIComponent(msgId)}`, { token });
  if (!payload?.wrappedDek) throw new Error("Missing wrappedDek in payload.");

  const kp = await getOrCreateRsaKeypair(user.userId);

  let rawDekBytes;
  try {
    rawDekBytes = await rsaUnwrapDek(kp.privateKeyOAEP, payload.wrappedDek);
  } catch {
    throw new Error(
      "Decrypt failed: your device key does not match the key used when this link was created.\n" +
        "This happens after reinstall/re-key/cleared storage.\n" +
        "Ask the sender to re-encrypt and send a fresh link."
    );
  }

  const plaintext = await aesDecrypt(payload.iv, payload.ciphertext, payload.aad || "web", rawDekBytes);

  // Decrypt attachments
  const outAttachments = [];
  const encAtts = Array.isArray(payload.attachments) ? payload.attachments : [];
  for (const a of encAtts) {
    if (!a?.iv || !a?.ciphertext) continue;
    const ptBytes = await decryptBytesWithRawDek(rawDekBytes, a.iv, a.ciphertext);
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
   Crypto-login (nonce sign) + decrypt (no password)
========================= */

async function challengeLoginAndDecrypt({ msgId, serverBase, orgId, username }) {
  const base = normalizeBase(serverBase);

  // 1) get challenge
  const ch = await apiJson(base, "/auth/challenge", {
    method: "POST",
    body: { orgId, username }
  });

  // 2) sign nonce using device key
  const s = await getSession();
  const userId = s?.user?.userId;
  if (!userId) {
    throw new Error("No extension session. Login once (password) so your key is created/registered.");
  }

  const kp = await getOrCreateRsaKeypair(userId);
  const signatureB64 = await signNonceB64(kp.privateKeyPSS, ch.nonceB64);

  // 3) verify challenge -> token
  const ver = await apiJson(base, "/auth/challenge/verify", {
    method: "POST",
    body: { orgId, username, challengeId: ch.challengeId, signatureB64 }
  });

  const token = ver.token;
  const user = ver.user;
  await setSession({ serverBase: base, token, user });

  // 4) decrypt message payload
  const payload = await apiJson(base, `/api/messages/${encodeURIComponent(msgId)}`, { token });
  if (!payload?.wrappedDek) throw new Error("Missing wrappedDek in payload.");

  const rawDekBytes = await rsaUnwrapDek(kp.privateKeyOAEP, payload.wrappedDek);
  const plaintext = await aesDecrypt(payload.iv, payload.ciphertext, payload.aad || "web", rawDekBytes);

  return { plaintext, attachments: payload.attachments || [] };
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

      if (msg?.type === "QM_CHALLENGE_LOGIN_AND_DECRYPT") {
        const { msgId, serverBase, orgId, username } = msg;
        const out = await challengeLoginAndDecrypt({ msgId, serverBase, orgId, username });
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
