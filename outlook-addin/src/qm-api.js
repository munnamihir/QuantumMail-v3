export function normalizeBase(url) {
  let s = String(url || "").trim();
  if (s && !/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

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

export async function apiJson(serverBase, path, { method = "GET", token = "", body = null } = {}) {
  const base = normalizeBase(serverBase);
  const url = `${base}${path}`;

  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

export async function login(serverBase, orgId, username, password) {
  return apiJson(serverBase, "/auth/login", { method: "POST", body: { orgId, username, password } });
}

export async function listOrgUsers(serverBase, token) {
  return apiJson(serverBase, "/org/users", { token });
}

export async function registerKey(serverBase, token, publicKeySpkiB64) {
  async function tryRegister(path) {
    return apiJson(serverBase, path, { method: "POST", token, body: { publicKeySpkiB64 } });
  }
  try {
    return await tryRegister("/org/register-key");
  } catch {
    return await tryRegister("/pubkey_register");
  }
}

export async function createMessage(serverBase, token, payload) {
  return apiJson(serverBase, "/api/messages", { method: "POST", token, body: payload });
}
