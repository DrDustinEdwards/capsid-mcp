// What the consent approval cookie actually records (audit 2, F2).
//
// Pulled out of github-handler.ts so the binding can be driven directly by a test.
// It is the security property of the cookie, and a security property asserted only
// by reading the source next to it is asserted weakly.

import { sha256Hex } from "./auth";

// 30 days, down from a year. A consent decision is made in one second on a dialog
// whose only distinguishing signal is the redirect URI it prints; remembering it for
// twelve months is a long tail on a mistake nobody will remember making.
export const APPROVAL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// An approval entry is the client id PLUS a digest of that client's redirect set.
//
// The id alone was not enough. Dynamic registration is open, so a client id is a
// handle anyone can obtain and a registration can be replaced; an approval keyed on
// the id carried over to a different client that had re-registered the same display
// name pointing somewhere else. Bind the redirects and that stops: change them, and
// the consent dialog comes back showing the new one.
//
// Sorted, so the same set in a different order is the same approval. 64 bits of the
// digest, because this is an integrity binding rather than a secret, the whole
// payload is HMAC signed, and the only attack it must resist is an attacker
// choosing their own redirects to collide with an approved set.
export async function approvalTag(clientId: string, redirectUris: string[] | undefined): Promise<string> {
  const canonical = [...(redirectUris ?? [])].sort().join(" ");
  return `${clientId}.${(await sha256Hex(canonical)).slice(0, 16)}`;
}
