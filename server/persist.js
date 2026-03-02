import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FILE = path.join(__dirname, "data.json");

function mapToObj(map) {
  const obj = {};
  for (const [k, v] of map.entries()) obj[k] = v;
  return obj;
}

function objToMap(obj) {
  const m = new Map();
  if (!obj || typeof obj !== "object") return m;
  for (const k of Object.keys(obj)) m.set(k, obj[k]);
  return m;
}

export function loadDbOrDefault(defaultDb) {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultDb;

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      orgs: objToMap(parsed.orgs),
      users: objToMap(parsed.users),
      keys: objToMap(parsed.keys),
      messages: objToMap(parsed.messages),
      audit: Array.isArray(parsed.audit) ? parsed.audit : []
    };
  } catch (e) {
    console.error("⚠️ Failed to load data.json, starting fresh:", e?.message || e);
    return defaultDb;
  }
}

let saveTimer = null;

export function scheduleSaveDb(db) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const payload = {
        orgs: mapToObj(db.orgs),
        users: mapToObj(db.users),
        keys: mapToObj(db.keys),
        messages: mapToObj(db.messages),
        audit: db.audit || []
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), "utf8");
    } catch (e) {
      console.error("❌ Failed to save data.json:", e?.message || e);
    }
  }, 150);
}

export function dataFilePath() {
  return DATA_FILE;
}
