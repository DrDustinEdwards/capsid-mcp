# CLAUDE.md - capsid-mcp

Portfolio-wide rules live in Capsid, not here. Read `capsid/conventions.md` first, then `capsid/core.md`. This file holds only what is true of this repo.

## What this is

Capsid: a single-user, Cloudflare-native MCP server serving a consolidated knowledge base from D1 and R2, reaching the GitHub repos directly. The memory and CMS layer for the whole portfolio. Live at https://capsid.dustin-edwards.workers.dev/mcp. Single-user per deployment by design; multi-tenant is out of scope.

Capsid documents itself. `capsid/schema.md` is the knowledge model and working rules, `capsid/conventions.md` is the portfolio canon, `capsid/decisions.md` is the ruling history. Read those before trusting any description of this system, including this file.

## Session ritual

Start: read `capsid/conventions.md`, then `capsid/core.md`.
End: write a `session-YYYY-MM-DD.md` episodic (type `episodic`, under ~2KB) to the capsid namespace.

## Stack

- Cloudflare Worker (TypeScript), stateless MCP over Streamable HTTP via createMcpHandler from the Agents SDK.
- workers-oauth-provider wraps the MCP handler: OAuth 2.1 with PKCE, dynamic client registration, tokens in KV.
- Two separate GitHub credentials, both required: a GitHub OAuth App for login (locked to one admin account), and a GitHub App (capsid-repo-access) for repo access, minting short-lived RS256 installation tokens signed with Web Crypto and cached in KV. No long-lived token is stored.
- D1 (binding DB): documents, namespaces, document_versions, audit_log, plus a documents_fts FTS5 virtual table kept in sync by triggers.
- R2 (MEDIA) for media and backups. KV (APP_KV) for app state, OAUTH_KV for tokens.
- Cron trigger `0 9 * * *` for the daily backup.

## Hard rules

1. Keep the worker lean. Few tools, no dead code, no speculative abstractions. The tool surface is deliberately small (24 tools) and should stay that way. The last additions were `history` and `restore` (2026-08-13, Grok audit response, item M1): every overwrite and delete had snapshotted the prior row into document_versions since the first migration and nothing could read one back without raw SQL, so a recovery meant a hand-written D1 query and recova/parity/INVENTORY-SEED.md sat unrestored for that reason. Ruled a deliberate exception to this rule rather than a loosening of it: a write path whose safety net is unreachable is a safety net nobody uses. Before those, the ontology and session layer: `backlinks` (typed edges from document_links), `brief` (one-call session start), and `ci_status` (CI runs via the GitHub App).
2. The operator key is stored only as a sha256 hash in a Worker secret (OPERATOR_KEY_HASH). Never commit wrangler.jsonc, .dev.vars, or .env.
3. No real vault content in any seed or fixture. Sample data must be obviously fake (example.com, lorem-style bodies, namespace "sample").
4. The lint loop never calls an LLM from the Worker. The driving client does all reasoning with ordinary read and write tools. Gather is read-only; finalize archives, never deletes.
5. Every overwrite and delete snapshots the prior row into document_versions and appends to audit_log. Do not add a write path that skips this. **Guarded since 2026-08-13, both halves:** `test/invariants.test.ts` reads the source (every registerTool handler containing INSERT/UPDATE/DELETE must also contain `if (!operator)`, and write/delete/restore must contain both statements), and `test/write-invariants.test.ts` DRIVES the real handlers over an in-memory MCP connection against a fake D1 and asserts the statements are actually issued. Both were verified by planting the regression and watching them go red.
6. Writes normalize wide dashes to ASCII server-side. This is the enforcement layer for the portfolio em dash rule; no client can store an em dash. Keep it that way. Note the scope: only DOCUMENT writes to D1 are normalized. Repo writes (write_repo_file) pass content through verbatim, which is how em dashes reached foxhound's docs/canon copies. **One deliberate exception, 2026-08-13:** `mode: "meta"` does NOT normalize, because it does not touch the body. Its contract is that the stored body stays byte-identical, and running the normalizer over an untouched body would silently rewrite pre-normalizer prose that a caller never submitted.
7. A path mutation goes through `pathMutation()` and nowhere else, and a mutating batch carries its own existence predicate. The predicate is an INSERT that violates NOT NULL unless the row is there, guarded by NOT EXISTS, so a 0-row move, delete or finalize aborts the transaction instead of reporting success. It exists because the pre-read and the batch are separate transactions, and because D1's `meta.changes` is inflated by the FTS5 triggers and cannot be used to count what a batch did.

## Auth model

Two parallel gated paths.
- OAuth on `/mcp` for human clients (claude.ai, Inspector). GitHub login checked against ADMIN_GITHUB_LOGIN on every request. An admitted admin holds a full write grant, so claude.ai sessions can perform operator-gated writes.
- Operator keys on `/ops/mcp` for agents and cron. OPERATOR_KEY_HASH holds one or more comma-separated sha256 hashes; a plain entry is a write key, an entry prefixed `ro:` is read-only (writes, delete, move, restore, register_namespace, repo writes, and lint finalize are denied). Revoke by removing a hash.
- One read tool is partially gated: `ci_status` returns run metadata to a read-only key but withholds the failing job's LOG TAIL, because a build log carries whatever the workflow echoed. The list is the verdict an `ro:` key needs; the raw logs of every repo in the portfolio are a wider grant. Ruled 2026-08-13.
- `/ops/backup` requires a write-grant key specifically. Read-only keys get a 401.

## Backups and restore

D1 Time Travel already gives 30-day point-in-time recovery; backups are for longer retention and portability. The daily cron writes `backups/json/<timestamp>.json` (full dump of all FIVE real tables) and a `backups/markdown/` mirror of every document body. After each export it prunes document_versions past 90 days, audit_log past 180, and `reports/csp/` past 30.

**The retention claim, corrected 2026-08-13 (audit item M2).** This file used to say "pruned rows always exist in a retained dump" while dumps were kept 14 at a time. The export does run before the prune, so a row leaving D1 is in that day's dump, but that dump was then deleted after 14 more days and the row existed nowhere: not in D1, not in R2. The two prune horizons had been compared against each other (90 versus 180) when the number that decided the guarantee was the dump shelf life.

The mechanism now: **dumps are pruned by AGE at 90 days, not by count** (`JSON_RETENTION_DAYS`, with `JSON_MIN_KEPT` = 14 as a floor so a stopped cron cannot age out the last copies). So the true statement is: **a pruned row is recoverable from the R2 dumps for 90 days after it leaves D1**, which holds for both history tables regardless of their own horizons. By age rather than count because a count is only a duration if there is exactly one dump per day, and a hand-run `/ops/backup` used to consume one of the 14 slots.

Restore gotcha: `wrangler d1 export` fails outright on this database because of the FTS5 virtual table. Export the five real tables individually with `--no-schema --table`, take the schema from the migration, and import documents first so the FTS triggers rebuild the index. The cron is unaffected because it dumps each table with its own SELECT.

## Known constraints and the current defect list

- claude.ai's connector UI is OAuth-only. No static bearer tokens, no API keys, no custom headers. That is why the OAuth layer exists at all.
- MCP tool lists are cached at connect time. Tools deployed after a session connected will not appear until the connector is reconnected or a new chat starts.
- `search_code` walks the repo tree and greps blobs server-side rather than calling GitHub's code-search API, which returns empty 200s for these private repos over an App installation token (verified 2026-07-17). Scope large repos with `path_prefix`; it refuses trees over 5,000 blobs.
- Repo tools take an optional `repo` argument (a label like "primary"/"legacy" or a mapped "owner/name") to address multi-repo namespaces (recova -> foxhound primary + recova legacy). Omit it for the primary repo. An unmapped selector is rejected with the valid values; the namespace mapping is the authorization boundary. Repo writes are audit-logged with the resolved repo.
- `register_namespace` creates a namespace; `update_namespace` remaps an existing one's repos (operator-gated, audit-logged, snapshots the prior mapping). Both now enforce the same single-primary rule, unified 2026-08-13: it had been on the update path only, so register could create a mapping that update would then refuse to fix. Neither renames a namespace: a rename touches document keys, versions, and audit history and is a separate task.
- A namespace must EXIST before a document can go in it. `write`, `delete`, `move` and `restore` refuse a namespace with no `namespaces` row (2026-08-13, audit item M6) and point at `register_namespace`. Writing to a label never created one, so a typo used to open a shadow namespace: invisible to the namespaces list, uncounted by the lint loop, unreachable by every repo tool. Zero existed when this landed, which is why it closes a hole rather than cleaning one up.
- `write` takes an optional `if_match`: the sha256 of the body the caller believes is stored, which is the value every write already returns. A mismatch refuses the write and reports the current sha, so a concurrent edit cannot be lost silently. Opt-in, and `append` needs it least because it cannot clobber anything.
- `history` lists or fetches document_versions snapshots by namespace and path; `restore` writes one back through the normal write path, so a restore snapshots the current body first and is itself undoable. A version row carries title and body ONLY. Type, status and tags changes are recorded in `audit_log` params instead (`prior_meta`), which is a recorded ruling: the snapshot schema stays title plus body.
- `search_code`'s `max_files` and `max_results` are capped at 200 server-side, matching `ci_status`'s limit. The schema said "positive", and each scanned file costs one GitHub request against the App installation's shared quota.
- `/csp-report` requires `application/csp-report` or `application/reports+json` and a body that parses AND looks like a report; anything else is 415 or 400. It is an unauthenticated public write path into R2, so what it accepts is its defence. **Still open, and a dashboard task for Dustin, not a code change: a WAF rate-limiting rule on that path.** Nothing in the Worker bounds how many requests arrive.
- `/health` probes the store: `SELECT 1` plus an FTS MATCH pinned to `capsid/conventions.md`, returning 503 and `status: "degraded"` if either fails. Bindings resolve by name at deploy time, so a Worker pointed at nothing starts fine and answers ok while every read tool errors. `verify:live` gate 1b asserts it.
- `delete_repo_file` removes a repo file (PR or direct mode), so deprecating a file no longer means leaving a stub.
- `manage_pr` merges or closes a PR from Capsid, so claude.ai can now land a PR without the hosted GitHub connector (which 404s on private repos). Merging can trigger CI deploys (foxhound), so prefer PR mode plus `manage_pr` for anything touching live behavior, and gate by blast radius.
- New tools require a connector reconnect or a new chat to appear: MCP tool lists cache at connect time (see the constraint above).
- The lint loop has three truth-lint checks beyond consolidation (contradiction, artifact binding, infra binding) that catch doc-vs-reality drift. They keep the Worker-serves-data / client-judges split; infra binding runs against the Cloudflare MCP tools because the Worker holds no Cloudflare API token. Detail: capsid/concept-truth-lints.md.
- MCP spec 2026-07-28 readiness (audited 2026-07-18): the SDK has NOT shipped the breaking changes yet. Installed `@modelcontextprotocol/sdk` 1.29.0 is the latest on npm (released 2026-03-30; no `next`/`beta` dist-tag carries the new spec), and `agents` 0.17.4 is a patch. Do not adapt the handler against an unreleased spec. When the SDK ships the update, the change list is:
  - Stateless core: already satisfied. `createMcpHandler` is stateless and holds no per-session state; no change expected.
  - Multi Round-Trip Requests replace server-initiated elicitation: `confirmDestructive` (src/server.ts) calls `server.elicitInput` for overwrite/delete confirmation. When server-initiated elicitation is dropped, remove that call; the existing `confirm: true` fallback already lands the same confirmation without a server-initiated request, so behavior is preserved.
  - Auth hardening: OAuth 2.1 + PKCE + DCR via `workers-oauth-provider` ^0.8.1, with operator keys as a separate bearer scheme on `/ops/mcp`. Re-review token audience and resource-indicator handling against the hardened spec when the provider updates.
  - Sampling deprecated: not used. The worker makes no MCP sampling calls (the lint loop does all reasoning client-side), so no change.
  Waiting on: a `@modelcontextprotocol/sdk` release above 1.29.0 that implements the 2026-07-28 spec.

## Commands

- `npm test` - node --test (test/auth.test.ts, test/normalize.test.ts). Not vitest.
- `npm run check` - tsc --noEmit. Run before every push.
- `npm run dev` - wrangler dev.
- `npm run deploy` - wrangler deploy.
- `npx wrangler secret put KEY` - set a secret. Never commit one.
