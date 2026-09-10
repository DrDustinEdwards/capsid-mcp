import { bytesToHex } from "./encoding";

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

// HMAC-SHA256, hex. One definition; routes.ts used to have its own copy.
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

// Constant-time compare of equal-length strings. The length check leaks length only.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// OPERATOR_KEY_HASH: comma-separated sha256 hex. Plain = write, "ro:" = read.
// Revoke by removing a hash. A single unprefixed hash still parses as write.
export type OperatorGrant = "write" | "read" | null;

// Fingerprint is 12 hex of the presented key's sha256, not the stored verifier.
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

export function isAdminUser(
  env: { ADMIN_GITHUB_LOGIN?: string },
  user: { id: number | string; login: string }
): boolean {
  const admin = (env.ADMIN_GITHUB_LOGIN ?? "").trim();
  if (!admin) return false;
  if (/^\d+$/.test(admin)) return String(user.id) === admin;
  return user.login.toLowerCase() === admin.toLowerCase();
}
