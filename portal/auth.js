// portal/auth.js

const KEY = "qm_session_v1";

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
}

export function setSession({ serverBase, token, user }) {
  localStorage.setItem(KEY, JSON.stringify({ serverBase, token, user }));
}

export function clearSession() {
  localStorage.removeItem(KEY);
}

export function authHeader() {
  const s = getSession();
  if (!s?.token) return {};
  return { Authorization: `Bearer ${s.token}` };
}

export async function apiJson(path, { method = "GET", body = null } = {}) {
  const s = getSession();
  if (!s?.serverBase) throw new Error("Missing server base. Please login again.");

  const url = `${s.serverBase}${path}`;
  const headers = { Accept: "application/json", ...authHeader() };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const raw = await res.text().catch(() => "");
  let data = {};
  try {
    data = (res.headers.get("content-type") || "").includes("application/json")
      ? JSON.parse(raw || "{}")
      : { raw };
  } catch {
    data = { raw };
  }

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }

  return data;
}

// ✅ Guard: redirects to index.html if not logged in / invalid token
export async function requireAuth({ requireAdmin = false } = {}) {
  const s = getSession();
  if (!s?.token || !s?.serverBase) {
    location.replace("/portal/index.html");
    return null;
  }

  try {
    const me = await apiJson("/auth/me");
    const role = me?.user?.role || s?.user?.role;

    if (requireAdmin && role !== "Admin" && role !== "SuperAdmin") {
      // logged in but not admin
      alert("Admin access only.");
      clearSession();
      location.replace("/portal/index.html");
      return null;
    }

    // keep user fresh
    setSession({ serverBase: s.serverBase, token: s.token, user: me.user });
    return me.user;
  } catch (e) {
    // token expired/invalid
    clearSession();
    location.replace("/portal/index.html");
    return null;
  }
}
