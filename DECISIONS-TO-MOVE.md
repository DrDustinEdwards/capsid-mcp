# Facts lifted out of src/ comments

Rulings, measurements, and refusal reasons that were recorded only in Worker comments and are not already in `capsid/decisions.md`. Line numbers are where the fact lived before this rewrite.

## src/approval.ts

- **:1-5** Module extracted from `routes.ts` so the cookie binding can be driven by a test. A security property asserted only by reading the source next to it is asserted weakly.
- **:9-11** `APPROVAL_MAX_AGE_SECONDS` was one year. Cut to 30 days: the dialog's only distinguishing signal is the redirect URI it prints, and remembering a one-second decision for twelve months is a long tail on a mistake.
- **:14-28** Exact-URI `approvalTag`, audit 2026-09-06 CRITICAL. Previously bound the client's whole redirect set, which stopped a re-registered client id inheriting consent but left a phishing hole: the dialog prints the one requested redirect, while a client may register several. Approve the claude.ai URI it shows, and consent silently covered a second attacker-controlled redirect in the same set. Binding the requested URI: approve A grants nothing for B. Digest is 64 bits of sha256 (`.slice(0, 16)`); the cookie payload is HMAC-signed, so the only attack this must resist is a colliding redirect.

## src/encoding.ts

- **:1-7** Before this module there were three base64url encoders and two hex encoders across `src/github.ts` and `src/routes.ts`. Duplicated crypto-adjacent helpers drift; the copy nobody looked at is the one that mishandles padding or the high byte. Audit 2, F22 and F23.

## src/store-probe.ts

- **:1-13** One FTS probe, two callers (`/health` and backup preflight) must share the definition so they cannot drift. Why MATCH pinned to `capsid/conventions.md` rather than a count, measured 2026-07-27: `DELETE FROM documents_fts` corrupts the index, `COUNT(*)` on an external-content FTS5 table reads through to the content table so it cannot detect drift, and `integrity-check` passes on an emptied index. A MATCH that has to find a specific row is the cheap check that fails when the index is empty.

## src/normalize.ts

- **:31-40** `hasWideDash` was moved to `test/` on 2026-09-07 as an export with no caller in `src/` or `test/`. The holdout suite imports it; with this and `seedScoresDoc` removed the holdout scored 28/30, restoring both took it to 30/30 against an anchor of min 1.0 (2026-09-08). "No caller in src/ or test/" is not dead in this repo. An export removal is checked by scoring a branch, not by grepping.

## src/doc-meta.ts

- **:1-11** Types `session` and `handoff` were invisible to gather and to the counts, which is why the type list is validated at write. Then 22 recova episodics stored as status `active` went invisible the same way, because unconsolidated count and gather filtered on `status = 'published'`. Those queries are archive-path-only now: the `archive/` prefix is the only thing that takes a doc out of the lint loop.
- **:18-30** Status `closed` added 2026-08-12 (batch-two item 5). Task closure had been unrepresentable, so it was written into bodies as prose and brief returned every non-archived task forever. Ruled a status value rather than a new column; TEXT column, no CHECK, no migration. Closure is going-forward only: backfilling would invent an editorial judgement about work nobody reviewed.

## src/auth.ts

- **:1-2** Kept free of MCP and Worker imports so the grant logic is unit-testable under node.
- **:10-17** `hmacHex` lived privately in `src/routes.ts` until the improve arc. Moved rather than copied; routes.ts imports it and its call sites are unchanged, which is what keeps the `timingSafeEqual` guards in `test/source-conventions.test.ts` matching.
- **:30-39** Constant-time compare, audit 2 F1. Practical risk of short-circuiting `===` over TLS to a Cloudflare edge was low; the reason to fix it anyway is that "low risk" has to be re-made every time someone reads the line. Length check leaks length only (constant for a digest).
- **:54-61** Fingerprint is a prefix, not the whole digest: the full digest is the stored `OPERATOR_KEY_HASH` verifier, so writing it into `audit_log` would copy the verifier into the database the audit log is meant to hold to account.

## src/health.ts

- **:1-5** Lives in its own module because `src/routes.ts` imports the Agents SDK, which pulls in `cloudflare:workers` and cannot load under `node --test` (same reason `rate-limit.ts` lives apart). Schema version and backup age have branches a source scan cannot check.
- **:7-12** Deploy provenance is stamped at deploy time by `scripts/deploy.mjs`. `dirty=true` means the deployed bytes are not a clean commit. A Worker whose DB binding is missing or pointed at an empty database starts fine and answers `/health` ok while every read tool errors, which is why the store is probed.
- **:14-24** Two store probes fail separately: `d1` is `SELECT 1`; `fts` is a MATCH that must return one pinned document. `schema_version` and `backup` (added 2026-09-07) are informational and do not degrade health: health is whether the store answers. Backup warning threshold is 26h (daily cron plus 2h grace).

## src/improve-task.ts

- **:1-23** Subscription-mode task docs were an ordinary D1 row, so any write-grant key could rewrite them, and `/improve` is instructed to execute the attempts exactly as the task doc describes. Both 2026-09-07 audits rated that the lethal trifecta (Opus 3.1 / 22.1, Grok MAJOR 8). Two independent checks: HMAC of the body below the frontmatter (survives an attacker who can also write audit rows) and last audit actor `improve-loop` (survives a leaked signing key, which still cannot make D1 record a different actor). Unconfigured (`IMPROVE_SCORE_SECRET` unset) is a refusal, not a skip.

## src/links.ts

- **:7-10** `LinkEdge.type` used to be `string` (quality audit 3.5). Derived from the same array the runtime check uses.
- **:23-49** Edge endpoints are document keys, ruled 2026-08-17 (quality audit 3.6). `write` refused `..` while an edge to `../x` stored fine. A comment on the dangling-edge warning offered the looseness as deliberate ("may also address repo files"). Ruled the other way: an edge is `(to_ns, to_path)` and `to_ns` is a namespace, with nowhere to put a repo selector or ref; every consumer JOINs documents; `move` repoints edges on rename. Measured live 2026-08-17: all 96 edges resolve to real documents, zero `..`, zero absolute, zero not `.md`. Behaviour change: a write whose links carry a traversal, absolute path, or over-long path is refused at parse time.

## src/env.ts

- **:1-9** `Env` lived in `src/server.ts` until 2026-08-17 (quality audit 1.3). Every leaf imported the root; the type graph was cyclic even though the runtime graph was not, because the imports were type-only.
- **:34-43** HOLDOUT is a second R2 bucket, not a prefix in MEDIA: attempt code holds MEDIA and would be able to read a prefix inside it. Exactly two modules may name it (this file's declaration and `src/improve-scorer.ts`); `test/improve-holdout.test.ts` pins the two lines rather than granting the filename.
- **:54-64** Score job no longer holds a long-lived S3 key (platform arc 2026-09-06). It POSTs `/improve/holdout-credential`; the Worker mints a one-hour object-read-only credential. Parent token secret never leaves the dashboard. Omitted from AttemptEnv. Only `improve-scorer.ts` may name the token.
- **:68-72** Backup mint parent is a separate R2 token, object-read-only on capsid-media, so neither credential family can read the other bucket.
- **:76-86** AttemptEnv is the type-level half of isolation. Three layers: type, separate bucket, source scan. A type can be cast away, a scan can be evaded by an alias, and a shared bucket defeats both.

## src/counts.ts

- **:1-27** Values are a cache; `test/counts.test.ts` derives them from the artifacts. Keyed by namespace, load-bearing: until 2026-08-14 one global object scanned every namespace, so another project's 24-gate suite was compared against capsid's 9 live gates (16 claims flagged, 14 of them that). A namespace with no entry gets no claims.
- **:44-49** `Object.hasOwn`, not `?? null`. A lookup of `"constructor"` returned the Object function. Found 2026-09-05 by the capsid holdout suite.
- **:54-55** A four-digit year is never a count: `tool surface...(\d+)` matched 2026 in "the 2026-07-28 migration".
- **:58-77** Episodics exempt (history of a run). `decision` exempt, ruled 2026-08-15: an append-only ruling log is history by construction. Three finer exemptions each revealed another false-positive shape.
- **:191-194** `"all seven"` appears in 25 documents and almost none are about headers, so the flag is scoped to header context. COOP ships Report-Only, so "all seven enforced" overstates what is live.

## src/limits.ts

- **:9-15** Bounds measured against the live store on 2026-08-17 (F29). `MAX_BODY` is set from the largest VERSION row, not the largest document, because restore writes a stored snapshot back; a bound under that figure would make the largest snapshots unrestorable.
- **:17-21** No `archive/` write ban: 41% of the live store already sits under that prefix, so a rule against writing there would refuse every future append/patch/meta and refuse restore of a deleted archived document.
- **:51-56** Measured 2026-08-17: 557 documents across 8 namespaces, largest 245. `MAX_ROWS` 500 sits above a namespace and below the whole store.
- **:67-69** `GATHER_BUDGET` 150_000: real packets measured 213KB and 330KB; a warning that fires on the normal case is not a bound. Enforced by trimming.
- **:72-75** `LINT_CONSUMED_MAX` 20 is 81 statements, under D1's 100-statement batch ceiling. Chunking was rejected because a partial archive silently drops documents out of the lint loop.
- **:114-124** Repo path grammar is a whole-segment check, not `includes("..")`, because `a..b` is a legal file name. Closed a real traversal: `encodeURIComponent` leaves `.` and `..` untouched, so `../../other-repo/contents/x` reached fetch() and URL-normalized into an unmapped repo.
