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

## src/store-guards.ts

- **:8-19** Guard is a statement, not an `if`: the pre-read is a different transaction and the row can go between them (move answered "moved" and delete answered "deleted" over missing documents). `meta.changes` is inflated by FTS5 triggers (measured 2026-08-10: one repointed edge reported as five). Mechanism: INSERT that violates NOT NULL, guarded by NOT EXISTS; SQLite has no RAISE outside a trigger body.
- **:38-51** `if_match` used to be a pre-read; the window includes the 90-second overwrite confirmation. Body equality rather than a stored sha column (a second source of truth that drifts). `IS` rather than `=` because a NULL body is legitimate and `body = NULL` is never true.
- **:67-70** Create-path guard fires when the row DOES exist, so a racing create aborts instead of falling into ON CONFLICT and overwriting a body that was never snapshotted.
- **:86-102** Four-step commit protocol, order load-bearing. Copies had drifted on step 2's consent condition. Unguarded update keeps last-writer-wins on purpose: requiring `if_match` everywhere would refuse every legitimate rapid edit and break append.

## src/write-modes.ts

- **:1-14** Before modes, appending one line to a 32KB decisions.md meant retranscribing 32KB. Fired twice on 2026-08-07. conventions.md answered with a hand-run SQL splice. Every mode returns the full new body; a second write path is how "always snapshot" gets skipped.
- **:30-45** Wire type stays loose so a client sending `mode:'meta'` plus `body` is refused rather than silently ignored (quality audit 3.1). The union is what assembly sees.
- **:54-58** Error precedence is load-bearing: replace is checked before existence, so creating a document reports the missing title rather than "cannot replace a document that does not exist".
- **:76-82** `meta` is not a convenience: without it, closing a task or correcting a type means resupplying the entire body.
- **:153-160** Spliced by index, not `String.replace` (audit 2, F19). `replace()` with a string pattern still interprets `$&`, `$\``, `$'`, `$$` in the replacement. Two plants on 2026-08-11 were defeated by CRLF vs LF on the patch anchor.

## src/headers.ts

- **:1-25** Headers applied once at the outermost exit because workers-oauth-provider generates `/token`, `/register`, and both `.well-known` documents, none of which appear in this repo. Measured 2026-08-12: consent page carried 4 of 7 headers; every JSON surface carried none. Set only if absent, so the consent dialog's hand-tuned CSP (no `form-action`, ruling e7a0dff) is preserved.
- **:29-32** HSTS has no `preload`: that is a vendor-list submission and effectively irreversible.
- **:41-46** `REPORT_PREFIX` was two literals (audit 2, F21); intake and prune have to agree.
- **:49-60** CSP Report-Only, never enforced. Promotion requires a demonstrated failing case and a ruling. 423bbd6 skipped that and broke consent for 26 days. `form-action` is deliberately absent even on JSON: naming it in a policy that could later be promoted is how the last outage started.
- **:64-67** COOP Report-Only on HTML: `same-origin` severs `window.opener`; if a client hosts consent in a popup that is a live OAuth change. Ruled 2026-08-12.
- **:70-77** `/mcp` Origin allowlist (audit 2026-09-06): no Origin passes, same-origin passes, `https://claude.ai` passes. Opaque `"null"` is refused. Spec says servers MUST validate Origin.

## src/rate-limit.ts

- **:8-15** No WAF half: Cloudflare rate limiting rules are a zone feature and do not apply to `*.workers.dev`. Capsid deploys with no routes and no custom domain. Named `dcr-rate-limit.ts` until 2026-08-17.
- **:35-41** `/register` thresholds measured 2026-08-09: claude.ai legitimately registered 22 clients from one IP in about two hours during the OAuth consent outage. A "10 per hour" limit would have locked the owner out mid-incident. Hourly 30, daily 100.
- **:52-63** At most one non-loopback `redirect_uri` per registered client (audit 2026-09-06). Loopback exempt so a native client can cycle ports. Lives here so it is testable without loading the OAuth provider.
- **:95-122** `/csp-report` measured 2026-08-17: 47 reports, all synthetic, zero real browser violations (policy is Report-Only). 300/hour is an aggressive debugging session, not a fit to the measured burst of 3. Per-IP does nothing about a distributed flood.
- **:156-168** Fails open: the thing guarded is the owner's ability to reconnect. KV is not atomic; the count can undershoot; not worth a Durable Object.
- **:232-246** 429, not 204: a dropped report must not look stored. Browsers never read the status; curl, the live gate, and a future monitor do.

## src/index.ts

- **:39-53** Cache-Control fail-closed at the outermost exit so it covers everything workers-oauth-provider generates. Consent page shipped with no cache directive (measured 2026-08-09). `/health` is the sole opt-out.
- **:65-82** `clientRegistrationTTL` is set to the library default rather than left to it, so a patch bump cannot make clients never expire. Measured 2026-08-13: all 30 live registrations carry expiry of registrationDate plus 90 days; 22 of 24 named Claude were written in a two-hour window on 2026-08-09. TASK-capsid-audit-2026-08-09.md's "carry no TTL / 1,460 dead keys a year" was wrong.
- **:85-92** DCR callback gets no env; provider is constructed at module scope. `currentEnv` stash is idempotent (every request in an isolate gets the same env object). Unset skips the limiter (fail-open).
- **:95-100** `CANONICAL_MCP_URL` pinned as `resourceMetadata.resource` so every access-token audience is bound (RFC 8707 / RFC 9728). A token minted with no `resource` is otherwise admitted unbound (2026-09-06 MAJOR).
- **:162-180** Three crons dispatched on `controller.cron`, not the clock: 09:00 UTC matches all three expressions and Cloudflare delivers once per expression. Improve opener is two UTC hours because 03:00 America/Chicago is 08:00 or 09:00 depending on DST. Each branch is its own try.

## src/improve-select.ts

- **:1-13** Branching from current best every time is hill climbing. A base is chosen on score and on descendant performance (lineage potential).
- **:41-46** Laplace smoothing `(wins+1)/(total+2)`: without it a base with one kept descendant has potential 1.0 and outranks 9/10. With it those are 0.67 and 0.83. An unexplored base is 0.5, not known-bad.
- **:74-88** Score and potential are combined, not ranked lexicographically. `tanh` squash rather than min-max over the candidate set: min-max manufactures a 1.0 vs 0.0 gap out of noise when every attempt scored about the same. Ties break toward the later (more recent) candidate.

## src/tool-annotations.ts

- **:1-31** Annotations are a cache; `test/tool-annotations.test.ts` derives each flag from the handler. `readOnlyHint` is the negation of the write gate. `destructiveHint` is true iff a write-gated handler can overwrite or remove existing state. `idempotentHint` and `openWorldHint` were written and then removed: a "calls github.ts" scan disagreed twice (`register_namespace` / `update_namespace` reach GitHub through `repoTokenOk`; `improve_run` reads as closed-world while dispatching a workflow). A hint nothing checks is the kind of claim this file exists to stop. `write` is destructive because one tool gets one hint and replace/patch overwrite. `lint` is destructive because finalize archives. `ci_dispatch` is additive (the workflow's later work is not this tool's). Fail-closed on a missing table entry: under-claimed, not over-claimed. `Object.hasOwn` because `"constructor"` is not nullish (measured 2026-09-06).

## src/improve-skills.ts

- **:1-14** A kept attempt's specific diff is worthless elsewhere; the reason it worked might not be. A skill is a candidate, not an instruction: it goes through the identical attempt path, so a skill that does not transfer is reverted. Wins and losses accumulate per skill so "does cross-project transfer work" is answerable. Candidate order is Laplace-smoothed win rate; a skill sourced from this namespace is excluded.

## src/improve-attempt.ts

- **:1-16** This module takes `AttemptEnv`, not `Env`. The CI runner reads holdout with its own read-only R2 token held as a repo secret, never in this Worker's environment.
- **:23-27** Whole files rather than a patch: a unified diff that fails to apply has no recovery inside a cron job.
- **:99-104** Repository context is the cached prefix, passed separately. It used to be last in the user message, after history, so every attempt busted the prefix cache.
- **:165-192** One contents-API commit per file: building a multi-file commit means constructing a tree by hand, which is a second write path. `writeRepoFile` direct mode falls back to the default branch if no branch is passed; on capsid that is this server's master, so a dropped branch is a production deploy. Precondition, not a second path. Audit 2026-09-07.

## src/improve-gates.ts

- **:1-12** Monitor reverts one attempt; drift gate stops the namespace. Both written so the expensive half can be absent. A loop whose safety depends on an API call is unsafe exactly when that API is down.
- **:31-33** Schema rather than "reply with JSON": a monitor whose output cannot be read is a monitor that fails open.
- **:63-68** Deterministic path half runs first and cannot be argued with.
- **:122-124** Fail closed: a monitor that cannot run does not approve.
- **:173-181** Drift uses last three runs, not last one. A window with no attempts does not pause (zero/zero would stop every namespace on the first three nights).
- **:214-220** An anchor drop pauses immediately. Per-attempt only asks whether the anchor still PASSES, so 1.0 to 0.95 against a floor of 0.9 is invisible to it.

## src/improve-schema.ts

- **:15-36** Roster is a closed list. foxhound question resolved 2026-09-05 by renaming the `recova` namespace; the loop targets the primary repo. Legacy recova is hotfix-only.
- **:50-53** Default mode is off: unset, unreadable, or unrecognised all resolve to off.
- **:68-86** Subscription-mode driver lease (residual 9, 2026-09-08). API mode is covered by a partial unique index; subscription creates no run row, so two `/improve` sessions would both push. KV has no CAS. TTL six hours.
- **:90-97** Budget kill switch (2026-09-06): Cloudflare budget alerts cannot stop a Worker. Missing KV falls back to defaults, never to no cap.
- **:130-134** Worker reads holdout COUNT, never the tests. A report claiming 3 passed when the manifest says 11 exist is refused.
- **:144-167** `improve/run-` is what `/improve` executes (2026-09-07 lethal trifecta). Meta-loop may write only under `improve/proposals/`. Ordinary `write` refuses prompts/skills/scores anchors unless `allow_improve_paths`.
- **:173-178** `SCORER_WORKFLOW` lives here not in improve-scorer because `ci_dispatch` refuses it by name (a hand dispatch mints a genuinely signed report) and importing from improve-scorer would cycle.
- **:200-212** `RUN_CONDITIONS` is TEXT with no CHECK; each value has to switch something real off.
- **:243-251** `SCORE_TIMEOUT_MS` is a ceiling against a 2-4 minute CI job, not a measured p99. `RUN_MAX_AGE_MS` 6h so a crawling run does not hold the slot when the next opener fires.
- **:304-318** wrangler `.example` is included because foxing Job A copies it into place (2026-09-07 Opus CRITICAL 5.2). Every lockfile, not just npm: scorer install is package-manager agnostic; `--frozen-lockfile` compares lockfile to package.json; npm prefers shrinkwrap over package-lock.
- **:350-354** Protected-path list is served to the subscription driver, which cannot import a RegExp. `test/improve-driver-lock.test.ts` derives both directions.
- **:316-318** `en-US` with `hour12: false` renders midnight as "24" in some ICU versions and "00" in others; `% 24` keeps the opener from firing on a day boundary in one runtime and not another.

## src/backup.ts

- **:12-28** Overlap lock (audit 2, F32). Cron and POST /ops/backup can overlap dump+prune. KV has no CAS, so the lease is best-effort, not a lock. TTL 15 minutes (scheduled invocation wall-time ceiling; KV min expirationTtl is 60s).
- **:32-54** Retention: export before prune. Dumps were kept 14 by count, so a row pruned at 90 days was recoverable from R2 for 14 more days then existed nowhere. Now pruned by age at 90 days. A count is only a duration if there is exactly one dump per day; /ops/backup by hand used to consume a slot.

## src/improve-run.ts

- **:1-29** Resumable D1 state machine, one step per tick, idempotent on expected status. Baseline scoring job exists so the first attempt has something to compare against and so metrics that move on their own are not attributed to attempt 1.
- **:1709-1743** Dry run uses the same resolver as the real path and resolves the base for real (it used to pass null and report "no base could be resolved" on every namespace). Fails soft to null.

## src/improve-anthropic.ts

- **:1-24** Official SDK, not fetch: thinking config, effort, fallback beta, structured outputs move. No Batch API: attempts are strictly sequential (N+1 branches from N's outcome); skill triage is already one request scoring N skills. A model whose price is not listed is costed at the highest rate, not zero.
- **:30-36** `ModelEnv = Pick<Env, "ANTHROPIC_API_KEY">` so `improve-attempt.ts` can call without a cast that would erase AttemptEnv.

## src/improve-meta.ts

- **:1-15** Meta-loop cannot edit the run prompt, scores, holdout, anchors, or gates. Entire write surface is `capsid/improve/proposals/`. A system that can edit its own objective has no objective. `assertProposalTarget` plus `test/improve-meta.test.ts`.

## src/improve-scorer.ts

- **:1-22** Only module in src/ that may name HOLDOUT besides env.ts's declaration. Worker cannot be the scorer: no process to spawn. Worker holds the manifest COUNT, never the tests; a report claiming fewer than the manifest is refused. SCORE_PATH is not under /ops/: an operator-key check there would hand five repos a key that can write every document.

## src/improve-scores.ts

- **:1-24** Referee; no model. Anchors are checksummed and may never be edited or regressed by the loop. Secondary is the optimisation surface and may be reweighted without breaking the pin. Checksum covers the anchor section, not the whole file: covering the file would refuse every legitimate secondary-weight edit at 03:00.

## src/improve-state.ts

- **:1-17** Every transition is `UPDATE ... WHERE status = <expected> RETURNING id`, not `meta.changes`. These tables have no FTS triggers so meta.changes would be honest here; RETURNING is used anyway so the rule does not depend on remembering which tables have triggers.
