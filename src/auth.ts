// Auth helpers shared by the OAuth and operator-key surfaces. Kept free of MCP
// and Worker imports so the grant logic is unit-testable under node.

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// OPERATOR_KEY_HASH holds one or more comma-separated sha256 hex hashes.
// A plain entry admits a full (write) operator; an entry prefixed "ro:" admits
// a read-only client, which exercises the operator=false path on every gated
// tool. Revoke a key by removing its hash; the other keys keep working. The
// original single-hash secret still parses as one write entry.
export type OperatorGrant = "write" | "read" | null;

export async function operatorGrant(
  request: Request,
  env: { OPERATOR_KEY_HASH?: string }
): Promise<OperatorGrant> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ") || !env.OPERATOR_KEY_HASH) return null;
  const hash = await sha256Hex(auth.slice("Bearer ".length).trim());
  for (const raw of env.OPERATOR_KEY_HASH.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const readonly = entry.startsWith("ro:");
    if ((readonly ? entry.slice(3) : entry) === hash) return readonly ? "read" : "write";
  }
  return null;
}

export function isAdminUser(
  env: { ADMIN_GITHUB_LOGIN?: string },
  user: { id: number | string; login: string }
): boolean {
  const admin = (env.ADMIN_GITHUB_LOGIN ?? "").trim();
  if (!admin) return false;
  if (/^\d+$/.test(admin)) return String(user.id) === admin;
  return user.login.toLowerCase() === admin.toLowerCase();
}
