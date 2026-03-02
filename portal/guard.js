// portal/guard.js

export function getToken() {
  return localStorage.getItem("qm_token") || "";
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem("qm_user") || "null");
  } catch {
    return null;
  }
}

export function logout() {
  localStorage.removeItem("qm_token");
  localStorage.removeItem("qm_user");
  localStorage.removeItem("qm_role");
  localStorage.removeItem("qm_orgId");
  localStorage.removeItem("qm_username");
  location.href = "/portal/index.html";
}

export async function api(path, { method = "GET", body = null } = {}) {
  const token = getToken();
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });

  const raw = await res.text().catch(() => "");
  let data = {};
  try {
    data = (res.headers.get("content-type") || "").includes("application/json")
      ? JSON.parse(raw || "{}")
      : { raw };
  } catch {
    data = { raw };
  }

  if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}: ${raw.slice(0, 200)}`);
  return data;
}

// ✅ Call this at top of every protected page
export async function requireAuth({ role = null } = {}) {
  const token = getToken();
  if (!token) {
    location.replace("/portal/index.html");
    return null;
  }

  try {
    const me = await api("/auth/me");
    const user = me?.user || getUser();

    // keep fresh
    if (user) localStorage.setItem("qm_user", JSON.stringify(user));

    if (role && user?.role !== role && !(role === "Admin" && user?.role === "SuperAdmin")) {
      // allow SuperAdmin to pass Admin pages
      alert("Not authorized for this page.");
      logout();
      return null;
    }

    return user;
  } catch (e) {
    // invalid/expired token
    logout();
    return null;
  }
}
