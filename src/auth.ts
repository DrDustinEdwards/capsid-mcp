// Auth helpers shared by the OAuth and operator-key surfaces. Kept free of MCP
// and Worker imports so the grant logic is unit-testable under node.

import { bytesToHex } from "./encoding";

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

// HMAC-SHA256, hex. Lived privately in src/routes.ts until the improve arc needed
// the same primitive for the CI score report signature.
//
// MOVED RATHER THAN COPIED, per the duplication rule in
// capsid/repo-structure.md: two implementations of a signature helper is exactly
// the shape that drifts, and the copy that drifts is the one nobody is looking
// at. routes.ts imports it now and its call sites are unchanged, which is what
// keeps the timingSafeEqual guards in test/source-conventions.test.ts matching.
export async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToHex(sig);
}

// Compare two secrets without leaking where they diverge (audit 2, F1).
//
// Kept small on purpose. Every caller compares a fixed-length hex digest or an
// opaque token over TLS to a Cloudflare edge, so the practical risk of the
// short-circuiting === it replaces was low; the reason to fix it anyway is that
// "low risk" is an argument that has to be re-made every time someone reads the
// line, and a constant-time compare is four lines and needs no argument.
//
// The length check leaks length only, which for a digest is a constant, and for a
// token is not the secret.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// OPERATOR_KEY_HASH holds one or more comma-separated sha256 hex hashes.
// A plain entry admits a full (write) operator; an entry prefixed "ro:" admits
// a read-only client, which exercises the "read" grant path on every gated
// tool. Revoke a key by removing its hash; the other keys keep working. The
// original single-hash secret still parses as one write entry.
export type OperatorGrant = "write" | "read" | null;

// The identity behind an operator-key request: which grant, and WHICH KEY.
//
// The fingerprint is the first 12 hex chars of the presented key's sha256. That
// is enough to tell several keys apart in the audit log (an agent key from the
// cron key from a laptop key) and it is not the key. It is deliberately a
// PREFIX rather than the whole digest: the full digest is the value stored in
// OPERATOR_KEY_HASH, so writing it into audit_log would copy the verifier into
// the database that the audit log is meant to hold to account.
export interface OperatorIdentity {
  grant: OperatorGrant;
  fingerprint: string | null;
}

export async function operatorIdentity(
  request: Request,
  env: { OPERATOR_KEY_HASH?: string }
): Promise<OperatorIdentity> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ") || !env.OPERATOR_KEY_HASH) return { grant: null, fingerprint: null };
  const hash = await sha256Hex(auth.slice("Bearer ".length).trim());
  for (const raw of env.OPERATOR_KEY_HASH.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const readonly = entry.startsWith("ro:");
    if (timingSafeEqual(readonly ? entry.slice(3) : entry, hash)) {
      return { grant: readonly ? "read" : "write", fingerprint: hash.slice(0, 12) };
    }
  }
  return { grant: null, fingerprint: null };
}

export async function operatorGrant(
  request: Request,
  env: { OPERATOR_KEY_HASH?: string }
): Promise<OperatorGrant> {
  return (await operatorIdentity(request, env)).grant;
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
