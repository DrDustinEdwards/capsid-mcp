# Capsid

Capsid is a control plane for AI agents working across a portfolio of repositories. It gives them structured memory that records who wrote what and when, scoped permissions and an audit trail over every write, a signed work queue for handing a task from a chat to a machine, and a self-improvement loop whose proposed changes are scored against hidden tests. It is a single-user Cloudflare Worker, speaks MCP over Streamable HTTP, and exposes 31 tools in five groups: documents, repo access, maintenance, the work queue, and self-improvement.

The `namespaces` tool reports each namespace's count of unconsolidated episodic/source docs, so any session can see where a lint run is due.

It also exposes the rest of the MCP surface: **Resources** (every document addressable at `capsid://<namespace>/<path>`) and **Prompts** (reusable templates stored as documents).

All access is gated. Human clients (claude.ai, MCP Inspector) authenticate via GitHub OAuth, and only the configured admin GitHub account is admitted. Headless agents and cron use a separate operator-key endpoint. Every write snapshots the prior version into `document_versions` and appends to `audit_log`, so you get history and rollback for free.

## Stack

- Cloudflare Worker (TypeScript), stateless MCP via `createMcpHandler` from the Agents SDK
- [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) wrapping the MCP handler: OAuth 2.1 with PKCE, dynamic client registration, and token storage in KV
- GitHub OAuth App as the identity provider for login, locked to a single admin account
- A separate GitHub App for repo access, minting short-lived installation tokens
- D1 for documents, versions, namespaces, and audit log, with FTS5 full text search
- R2 (`MEDIA` binding) for media, backups and the report sink; a second bucket (`HOLDOUT` binding) holds the self-improvement loop's hidden test suites, bound separately so attempt code cannot reach it
- KV, TWO SEPARATE namespaces: `APP_KV` for the Worker's own caches, and `OAUTH_KV` for the OAuth provider's clients, grants and tokens. They must not be the same namespace (see Clone setup)

## Knowledge model

Documents are typed. The model is Karpathy's LLM Wiki pattern: raw sources compiled into a maintained wiki.

- `core` one always-loaded summary per namespace, read first to orient
- `concept`, `decision`, `note`, `spec`, `task`, `protocol`, `post`, `reference` the compiled knowledge and content
- `episodic` session summaries, written at the end of a work session so the next session resumes
- `procedural` agent-updatable rules
- `prompt` reusable prompt templates with `{{variable}}` placeholders
- `source` raw, un-compiled input

The `write` tool validates the type against this list, so off-schema types cannot silently escape the consolidation loop.

Namespaces are projects, each mapped to its GitHub repo(s) in the `namespaces` table.

## Repo access

Capsid reaches your repositories directly through a dedicated GitHub App. The Worker mints a short-lived installation token (RS256 JWT signed with Web Crypto, exchanged for an installation access token, cached in KV), so no long-lived token is stored. Repos are resolved from the `namespaces` table.

A namespace can map to more than one repo, each with a label (for example a rebuild as `primary` and the app it replaces as `legacy`). Every repo tool takes an optional `repo` parameter, a label or a mapped `owner/name`; unmapped repos are rejected, so the namespace mapping is the authorization boundary. Default is the `primary` repo.

- **Read** (open to admitted clients): `list_repo_tree`, `read_repo_file`, `search_code`, `repo_refs`, `repo_history`, `ci_status`
- **Write** (operator-gated): `write_repo_file`, `create_branch`, `delete_branch`, `open_pr`, `delete_repo_file`, `manage_pr`, `ci_dispatch`. `write_repo_file` defaults to `mode: "pr"` (commit to a new branch and open a pull request); `mode: "direct"` commits straight to the default branch. `manage_pr` merges (squash by default) or closes a pull request.

`search_code` is a server-side tree walk (recursive Git Trees listing, then bounded content scans), not GitHub's code search API, because that API returns empty results for private repositories under a GitHub App installation token. Use `path_prefix` to narrow large repos.

## Consolidation (lint)

The `lint` tool runs the wiki maintenance loop. The Worker never calls an LLM; the driving client does the reasoning with the ordinary read and write tools.

- `lint(namespace, mode: "gather")` returns a read-only packet: the namespace `core.md`, the compiled `concept` and `decision` docs, every un-archived `episodic` and `source` doc, and the schema and conventions. The driving LLM synthesizes an updated `core.md` and any new concept docs from this.
- `lint(namespace, mode: "finalize", consumed: [paths])` archives the consumed raw entries under an `archive/` path prefix and writes one audit row. It only moves and never deletes, so nothing is lost, and `gather` excludes `archive/`, so the loop is idempotent.

## Work queue

The handoff between a chat that has no shell and a session that has no conversation. A job is a title plus a body, and the body is the full prompt a driver executes. The `jobs` tool carries the whole lifecycle: `post` queues work, `claim` takes it, `heartbeat` holds it, and `complete`, `fail` or `block` end it.

- **Bodies are signed.** `post` signs the body with the same key and envelope as the improve loop's task documents, and `claim` verifies it before handing the job over. A body edited after it was signed is marked failed rather than left queued, because leaving it would hand the same broken row to every driver in turn. A job is executable input arriving as a database row, and the driver is a session holding local shell and repo credentials.
- **Leases, not locks.** A claim runs four hours; a five-minute tick returns an expired one to the queue, so a driver that dies costs one lease rather than a job nobody can pick up. One claim per caller across every namespace: a driver holding two has abandoned one.
- **Blocked is a pause, not an ending.** A job that reaches a push, a deploy, a secret, a live migration or a merge stops and is `block`ed with the exact command a human must run. Those jobs surface in `improve_status` with that command, and with how many gates the job has hit and how many times it has come back. Once the human has run it, `resume` returns the job to its holder with a fresh lease, recording in the audit row what was approved, and re-verifying the signature: a blocked job waits in the table for as long as a human takes.
- **The table is the source of truth for status.** Every job also mirrors to `<namespace>/jobs/<id>.md`, rewritten in the same batch as each transition, so `brief` and `search` see the queue without calling the tool. Every transition is a keyed `UPDATE ... RETURNING`, so exactly one caller wins a contested job.

The driver is the `/improve work` command in Claude Code: it resumes a cleared gate, claims one job, does it in that namespace's clone under the repo's own rules, and reports back.

## Self-improvement loop

An optional nightly loop that proposes one scoped code change at a time to a small roster of repos, has each repo's own CI score it, and keeps only what improved a repo without regressing it. It is **off by default**, and every machine-authored change arrives as a pull request that a human merges: nothing auto-merges.

- **Modes.** `subscription` has the Worker write a task document for a session to run and then stop, so it calls no model itself; `api` calls the model directly. `off` is the default, and any unreadable or unexpected setting falls back to it.
- **Cadence.** A nightly opener (a Cron Trigger at 03:00 America/Chicago) starts a run for each eligible namespace, and a five-minute tick advances any run in flight.
- **Scoring, in two jobs, and the second never puts attempt code on the runner.** `build` checks out the attempt branch and runs that repo's own build, tests, lint and bundle measurement with no credential in its environment. `score` checks out the default branch only and runs the hidden holdout suite inside a network-less, read-only container with the attempt mounted read-only, reading results from the container's stdout pipe. The score job is byte-identical across all five roster repos; only the build job differs. `scripts/sync-scorer.mjs` is what re-copies it, and its dry run is what verifies the copies still match.
- **No long-lived scoring credential.** The holdout suites live in a separate `HOLDOUT` R2 bucket, bound apart so attempt code cannot reach it. The score job asks the Worker for a one-hour, object-read-only credential scoped to that namespace's prefix, minted per run and signed with the same per-namespace key as the score report. Nothing stores a standing R2 key.
- **Keep or revert.** A change that regresses a pinned anchor metric, or fails to improve the weighted score, is reverted; a change that improves it opens a PR. Anchors are checksummed and pinned, and a mismatch refuses every run for that namespace until a human re-pins.
- **Protected paths.** Tests, CI configuration, lockfiles, manifests, compiler and lint config, migrations and the loop's own files are off limits to an attempt, enforced by a deterministic path guard rather than by asking. They are what measure the work, and a system that can edit its own measurements has none.
- **Budget, pause and one driver.** Monthly caps on estimated model spend and CI minutes stop the loop when exceeded. A per-namespace pause key holds that namespace until a human clears it, and a paused namespace never resumes on its own. In subscription mode a KV driver lease, six-hour TTL, keeps two sessions off the same namespace.

`improve_status` reports the mode, the budget, the protected-path patterns and each namespace's state, including its queued and blocked jobs; `improve_run` starts or resumes a run by hand.

## Endpoints

- `POST /mcp` MCP over Streamable HTTP, requires an OAuth access token (admin only)
- `POST /ops/mcp` MCP over Streamable HTTP for headless agents, requires the operator key as `Authorization: Bearer <key>`
- `POST /ops/backup` runs a backup on demand, requires a write-grant operator key, returns a JSON summary
- `GET /authorize`, `POST /authorize`, `GET /callback` GitHub OAuth flow
- `POST /token`, `POST /register` OAuth token exchange and dynamic client registration (served by the library)
- `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` OAuth discovery metadata (served by the library)
- `GET /health` no auth. Reports deploy provenance (the git sha, whether the tree was dirty, the build time) and PROBES THE STORE: a `SELECT 1` against D1 plus an FTS5 MATCH pinned to one known document. Either probe failing returns 503 with `status: "degraded"` and a `store` object naming which one, because a Worker whose bindings resolved to nothing starts perfectly and would otherwise answer a cheerful `ok` while every read tool errors

## Auth model

Two parallel paths, both fully gated:

1. **OAuth (`/mcp`)** for human clients. The client discovers the server via the `.well-known` endpoints, registers itself dynamically, and is sent through `/authorize`. After a one-time approval screen, the browser goes to GitHub. On return, the GitHub user is checked against `ADMIN_GITHUB_LOGIN`: set it to your GitHub username, or to your immutable numeric GitHub user id (find it at `https://api.github.com/users/<login>`). Any other GitHub account gets a 403. The admin check runs again on every `/mcp` request as defense in depth. An admitted admin holds a full write grant.
2. **Operator keys (`/ops/mcp`)** for agents and cron. Same server, gated by sha256-hashed bearer keys. `OPERATOR_KEY_HASH` holds one or more comma-separated hashes: a plain entry is a full (write) key, and an entry prefixed `ro:` is a read-only key that can use the read tools but is denied write, delete, move, register_namespace, update_namespace, repo writes, PR management, and lint finalize. Revoke a key by removing its hash; the others keep working. The OAuth library never sees this route, so the two paths cannot interfere.

Login and repo access use two different GitHub credentials: a GitHub **OAuth App** for login (OAuth Apps cannot mint installation tokens) and a separate GitHub **App** for repo access. Keep both.

## Destructive writes need confirmation

`delete`, `move`, `restore`, `lint` finalize, and any `write` that would overwrite an existing document, all ask for confirmation first. When the connected client supports [MCP elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation), the server sends an elicitation request and proceeds only on an explicit accept. Most Streamable HTTP clients run stateless and cannot answer server-initiated requests, so the fallback applies: the tool rejects with a clear message and you re-run it with `confirm: true`. Creating a brand new document never needs confirmation.

Deletes are never unrecoverable at the data layer: every delete (and every overwrite) snapshots the prior row into `document_versions` first, so recovery exists regardless of how the confirmation went.

## Security

The surface has been through several independent audits, and the hardening they produced is in the code rather than in a list of intentions: path traversal closed on every document path, OAuth consent bound to the exact redirect it was granted for, the scorer isolated so attempt code never runs beside a credential, protected paths enforced by a deterministic guard, an Origin allowlist on the browser-facing routes, and a replay cache keyed by a database primary key rather than a read-then-write. Each fix ships with a test that was observed failing against the code it replaced. The audits themselves, with their findings and verdicts, live in Capsid rather than in this repository.

## Backups

D1 Time Travel already provides 30-day point-in-time recovery, so backups here are for longer retention and portability, not short-term recovery.

A daily Cron Trigger (09:00 UTC) exports the whole database to the `MEDIA` R2 bucket:

- `backups/json/<timestamp>/<table>.json` one JSON dump per table, eleven per run (`TABLES` in `src/backup.ts`: documents, namespaces, document_versions, audit_log, document_links, the four improve-loop tables, jobs, and improve_jti). Retention treats the run, not the object: a run is kept for 90 days, the 14 most recent runs are always kept whatever their age, and a run that ages out is deleted whole.
- `backups/markdown/<namespace>/<path>` a plain-markdown mirror of every document body, verbatim, one file per document. This mirror tracks the current state (files for deleted documents are pruned), so the knowledge base stays readable and portable with no Capsid dependency.

After each export the history tables are pruned in D1: `document_versions` rows older than 90 days and `audit_log` rows older than 180 days. Pruning runs after the export, so every pruned row exists in at least one retained JSON dump.

An off-account copy exists too: a private `capsid-backups` repository pulls the latest JSON dump daily, so the dumps survive loss of the whole Cloudflare account, not only loss of the database.

Run one on demand with a write-grant operator key (read-only keys are refused):

```
curl -X POST https://capsid.<your-subdomain>.workers.dev/ops/backup -H "Authorization: Bearer <key>"
```

## Restore

Three paths, in the order to try them. Path 2 has been executed end to end against a scratch database: all table counts matched the source and search worked on the restored copy. The per-table form below is also exercised weekly by `restore-rehearsal.yml`, which pulls the newest R2 dump and rebuilds it into a fresh FTS5 database, documents first, and then checks the dump is internally consistent.

1. **D1 Time Travel** (last 30 days, fastest), for fat-finger recovery or a bad bulk change. `wrangler d1 time-travel info capsid`, then `wrangler d1 time-travel restore capsid --bookmark=<bookmark>`. This rewinds the live database in place, so take a fresh bookmark first to keep the restore itself reversible.

2. **Table-scoped export and import**, for rebuilding into a new database (migration, region move, corruption). Note that `wrangler d1 export` fails outright on this database, because D1 cannot export databases with FTS5 virtual tables. Export the eleven real tables individually and data-only, taking the schema from the migrations instead:

   ```
   wrangler d1 export capsid --remote --no-schema --table <table> --output export-<table>.sql
   ```

   The eleven tables are `documents`, `namespaces`, `document_versions`, `audit_log`, `document_links`, the four improve-loop tables `improve_scores`, `improve_attempts`, `improve_runs`, `improve_skills` (added by `migrations/0003_improve.sql`), `jobs`, the work queue (added by `migrations/0006_jobs.sql`), and `improve_jti`, the signed-request replay cache (added by `migrations/0004_improve_jti.sql`). `src/backup.ts` `TABLES` is the authoritative list, derived-checked against `migrations/` by `test/backup.test.ts`. Never export `documents_fts` or its `documents_fts_*` shadow tables: FTS5 derives them from `documents`, and they are what makes a whole-database export fail.

   Create the new database, apply **every** migration in `migrations/` in order (`0001_init.sql`, then `0002_document_links.sql`, `0003_improve.sql`, `0004_improve_jti.sql`, `0005_query_plan_indexes.sql`, `0006_jobs.sql` and `0007_jobs_resume.sql`; stopping early leaves later tables missing for the import to land in, and a column the code reads absent from a table that does exist), then execute the exports with `documents` first. Importing `documents` fires the FTS sync triggers, so `documents_fts` rebuilds itself and needs no separate step. The remaining tables have no triggers and no foreign keys, so their import order does not matter. Verify with count queries against both databases and one MATCH query on the new one, then point `wrangler.jsonc` at the new `database_id` and deploy.

3. **The R2 JSON dump**, for anything beyond the 30-day Time Travel window. Wrangler cannot list R2 objects, so get the exact keys from the Cloudflare dashboard or from the `json_keys` field of a `/ops/backup` response, then fetch each table's object: `wrangler r2 object get capsid-media/backups/json/<timestamp>/<table>.json --file <table>.json`. Convert each object's `rows` to INSERT statements and follow path 2 from the create step, `documents` first. The same dumps are mirrored off-account in the private `capsid-backups` repository, so this path still works if the Cloudflare account is gone. The `backups/markdown/` mirror is the last-resort human-readable copy: bodies only, no metadata.

   **A dump run is not only tables.** Two underscore-prefixed sidecars ride beside them and neither is D1, so a restore that rebuilds the database and stops is not a full restore:

   - `_kv.json` holds the improve loop's control pins, by allowlist: `improve_mode`, `improve:budget`, `improve:meta:last`, `backup:last-ok`, and per roster namespace its best record, pause reason and anchor checksum. Put them back with `wrangler kv key put` before turning the loop on, or every namespace runs unanchored. Deliberately NOT a prefix sweep of APP_KV: that namespace also holds cached GitHub installation tokens, and a dump leaves the account.
   - `_holdout-manifests.json` holds each namespace's hidden-suite COUNT (never a test). Without them every namespace scores as "no holdout manifest", which the scorer refuses, so the loop stops rather than scores wrongly.

   The dump is written as a single D1 batch, so its tables describe one instant. `scripts/restore-rehearsal.mjs` checks that weekly and refuses a torn one.

Single-document recovery rarely needs any of this. Every overwrite and delete snapshots the prior row into `document_versions` first, so recovering one document is usually just reading its latest snapshot back.

## Rollback

Restore above is about DATA. Rollback is about CODE: a deploy shipped a bad Worker and the fix is to serve the previous version now, not to wait for a corrected commit through CI.

```
npx wrangler deployments list
npx wrangler rollback [<version-id>]
```

`wrangler rollback` with no id reverts to the immediately previous deployment; pass a version id from the list to go further back. It swaps the Worker script and that version's bindings and vars only. It does NOT touch D1, R2 or KV data, so it is safe to run against a live store, and it does NOT change `master`: the next push to `master` redeploys `HEAD` through CI and supersedes the rollback, so a rollback is a stopgap that buys time to land the real fix, not the fix itself. After rolling back, `/health` reports the rolled-back commit's `sha`, so the scheduled live gate (which asserts `/health` sha equals master head) will go red until the fix ships. That red is correct: it is the gate telling you production is deliberately behind master.

## Clone setup

1. Install dependencies:

   ```
   npm install
   ```

2. Create your own Cloudflare resources:

   ```
   npx wrangler d1 create capsid
   npx wrangler kv namespace create APP_KV
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler r2 bucket create capsid-media
   npx wrangler r2 bucket create capsid-improve-holdout   # only if you run the self-improvement loop
   ```

3. Copy the config template and fill in your IDs from step 2. **`APP_KV` and `OAUTH_KV` must be different namespace ids.**

   ```
   cp wrangler.jsonc.example wrangler.jsonc
   ```

   The real `wrangler.jsonc` is gitignored on purpose. Never commit it.

4. Apply the migration (idempotent, `IF NOT EXISTS` everywhere):

   ```
   npx wrangler d1 migrations apply capsid --remote
   ```

5. Generate an operator key and store its sha256 hash as a secret. Keep the raw key safe; headless MCP clients send it as the bearer token on `/ops/mcp`:

   ```
   npx wrangler secret put OPERATOR_KEY_HASH
   ```

   The value is one or more comma-separated lowercase hex sha256 hashes. Prefix an entry with `ro:` to make that key read-only, e.g. `<full-key-hash>,ro:<agent-key-hash>`. Never store a raw key anywhere in the repo.

6. Create a GitHub **OAuth App** (for login) at https://github.com/settings/developers with:

   - Homepage URL: `https://capsid.<your-subdomain>.workers.dev`
   - Authorization callback URL: `https://capsid.<your-subdomain>.workers.dev/callback`

   Then set the OAuth secrets:

   ```
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32
   npx wrangler secret put ADMIN_GITHUB_LOGIN      # your GitHub username, or your numeric GitHub user id
   ```

7. For repo access, create a GitHub **App** (this is separate from the OAuth App above). Permissions: Repository contents read and write, Pull requests read and write, Metadata read. Install it on your account or org, on the repositories you want reachable. Note its Client ID, generate a private key (`.pem`), then:

   ```
   # put the App client id in wrangler.jsonc vars as GITHUB_APP_CLIENT_ID
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY        # paste the .pem contents
   ```

   Only the private key is used to mint installation tokens; the App client secret is not needed. The installation id is not configured: it is resolved from GitHub per owner and repo and cached for a day, because one pinned id cannot be correct for two owners.

   Optional, only to run the self-improvement loop: set `IMPROVE_SCORE_SECRET` (the root of the per-repo score-report keys) and, for `api` mode, `ANTHROPIC_API_KEY`. The loop stays off until `improve_mode` is set, so this can be skipped.

   ```
   npx wrangler secret put IMPROVE_SCORE_SECRET
   npx wrangler secret put ANTHROPIC_API_KEY        # api mode only
   ```

8. Type check and deploy:

   ```
   npm run check
   npm run deploy
   ```

9. Connect claude.ai: Settings, Connectors, Add custom connector, URL `https://capsid.<your-subdomain>.workers.dev/mcp`. The connector registers itself via dynamic client registration and walks you through the GitHub login. Only the `ADMIN_GITHUB_LOGIN` account gets in.

   Or test the flow first with the MCP Inspector:

   ```
   npx @modelcontextprotocol/inspector
   ```

   Set transport to Streamable HTTP, URL to `https://capsid.<your-subdomain>.workers.dev/mcp`, open the Auth tab, and run Quick OAuth Flow.

Note: MCP clients cache the tool list at connect time. After deploying new tools, reconnect the connector or start a new chat to see them.

## Roadmap

Three arcs, in order:

1. **Agents as users.** Per-client scoped credentials, so an agent is a first-class caller with its own grant and its own audit identity rather than one of a handful of shared operator keys.
2. **The console.** A read-only surface for the things that currently need a tool call to see: what the queue is holding, which jobs are blocked and on what command, and what the loop did last night.
3. **Skill records.** Capturing what an agent learned doing the work, in a form the next session retrieves, so the store holds capability and not only decisions.

## License

MIT
