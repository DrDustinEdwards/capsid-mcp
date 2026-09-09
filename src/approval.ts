import { sha256Hex } from "./auth";

// 30 days. Consent is a one-second decision on a dialog that prints one redirect.
export const APPROVAL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// clientId plus 16 hex of sha256 of the requested redirect, not the whole set.
// 64 bits is integrity, not a secret: the cookie is HMAC-signed.
export async function approvalTag(clientId: string, redirectUri: string | undefined): Promise<string> {
  return `${clientId}.${(await sha256Hex(redirectUri ?? "")).slice(0, 16)}`;
}
