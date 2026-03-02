// extension/content.js
// Gmail-safe selection caching (polling) + replace selection with link + decrypt bridge

let cachedSelectionText = "";
let cachedRange = null;
let lastActiveCompose = null;

function cloneRangeIfPossible(sel) {
  try {
    if (!sel || sel.rangeCount === 0) return null;
    return sel.getRangeAt(0).cloneRange();
  } catch {
    return null;
  }
}

function cacheSelectionNow() {
  try {
    const sel = window.getSelection?.();
    if (!sel) return;

    const text = String(sel.toString() || "").trim();
    if (text) cachedSelectionText = text;

    const r = cloneRangeIfPossible(sel);
    if (r && text) cachedRange = r;
  } catch {}
}

// Track last focused compose editor
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!el) return;

  // Gmail compose is usually [role="textbox"][contenteditable=true]
  if (el.isContentEditable || el.getAttribute?.("contenteditable") === "true") {
    lastActiveCompose = el;
  }
});

// Cache selection on many events (Gmail drops selection easily)
document.addEventListener("pointerdown", cacheSelectionNow, true);
document.addEventListener("pointerup", cacheSelectionNow, true);
document.addEventListener("mouseup", cacheSelectionNow, true);
document.addEventListener("keyup", cacheSelectionNow, true);
document.addEventListener("selectionchange", cacheSelectionNow, true);

// ✅ Polling cache (most reliable for Gmail + popup focus loss)
setInterval(() => {
  cacheSelectionNow();
}, 250);

function getSelectionTextRobust() {
  // 1) live selection
  try {
    const live = String(window.getSelection?.()?.toString() || "").trim();
    if (live) return live;
  } catch {}

  // 2) cached selection
  if (cachedSelectionText) return cachedSelectionText;

  return "";
}

// Replace using cached range (best effort)
function replaceUsingCachedRange(link) {
  try {
    if (!cachedRange) return false;

    const common = cachedRange.commonAncestorContainer;
    const containerEl = common?.nodeType === Node.ELEMENT_NODE ? common : common?.parentElement;
    if (!containerEl || !document.contains(containerEl)) return false;

    // ensure in contenteditable tree
    let cur = containerEl;
    let okEditable = false;
    while (cur && cur !== document.body) {
      if (cur.isContentEditable || cur.getAttribute?.("contenteditable") === "true") {
        okEditable = true;
        break;
      }
      cur = cur.parentElement;
    }
    if (!okEditable) return false;

    cachedRange.deleteContents();
    cachedRange.insertNode(document.createTextNode(link));

    cachedRange.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(cachedRange);

    // clear caches
    cachedSelectionText = "";
    cachedRange = null;
    return true;
  } catch {
    return false;
  }
}

// Replace using execCommand (works if selection still active)
function replaceUsingExecCommand(link) {
  try {
    // If selection is active, this overwrites it
    const ok = document.execCommand("insertText", false, link);
    if (ok) {
      cachedSelectionText = "";
      cachedRange = null;
    }
    return ok;
  } catch {
    return false;
  }
}

// Insert fallback (if no selection replace possible)
function insertFallback(link) {
  try {
    const editor =
      (document.activeElement && document.activeElement.isContentEditable && document.activeElement) ||
      lastActiveCompose ||
      document.querySelector('[role="textbox"][contenteditable="true"]');

    if (!editor) return false;
    editor.focus();
    document.execCommand("insertText", false, link);
    return true;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "QM_GET_SELECTION") {
        const text = getSelectionTextRobust();
        sendResponse({ ok: true, text });
        return;
      }

      if (msg?.type === "QM_REPLACE_SELECTION_WITH_LINK") {
        const url = String(msg.url || "").trim();
        if (!url) return sendResponse({ ok: false, error: "Missing url" });

        // 1) direct replace
        if (replaceUsingExecCommand(url)) return sendResponse({ ok: true });

        // 2) cached range replace
        if (replaceUsingCachedRange(url)) return sendResponse({ ok: true });

        // 3) fallback insert
        if (insertFallback(url)) {
          return sendResponse({
            ok: true,
            warning: "Inserted link, but could not replace selection. Re-select and try again for exact replace."
          });
        }

        return sendResponse({
          ok: false,
          error: "Select text in the email body first (compose body)."
        });
      }

      if (msg?.type === "QM_PING") {
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true;
});

// -----------------------
// Decrypt bridge for /m/<id>
// -----------------------
function getMsgIdFromPath() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] === "m" && parts[1]) return parts[1];
  return null;
}

if (location.pathname.startsWith("/m/")) {
  window.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data?.source !== "quantummail-portal") return;
    if (data?.type !== "QM_LOGIN_AND_DECRYPT_REQUEST") return;

    const msgId = data.msgId || getMsgIdFromPath();

    // inside your existing "/m/" bridge callback:
    chrome.runtime.sendMessage(
      {
        type: "QM_LOGIN_AND_DECRYPT",
        msgId,
        serverBase: data.serverBase,
        orgId: data.orgId,
        username: data.username,
        password: data.password
      },
      (resp) => {
        const out = resp?.ok
          ? {
              source: "quantummail-extension",
              type: "QM_DECRYPT_RESULT",
              ok: true,
              plaintext: resp.plaintext,
              attachments: resp.attachments || [],
              message: "Decrypted ✅ (access audited)"
            }
          : {
              source: "quantummail-extension",
              type: "QM_DECRYPT_RESULT",
              ok: false,
              error: resp?.error || "Decrypt failed"
            };
    
        window.postMessage(out, "*");
      }
    );
  });
}
