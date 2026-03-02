export function ensureMsgPolicyDefaults(msg) {
  msg.policy = msg.policy || {};
  if (msg.policy.expiresAt === undefined) msg.policy.expiresAt = null; // ISO string or null
  if (msg.policy.maxViews === undefined) msg.policy.maxViews = 0; // 0 = unlimited
  if (msg.policy.revokedAt === undefined) msg.policy.revokedAt = null;
  if (msg.views === undefined) msg.views = 0;
}

export function policyCheckOrThrow(msg) {
  ensureMsgPolicyDefaults(msg);

  if (msg.policy.revokedAt) {
    const err = new Error("Link revoked");
    err.code = "revoked";
    throw err;
  }

  if (msg.policy.expiresAt && Date.parse(msg.policy.expiresAt) < Date.now()) {
    const err = new Error("Link expired");
    err.code = "expired";
    throw err;
  }

  if (msg.policy.maxViews > 0 && msg.views >= msg.policy.maxViews) {
    const err = new Error("View limit reached");
    err.code = "max_views";
    throw err;
  }
}
