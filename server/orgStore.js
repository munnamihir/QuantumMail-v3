// server/orgStore.js
import { pool } from "./db.js";

function canonicalOrgJson(x) {
  let o = x;

  // if this is a db row shape: { org_id, data, updated_at }
  if (o && o.data && !o.orgId && (o.org_id || o.orgId === undefined)) {
    o = o.data;
  }

  // unwrap repeated { data: { data: {...}} } nesting (yours has this)
  for (let i = 0; i < 10; i++) {
    if (o && typeof o === "object" && o.data && typeof o.data === "object") {
      // only unwrap if this layer doesn't already look like an org
      if (!Array.isArray(o.users) && !o.orgId) o = o.data;
      else break;
    } else break;
  }

  return o;
}

export async function peekOrg(orgId) {
  const { rows } = await pool.query(
    `select data from qm_org_store where org_id=$1 limit 1`,
    [orgId]
  );
  if (!rows.length) return null;
  return canonicalOrgJson(rows[0].data);
}

export async function getOrg(orgId) {
  const { rows } = await pool.query(
    `select data from qm_org_store where org_id=$1 limit 1`,
    [orgId]
  );
  if (!rows.length) {
    // create empty org if missing (optional)
    const org = { orgId, users: [], audit: [], createdAt: new Date().toISOString() };
    await pool.query(
      `insert into qm_org_store (org_id, data, updated_at) values ($1,$2::jsonb, now())`,
      [orgId, JSON.stringify(org)]
    );
    return org;
  }
  return canonicalOrgJson(rows[0].data);
}

export async function saveOrg(orgId, org) {
  const canonical = canonicalOrgJson(org);
  await pool.query(
    `insert into qm_org_store (org_id, data, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (org_id) do update set data = excluded.data, updated_at = now()`,
    [orgId, JSON.stringify(canonical)]
  );
}
