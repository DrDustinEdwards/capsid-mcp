# Facts lifted out of src/ comments

Rulings, measurements, and refusal reasons that were recorded only in Worker comments and are not already in `capsid/decisions.md`. Line numbers are where the fact lived before this rewrite.

## src/approval.ts

- **:1-5** Module extracted from `routes.ts` so the cookie binding can be driven by a test. A security property asserted only by reading the source next to it is asserted weakly.
- **:9-11** `APPROVAL_MAX_AGE_SECONDS` was one year. Cut to 30 days: the dialog's only distinguishing signal is the redirect URI it prints, and remembering a one-second decision for twelve months is a long tail on a mistake.
- **:14-28** Exact-URI `approvalTag`, audit 2026-09-06 CRITICAL. Previously bound the client's whole redirect set, which stopped a re-registered client id inheriting consent but left a phishing hole: the dialog prints the one requested redirect, while a client may register several. Approve the claude.ai URI it shows, and consent silently covered a second attacker-controlled redirect in the same set. Binding the requested URI: approve A grants nothing for B. Digest is 64 bits of sha256 (`.slice(0, 16)`); the cookie payload is HMAC-signed, so the only attack this must resist is a colliding redirect.

## src/encoding.ts

- **:1-7** Before this module there were three base64url encoders and two hex encoders across `src/github.ts` and `src/routes.ts`. Duplicated crypto-adjacent helpers drift; the copy nobody looked at is the one that mishandles padding or the high byte. Audit 2, F22 and F23.
