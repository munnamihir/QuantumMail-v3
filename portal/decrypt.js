const $ = (id) => document.getElementById(id);
const ok = (m) => (($("ok").textContent = m || ""), ($("err").textContent = ""));
const err = (m) => (($("err").textContent = m || ""), ($("ok").textContent = ""));

function getMsgIdFromUrl() {
  // Support /m/:id OR ?id=
  const u = new URL(location.href);
  const q = u.searchParams.get("id");
  if (q) return q;
  const parts = u.pathname.split("/").filter(Boolean);
  const mIndex = parts.indexOf("m");
  if (mIndex >= 0 && parts[mIndex + 1]) return parts[mIndex + 1];
  // fallback last segment
  return parts[parts.length - 1] || "";
}

function sendToExtension(msg) {
  return new Promise((resolve, reject) => {
    // content script bridge (since portal is on https://*.onrender.com/* in your manifest)
    window.postMessage({ source: "QM_PORTAL", msg }, "*");
    const onMsg = (ev) => {
      if (!ev?.data || ev.data.source !== "QM_EXTENSION_REPLY") return;
      window.removeEventListener("message", onMsg);
      resolve(ev.data.payload);
    };
    window.addEventListener("message", onMsg);

    setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("Extension not detected. Install/enable it, refresh, and try again."));
    }, 1200);
  });
}

// ask extension to “ping”
async function checkExtension() {
  try {
    const r = await sendToExtension({ type: "QM_PING_FROM_PORTAL" });
    if (r?.ok) {
      $("extStatus").textContent = "Extension detected ✅";
      return true;
    }
    throw new Error("No response");
  } catch (e) {
    $("extStatus").textContent = "Extension not detected ❌ (install/enable → refresh)";
    return false;
  }
}

$("btnDecrypt").addEventListener("click", async () => {
  try {
    ok("");
    $("out").textContent = "(decrypting…)";

    const msgId = getMsgIdFromUrl();
    const orgId = String($("orgId").value || "").trim();
    const username = String($("username").value || "").trim();
    const serverBase = location.origin; // same origin

    if (!msgId) throw new Error("Missing message id in URL.");
    if (!orgId || !username) throw new Error("Enter orgId and username.");

    const out = await sendToExtension({
      type: "QM_CHALLENGE_LOGIN_AND_DECRYPT",
      msgId,
      serverBase,
      orgId,
      username
    });

    if (!out?.ok) throw new Error(out?.error || "Decrypt failed");
    $("out").textContent = out.plaintext || "";
    ok("Decrypted ✅");
  } catch (e) {
    $("out").textContent = "(empty)";
    err(e?.message || String(e));
  }
});

checkExtension();
