
const KEY = "qm_session_v1";

function hasOfficeRuntimeStorage() {
  return typeof OfficeRuntime !== "undefined" && OfficeRuntime?.storage?.getItem;
}

export async function getSession() {
  try {
    if (hasOfficeRuntimeStorage()) {
      const raw = await OfficeRuntime.storage.getItem(KEY);
      return raw ? JSON.parse(raw) : { serverBase: "", token: "", user: null };
    }
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : { serverBase: "", token: "", user: null };
  } catch {
    return { serverBase: "", token: "", user: null };
  }
}

export async function setSession(patch) {
  const cur = await getSession();
  const next = { ...cur, ...(patch || {}) };
  const raw = JSON.stringify(next);

  if (hasOfficeRuntimeStorage()) {
    await OfficeRuntime.storage.setItem(KEY, raw);
  } else {
    localStorage.setItem(KEY, raw);
  }
  return next;
}

export async function clearSession() {
  if (hasOfficeRuntimeStorage()) {
    await OfficeRuntime.storage.removeItem(KEY);
  } else {
    localStorage.removeItem(KEY);
  }
  return { serverBase: "", token: "", user: null };
}
