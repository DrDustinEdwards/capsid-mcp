// What the consent approval cookie actually records (audit 2, F2).
//
// Pulled out of routes.ts so the binding can be driven directly by a test.
// It is the security property of the cookie, and a security property asserted only
// by reading the source next to it is asserted weakly.

import { sha256Hex } from "./auth";

// 30 days, down from a year. A consent decision is made in one second on a dialog
// whose only distinguishing signal is the redirect URI it prints; remembering it for
// twelve months is a long tail on a mistake nobody will remember making.
export const APPROVAL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// An approval entry is the client id PLUS a digest of the EXACT redirect URI the
// consent dialog displayed and the user approved (audit 2026-09-06, CRITICAL).
//
// It used to bind the client's whole redirect SET. That still fixed the first
// problem (a re-registered client id could not inherit consent), but it left a
// phishing hole: the dialog prints only the ONE redirect being requested, while a
// client may register several. Approve it for the claude.ai redirect it shows, and
// consent silently covered a second attacker-controlled redirect in the same set,
// which a later authorize could then use to receive the code. Binding the single
// requested URI closes that: approving redirect A grants nothing for redirect B, so
// a request for B comes back to the dialog.
//
// 64 bits of the digest, because this is an integrity binding rather than a secret:
// the whole payload is HMAC signed, and the only attack it must resist is an
// attacker choosing a redirect that collides with an approved one.
export async function approvalTag(clientId: string, redirectUri: string | undefined): Promise<string> {
  return `${clientId}.${(await sha256Hex(redirectUri ?? "")).slice(0, 16)}`;
}
