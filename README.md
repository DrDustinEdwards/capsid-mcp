# Capsid

Capsid is a control plane for AI agents working across a portfolio of repositories. It provides structured memory, scoped credentials with an audit trail over every write, a signed work queue that hands a task from a chat to a machine, and an optional self-improvement loop scored against hidden tests.

It is a single-user Cloudflare Worker. It speaks MCP over Streamable HTTP and exposes 32 tools in five groups: documents, repo access, maintenance, the work queue, and self-improvement. It also serves Resources (every document at `capsid://<namespace>/<path>`) and Prompts (templates stored as documents).

Every write snapshots the prior version into `document_versions` and appends to `audit_log`.

## Stack

- Cloudflare Worker (TypeScript), stateless MCP via `createMcpHandler` from the Agents SDK
- [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) wrapping the handler: OAuth 2.1 with PKCE, dynamic client registration, tokens in KV
- A GitHub OAuth App for login, locked to one admin account
- A separate GitHub App for repo access, minting short-lived installation tokens
- D1 for documents, versions, namespaces, jobs, agents and the audit log, with FTS5 search
- R2: `MEDIA` for media, backups and reports; `HOLDOUT` for the loop's hidden test suites, bound separately so attempt code cannot reach it
- KV, two separate namespaces: `APP_KV` for the Worker's caches, `OAUTH_KV` for the provider's clients, grants and tokens. They must not be the same namespace (see Clone setup)

## Knowledge model

Documents are typed. The model is Karpathy's LLM Wiki pattern: raw sources compiled into a maintained wiki.

- `core` one always-loaded summary per namespace, read first
- `concept`, `decision`, `note`, `spec`, `task`, `protocol`, `post`, `reference` compiled knowledge and content
- `episodic` session summaries
- `procedural` agent-updatable rules
- `prompt` templates with `{{variable}}` placeholders
- `source` raw, un-compiled input

`write` validates the type against this list, so an off-schema type cannot escape the consolidation loop.

Namespaces are projects, each mapped to its GitHub repo or repos in the `namespaces` table. The `namespaces` tool reports each namespace's count of unconsolidated `episodic` and `source` documents.

## Auth model

Every caller resolves to an **agent**: a name, a set of scopes, and its own audit identity. There is one enforcement point, `checkScope` in `src/scope.ts`. The registrar wraps every tool registration before any tool module runs, so a tool is covered by existing, and `TOOL_GRANTS` states what each tool requires.

Scopes are five axes. `namespaces` and `repos` are a list or `*`. `tools` is an allow list or `*`. `grants` is read, or read and write. `flags` are the blast radius:

| flag | what it gates |
| --- | --- |
| `can_merge` | merging a pull request, which can trigger a deploy on a repo that deploys on push |
| `can_direct_write` | a `mode: "direct"` commit, which lands on a default branch with no review |
| `can_dispatch` | dispatching a workflow, which spends CI minutes and runs code with that repo's secrets in scope |
| `can_write_workflows` | writing under `.github/workflows/` |
| `can_touch_protected` | tests, CI, lint and compiler config, lockfiles, manifests, the agent steering layer, migrations |
| `money_paths` | a path naming a billing or payment surface |

A new agent gets read on its named namespaces and no flags. Scopes are stored as JSON and the parse fails closed: a null, truncated or wrong-shaped column resolves to no namespaces, no tools, no grants and no flags.

The `agents` tool is **admin only**, because an agent that could mint another could widen itself. `mint` returns a key once and stores only its sha256. `list` is the inventory, revoked rows included. `revoke` sets `revoked_at` rather than deleting, so rows an agent wrote still resolve to what it was allowed to do, while its key stops resolving immediately. `update_scopes` replaces named axes and leaves the rest.

Audit rows and `jobs.claimed_by` record a minted agent as `agent:<name>`.

Three kinds of caller resolve, in this order:

1. **A minted agent**, matched on the sha256 of its bearer token. Checked first, so a key that is both an agent and an operator entry gets the narrower authority.
2. **A legacy operator key**, until its hash is removed from `OPERATOR_KEY_HASH` by hand.
3. **The OAuth admin session**, the synthetic agent `admin` with every scope.

The operator hash has been removed from the roster machines. Every Claude Code session now runs as its folder's driver agent, and the admin OAuth session is the only wider credential.

Two gated endpoints:

1. **OAuth (`/mcp`)** for human clients. The client discovers the server via `.well-known`, registers dynamically, and goes through `/authorize` and a one-time approval screen to GitHub. On return the user is checked against `ADMIN_GITHUB_LOGIN`: your GitHub username, or your numeric user id (find it at `https://api.github.com/users/<login>`). Any other account gets a 403. The check runs again on every `/mcp` request. An admitted admin holds a full write grant.
2. **Agent and operator keys (`/ops/mcp`)** for agents and cron, gated by sha256-hashed bearer keys. An agent key resolves to its row. Failing that, `OPERATOR_KEY_HASH` holds comma-separated hashes: a plain entry is a write key, an entry prefixed `ro:` is read-only and is denied write, delete, move, register_namespace, update_namespace, repo writes, PR management and lint finalize. Revoke by removing a hash; the others keep working. The OAuth library never sees this route.

Login and repo access use two different GitHub credentials: an OAuth App for login (OAuth Apps cannot mint installation tokens) and a GitHub App for repo access. Keep both.

`register_namespace` returns the command that mints the new namespace's driver agent, `node scripts/mint-agents.mjs --namespace <ns> --apply`. It does not mint it: minting is admin only, and `register_namespace` takes a plain write grant.

## Repo access

Capsid reaches your repositories through a dedicated GitHub App. The Worker mints a short-lived installation token (an RS256 JWT signed with Web Crypto, exchanged for an installation access token, cached in KV), so no long-lived token is stored. Repos resolve from the `namespaces` table.

A namespace can map to several repos, each with a label (for example `primary` and `legacy`). Every repo tool takes an optional `repo` parameter, a label or a mapped `owner/name`, defaulting to `primary`. An unmapped repo is rejected, so the namespace mapping is the authorization boundary.

- **Read**: `list_repo_tree`, `read_repo_file`, `search_code`, `repo_refs`, `repo_history`, `ci_status`
- **Write**: `write_repo_file`, `create_branch`, `delete_branch`, `open_pr`, `delete_repo_file`, `manage_pr`, `ci_dispatch`

`write_repo_file` defaults to `mode: "pr"` (commit to a new branch, open a pull request); `mode: "direct"` commits to the default branch and needs `can_direct_write`. `manage_pr` merges (squash by default) or closes a pull request, and deletes the head branch when it is safe.

`search_code` is a server-side tree walk (a recursive Git Trees listing, then bounded content scans), not GitHub's code search API, which returns empty results for private repositories under an App installation token. Use `path_prefix` to narrow large repos.

## Consolidation (lint)

The `lint` tool runs the wiki maintenance loop. The Worker never calls an LLM; the driving client does the reasoning with the ordinary read and write tools.

- `lint(namespace, mode: "gather")` returns a read-only packet: the namespace `core.md`, the compiled `concept` and `decision` documents, every un-archived `episodic` and `source` document, and the schema and conventions.
- `lint(namespace, mode: "finalize", consumed: [paths])` archives the consumed entries under an `archive/` prefix and writes one audit row. It moves and never deletes, and `gather` excludes `archive/`, so the loop is idempotent.

## Work queue

The queue hands a task from a chat that has no shell to a session that has no conversation. A job is a title plus a body, and the body is the full prompt a driver executes. `jobs` carries the lifecycle: `post`, `claim`, `heartbeat`, then `complete`, `fail`, `block` or `resume`. The seat merges; drivers never hold `can_merge`.

- **Bodies are signed**, with the same key and envelope as the loop's task documents. `claim` verifies the body first, and one edited after signing is marked failed rather than left queued. A job is executable input arriving as a database row, and the driver is a session holding local shell and repo credentials.
- **Leases, not locks.** A claim runs four hours; a five-minute tick returns an expired one to the queue. One claim per caller across every namespace.
- **A job can require flags.** `post` takes `required_flags`, stored in `jobs.required_scopes`. A claim by an agent lacking them is refused and the job stays queued.
- **Blocked is a pause.** A job reaching a push, a deploy, a secret, a live migration or a merge stops and is blocked with the exact command a human must run. Blocked jobs surface in `improve_status` with that command, with how many gates the job hit and how many times it came back. `resume` then returns it to a holder with a fresh lease, records what was approved, and re-verifies the signature. Any write-grant caller may resume, since the seat that approves is routinely not the session that blocked.
- **A job can require a track record.** `post` also takes `min_record` (`{prs_merged: n}`), stored in `jobs.min_record`. `required_flags` asks what a driver is permitted to do; this asks what it has already done, measured against the same agent record the console shows. A claim below the bar is refused and the job stays queued.
- **`complete` takes a `result_ref`**, a document key or a pull request URL, and an optional `evidence` object (`prs`, `commits`, `files_changed`, `tests_added`).
- **Finishing a job writes one row of evidence.** `complete` and `fail` each write a single `job_outcomes` row, and the Worker never stores a count it could check and did not: every pull request named in `evidence` is read from GitHub, so the merge, commit and file counts recorded are GitHub's rather than the driver's, and the last one's head commit is checked for a CI conclusion. A per-field `verified` flag says which numbers were checked, a field nobody reported is `NULL` rather than `0`, and the row is written once, enforced by its primary key. An unreachable GitHub costs the verified flags, never the driver's ability to close finished work.
- **Agent records are built from those rows.** `improve_status` and the console carry a record per credential: jobs done, failed and blocked, gates hit and resumes, pull requests opened and merged, a merge rate, a CI green rate and a median duration. Counts and rates only, never a composite score, and only a verified field feeds a rate, since a rate built from what a credential said about itself is a credential grading its own work. A rate with no denominator is `null`, not zero.
- **The table is the source of truth for status.** Every job mirrors to `<namespace>/jobs/<id>.md`, rewritten in the same batch as each transition, so `brief` and `search` see the queue. Every transition is a keyed `UPDATE ... RETURNING`, so one caller wins a contested job.

The driver is the `/improve work` command in Claude Code: it resumes a cleared gate, claims one job, does it in that namespace's clone under that repo's rules, and reports back.

**One driver session per project folder.** The bearer token is fixed when the MCP server is configured, so a session holds one credential and works one namespace. Each repo folder configures its own from `~/.capsid/agent-<ns>-driver.key`. `/improve work all` therefore does not walk the portfolio on one credential: run from the `dev` folder it reports which repo folders have queued jobs, and each is launched separately.

## Autonomy

What the machine may do with no human in the loop. Both policies ship **disabled**, and
each one lives in two places: a reviewable file in `docs/policy/`, and the copy the
Worker actually reads, a signed document in the store. An unsigned copy, or one edited
after signing, authorizes nothing.

**Auto-merge** (`docs/policy/auto-merge.md`, read from `capsid/policy/auto-merge.md`).
The five-minute tick walks every open pull request on the namespaces the policy names
and merges only those that pass all seven checks, evaluated in order, each refusing on
its own:

| check | what it requires |
| --- | --- |
| `body_names_job` | the PR body carries the id of the job the work came from |
| `author_is_driver` | that job was claimed by a minted, unrevoked agent of kind `driver` |
| `base_is_default_branch` | the PR targets the repo's default branch |
| `ci_green` | every check run on the head sha completed and concluded success, skipped or neutral, and at least one reported |
| `paths_unprotected` | no changed path matches `PROTECTED_PATH_PATTERNS`, the list the loop enforces |
| `paths_not_money` | no changed path names a billing or payment surface |
| `no_migration_workflow_lockfile` | no changed path is a migration, a workflow or a lockfile |

The document names the checks and the code enforces them: a check the Worker runs that
the document does not name is refused at load time, and a test asserts the two agree in
both directions. A pull request failing any check is left open, audited with the check
that refused it, and reported under `improve_status` as awaiting the seat.

**Pre-approved gates** (`docs/policy/gates.md`, read from `capsid/policy/gates.md`). A
driver that reaches a push, a migration or a pull request blocks with the exact command,
and every one of those waits on a person. This policy lets the seat send a bounded one
back in itself: `jobs` action `resume` with `approved_by_policy` set to the document's
version, refused unless the blocked command matches one of three classes.
`additive_migration` is a `wrangler d1 execute` naming a `--file` under `migrations/`
whose every statement is `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` or
`CREATE INDEX`, with an unrecognized statement form a refusal rather than a pass.
`push_branch` is a `git push origin <branch>` for a branch that is not `master` or
`main`, with no force flag. `open_pr` is a `gh pr create`. A never-list is checked over
the whole command before any class is tried: secrets, revocations, force pushes, pushes
to a default branch, `wrangler deploy` and `rollback`, mode changes, drops and deletes,
and merging a pull request, which stays the human's gate. The audit row records which
class matched and what it matched on.

**Signing is admin only.** `improve_run` action `sign_policy` signs the body **already
stored** rather than any body the caller supplies, only in the `capsid` namespace and
only under `policy/`, and a minted agent is refused outright. Turning a policy on is
therefore two deliberate acts: editing the document, which is on the ordinary write
tool's refusal list and needs `allow_improve_paths` plus `can_touch_protected`, and
signing it again afterwards.

**The nightly driver runs on this machine, not in the cloud.** `scripts/schedule-drivers.mjs`
installs one Windows Task Scheduler task per project folder, each invoking `/improve work`
in that folder at 04:00 America/Chicago, so each task reaches Capsid as exactly one
driver agent from its own `~/.capsid/agent-<ns>-driver.key`. A Claude Code cloud routine
was measured and rejected: a routine can attach only claude.ai connectors, the registered
Capsid connector points at `/mcp`, the OAuth admin path, and there is no verified way to
hand a routine a secret, so a nightly routine would run the whole queue on the wide
credential the driver agents were minted to replace. The scheduler is off twice over:
nothing is created without `--apply`, and an installed task is created disabled.

## Self-improvement loop

An optional nightly loop that proposes one scoped change at a time to a small roster of repos, has each repo's own CI score it, and keeps only what improved the repo without regressing it. It is **off by default**, and every machine-authored change arrives as a pull request a human merges.

- **Modes.** `subscription` has the Worker write a task document for a session to run, so it calls no model itself. `api` calls the model directly. `off` is the default, and any unreadable or unexpected setting falls back to it.
- **Cadence.** A nightly opener (a Cron Trigger at 03:00 America/Chicago) starts a run per eligible namespace; a five-minute tick advances any run in flight.
- **Scoring runs in two jobs, and the second never puts attempt code on the runner.** `build` checks out the attempt branch and runs that repo's build, tests, lint and bundle measurement with no credential in its environment. `score` checks out the default branch only and runs the hidden holdout suite in a network-less, read-only container with the attempt mounted read-only, reading results from its stdout pipe. `score` is byte-identical across all five roster repos; only `build` differs. `scripts/sync-scorer.mjs` re-copies it and its dry run verifies the copies match.
- **No long-lived scoring credential.** The score job asks the Worker for a one-hour, object-read-only credential scoped to that namespace's `HOLDOUT` prefix, minted per run and signed with the same per-namespace key as the score report.
- **Keep or revert.** A change that regresses a pinned anchor metric, or fails to improve the weighted score, is reverted; one that improves it opens a pull request. Anchors are checksummed and pinned, and a mismatch refuses every run for that namespace until a human re-pins.
- **Protected paths.** Tests, CI configuration, lockfiles, manifests, compiler and lint config, migrations, the agent steering layer and the loop's own files are off limits to an attempt, enforced by a deterministic path guard. These files define the score; an attempt may not change what scores it.
- **Budget, pause and one driver.** Monthly caps on estimated model spend and CI minutes stop the loop when exceeded. A per-namespace pause key holds that namespace until a human clears it. In subscription mode a KV driver lease (six-hour TTL) keeps two sessions off one namespace.

`improve_status` reports the mode, the budget, the protected-path patterns, the agent inventory and each namespace's state, including queued and blocked jobs. `improve_run` starts or resumes a run by hand.

## Skills

The loop abstracts an idea from work that landed and offers it back to other projects.

**A skill package is layered, and the Worker reads the layers separately.** The declared
fields (trigger condition, namespaces, termination test, composition interface) live on
the `improve_skills` row as well as in the repo's `SKILL.md` frontmatter, so the Worker
matches a trigger and enforces a status without cloning a repository. The instruction
body is a document, and it is what an edit is measured and bounded against. The repo
copy is the reviewable source; the stored copy is what the machine acts on, the same
split the policy documents use.

**The lifecycle is three states.** Every skill starts `candidate`, including one
abstracted from an attempt that was kept, since being born of a success says nothing
about whether the written form helps anybody else. A candidate goes `live` on two
positive evaluations; a live skill goes `retired` on two consecutive non-positive ones.
Retired rows stay, with their record, so the same idea is not abstracted twice from the
same source.

**A status changes on evaluation evidence and never on a driver's report of its own
run.** Two evaluations minimum in either direction: one result is a sample. Evidence
counts per version and per probe set, so an accepted edit resets it. Edits are bounded
at 20 percent of the instruction lines, counted by distinct lines touched, and accepted
only on strict improvement; a tie is a rejection. Rejected edits are kept in
`skill_edits` and handed to the next optimizer run, so a proposal already refused is not
proposed again.

**A skill is credited only when it was used and the verifier reported success**, so an
offered-and-ignored skill and a run that died on the environment both earn nothing.
Offered and used are both stored on `job_outcomes`, because the gap between them is its
own measurement.

**Failure notes are memory rather than a second score.** `skill_failures` carries a note
per reverted attempt and failed job, linked to the skills in use at the time, and the
recommend step attaches the two most recent for each skill it offers. Nothing there
moves a status.

**Two live skills whose triggers overlap and whose bodies differ by less than 10 percent
are proposed for merging**, to a human. Only live skills: a candidate has not earned its
place and a retired one is a record.

**The evaluation cycle is fortnightly**, KV-configurable under
`skills:evaluate:cadence-days` and riding the five-minute tick, which gates on the
cadence before doing anything else. Each cycle runs the namespace's probe set in the
scorer sandbox twice per skill, with it and without it, and records the difference. A
cadence below one day falls back to the default rather than being obeyed.

**The console carries a skills panel per namespace**: counts by status, the last
evaluation, and the offered-to-used rate, which is the number a reader cannot compute
from the others.

Full model: `docs/schema.md`, under Skill records.

## Console

One page at `/console` that answers "what is the state of every namespace" without asking a chat. It renders what `improve_status` and `jobs` already compute, so the page and the tools cannot disagree.

- **Who gets in.** The GitHub admin session, and nothing else. The console rides the same GitHub OAuth app and the same single-admin check as the MCP flow, and turns the result into a signed cookie that lasts twelve hours. An operator key or an agent key gets a 403 that says so: those authenticate to `/ops/mcp`, and answering them with a login redirect would send a machine to GitHub.
- **What it shows.** A header with the deployed sha, the schema version, the backup age, the month's spend against its caps and the improve mode. Then one row per namespace: the pause reason if any, whether the anchor block is pinned, the last run's attempts, kept and reverted, the four job counts, the truth report's integrity percentage, and the driver agent's last_seen. **A blocked job prints the exact command it is waiting on**, so the reader knows what to run.
- **The agents panel** lists every credential with its kind, namespaces, flags held, last_seen and revoked state, beside what it did: jobs done, failed and blocked, pull requests opened and merged, and for a driver, its namespaces' attempts kept and reverted. A **verified** column carries the three numbers this Worker checked against GitHub itself, merge rate, CI green rate and median duration, kept separate from the counts the store wrote; a dash means there was nothing to divide by. Counts and rates only. No composite score.
- **Recent activity** is the last 50 audit rows, filterable by namespace and by actor.
- **Six controls**, each a POST with a CSRF token and a confirmation step that states what is about to happen before anything changes: pause, unpause, set the mode, resume a blocked job with the approval reason, mark a job failed, revoke an agent. Every one goes through the same function the MCP tool calls and writes its own audit row naming the person who clicked.
- **It never merges and it never mints.** Merging can start a CI deploy in two of these repos, so that stays with `manage_pr` behind a caller holding `can_merge`; minting hands out a key, so that stays with the `agents` tool. Neither is in the console's action list, and a test asserts their absence.
- **`GET /console.json`** serves the same object the page renders, so a dashboard or a chat reads the state without scraping.

The page is self-contained: no scripts, no external fonts, one inline stylesheet, and a CSP that denies everything by default. Light and dark come from `prefers-color-scheme`.

## Endpoints

- `POST /mcp` MCP over Streamable HTTP, requires an OAuth access token (admin only)
- `POST /ops/mcp` MCP over Streamable HTTP for agents and cron, requires an agent or operator key as `Authorization: Bearer <key>`
- `POST /ops/backup` runs a backup on demand, requires a write-grant key, returns a JSON summary
- `GET /authorize`, `POST /authorize`, `GET /callback` GitHub OAuth flow
- `GET /console`, `POST /console`, `GET /console.json`, `GET /console/callback` the admin console, its actions and its JSON twin. Admin session only; a bearer token is refused with 403
- `POST /csp-report` no auth. Content-Security-Policy and COOP violation reports, per-IP rate limited
- `POST /improve/score` the signed score report a roster repo's CI posts back
- `POST /improve/holdout-credential` mints the one-hour, object-read-only credential the score job reads the holdout suite with
- `POST /backup/credential` mints the credential the off-account backup writes with
- `POST /token`, `POST /register` token exchange and dynamic client registration (served by the library)
- `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` discovery metadata (served by the library)
- `GET /health` no auth. Reports deploy provenance (git sha, whether the tree was dirty, build time) and probes the store: `SELECT 1` against D1 plus an FTS5 MATCH pinned to one known document. Either probe failing returns 503 with `status: "degraded"` and a `store` object naming which one, because a Worker whose bindings resolved to nothing starts normally and would otherwise answer `ok` while every read tool errors

## Destructive writes need confirmation

`delete`, `move`, `restore`, `lint` finalize, and any `write` that would overwrite an existing document ask for confirmation first. When the client supports [MCP elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation), the server sends an elicitation request and proceeds only on an explicit accept. Most Streamable HTTP clients run stateless and cannot answer server-initiated requests, so the tool rejects and you re-run it with `confirm: true`. Creating a new document never needs confirmation.

Every delete and overwrite snapshots the prior row into `document_versions` first, whatever happened at the confirmation step.

## Security

Several independent audits have run against this surface. What they produced is in the code: path traversal closed on every document path, OAuth consent bound to the exact redirect it was granted for, the scorer isolated so attempt code never runs beside a credential, protected paths enforced by a deterministic guard, an Origin allowlist on the browser-facing routes, and a replay cache keyed by a database primary key rather than a read-then-write. Each fix ships with a test observed failing against the code it replaced. The audits live in Capsid, not in this repository.

## Backups

D1 Time Travel already provides 30-day point-in-time recovery, so backups here are for longer retention and portability.

A daily Cron Trigger (09:00 UTC) exports the database to `MEDIA`:

- `backups/json/<timestamp>/<table>.json` one JSON dump per table (`TABLES` in `src/backup.ts` is the list). Retention treats the run: kept for 90 days, the 14 most recent runs always kept whatever their age, and a run that ages out is deleted whole.
- `backups/markdown/<namespace>/<path>` a plain-markdown mirror of every document body, one file per document, tracking current state (files for deleted documents are pruned).

After each export, `document_versions` rows older than 90 days and `audit_log` rows older than 180 are pruned. Pruning runs after the export, so every pruned row exists in at least one retained dump.

A private `capsid-backups` repository pulls the latest JSON dump daily, so the dumps survive loss of the whole Cloudflare account.

Run one on demand with a write-grant key (read-only keys are refused):

```
curl -X POST https://capsid.<your-subdomain>.workers.dev/ops/backup -H "Authorization: Bearer <key>"
```

## Restore

Three paths, in the order to try them. Path 2 has been executed end to end against a scratch database: all table counts matched the source and search worked on the restored copy. `restore-rehearsal.yml` exercises the per-table form weekly, rebuilding the newest R2 dump into a fresh FTS5 database, documents first.

1. **D1 Time Travel** (last 30 days, fastest), for fat-finger recovery or a bad bulk change. Run `wrangler d1 time-travel info capsid`, then `wrangler d1 time-travel restore capsid --bookmark=<bookmark>`. This rewinds the live database in place, so take a fresh bookmark first to keep the restore reversible.

2. **Table-scoped export and import**, for rebuilding into a new database. `wrangler d1 export` fails outright here, because D1 cannot export databases with FTS5 virtual tables. Export the real tables individually and data-only, taking the schema from the migrations:

   ```
   wrangler d1 export capsid --remote --no-schema --table <table> --output export-<table>.sql
   ```

   There are seventeen real tables: `documents`, `namespaces`, `document_versions`, `audit_log`, `document_links`, the four improve-loop tables `improve_scores`, `improve_attempts`, `improve_runs` and `improve_skills` (`migrations/0003_improve.sql`), `jobs`, the work queue (`migrations/0006_jobs.sql`), `job_outcomes`, what each finished job produced (`migrations/0011_job_outcomes.sql`), `agents`, the scoped credentials (`migrations/0008_agents.sql`), `improve_jti`, the signed-request replay cache (`migrations/0004_improve_jti.sql`), and `skill_evaluations`, `skill_edits` and `skill_failures`, the skill lifecycle's evidence (`migrations/0012_skill_records.sql` and `migrations/0013_skill_attribution.sql`), and `job_outcome_prs`, which pull requests an outcome counted (`migrations/0015_outcome_prs.sql`). `TABLES` in `src/backup.ts` is authoritative, derived-checked against `migrations/` by `test/backup.test.ts`. Never export `documents_fts` or its `documents_fts_*` shadow tables: FTS5 derives them from `documents`, and they are what makes a whole-database export fail.

   Create the new database and apply every migration in order: `0001_init.sql`, `0002_document_links.sql`, `0003_improve.sql`, `0004_improve_jti.sql`, `0005_query_plan_indexes.sql`, `0006_jobs.sql`, `0007_jobs_resume.sql`, `0008_agents.sql`, `0009_jobs_required_scopes.sql`, `0010_console_indexes.sql`, `0011_job_outcomes.sql`, `0012_skill_records.sql`, `0013_skill_attribution.sql`, `0014_skill_status_index.sql`, `0015_outcome_prs.sql`. Stopping early leaves later tables missing for the import to land in, and a column the code reads absent from a table that does exist. Then execute the exports with `documents` first: importing it fires the FTS sync triggers, so `documents_fts` rebuilds itself. The rest have no triggers and no foreign keys, so their order does not matter. Verify with count queries against both databases and one MATCH query on the new one, then point `wrangler.jsonc` at the new `database_id` and deploy.

3. **The R2 JSON dump**, beyond the 30-day Time Travel window. Wrangler cannot list R2 objects, so take the exact keys from the Cloudflare dashboard or the `json_keys` field of a `/ops/backup` response, then fetch each: `wrangler r2 object get capsid-media/backups/json/<timestamp>/<table>.json --file <table>.json`. Convert each object's `rows` to INSERT statements and follow path 2 from the create step, `documents` first. The same dumps are mirrored off-account in `capsid-backups`, so this path works if the Cloudflare account is gone. The `backups/markdown/` mirror is the last-resort human-readable copy: bodies only, no metadata.

   **A dump run is more than tables.** Two underscore-prefixed sidecars ride beside them and neither is D1, so a restore that rebuilds the database and stops is incomplete:

   - `_kv.json` holds the loop's control pins, by allowlist: `improve_mode`, `improve:budget`, `improve:meta:last`, `backup:last-ok`, and per roster namespace its best record, pause reason and anchor checksum. Put them back with `wrangler kv key put` before turning the loop on, or every namespace runs unanchored. Deliberately not a prefix sweep of `APP_KV`: that namespace also holds cached GitHub installation tokens, and a dump leaves the account.
   - `_holdout-manifests.json` holds each namespace's hidden-suite count, never a test. Without it every namespace scores as "no holdout manifest", which the scorer refuses.

   The dump is written as a single D1 batch, so its tables describe one instant. `scripts/restore-rehearsal.mjs` checks that weekly and refuses a torn one.

Recovering one document rarely needs any of this: read its latest `document_versions` snapshot back.

## Rollback

Restore is about data. Rollback is about code: a deploy shipped a bad Worker and the fix is to serve the previous version now.

```
npx wrangler deployments list
npx wrangler rollback [<version-id>]
```

With no id it reverts to the immediately previous deployment; pass a version id to go further back. It swaps the Worker script and that version's bindings and vars only. It does not touch D1, R2 or KV data, and it does not change `master`: the next push redeploys `HEAD` through CI and supersedes the rollback. Afterwards `/health` reports the rolled-back sha, so the scheduled live gate (which asserts `/health` sha equals master head) goes red until the fix ships. That red is correct: production is deliberately behind master.

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

   The real `wrangler.jsonc` is gitignored. Never commit it.

4. Apply the migrations (idempotent, `IF NOT EXISTS` everywhere):

   ```
   npx wrangler d1 migrations apply capsid --remote
   ```

5. Generate an operator key and store its sha256 hash as a secret. Keep the raw key safe; headless clients send it as the bearer token on `/ops/mcp`:

   ```
   npx wrangler secret put OPERATOR_KEY_HASH
   ```

   The value is one or more comma-separated lowercase hex sha256 hashes. Prefix an entry with `ro:` to make that key read-only, for example `<full-key-hash>,ro:<agent-key-hash>`. Never store a raw key in the repo. Once agents are minted (`docs/bootstrap.md`), remove the operator hash.

6. Create a GitHub **OAuth App** (for login) at https://github.com/settings/developers:

   - Homepage URL: `https://capsid.<your-subdomain>.workers.dev`
   - Authorization callback URLs, both of them, spelled exactly: `https://capsid.<your-subdomain>.workers.dev/callback` for the MCP flow and `https://capsid.<your-subdomain>.workers.dev/console/callback` for the console. Wildcard matching should be off: each redirect is granted for the exact URI it was issued against.

   Then set the secrets:

   ```
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32
   npx wrangler secret put ADMIN_GITHUB_LOGIN      # your GitHub username, or your numeric GitHub user id
   ```

7. For repo access, create a GitHub **App**, separate from the OAuth App. Permissions: Repository contents read and write, Pull requests read and write, Metadata read, Actions read and write, Workflows read and write. The last two are what let the Worker dispatch a workflow and write under `.github/workflows/`; both are gated behind agent flags (`can_dispatch` and `can_write_workflows`), so the App holding the permission does not mean a caller can use it. Install it on the repositories you want reachable. Note its Client ID, generate a private key (`.pem`), then:

   ```
   # put the App client id in wrangler.jsonc vars as GITHUB_APP_CLIENT_ID
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY        # paste the .pem contents
   ```

   Only the private key mints installation tokens; the App client secret is not needed. The installation id is not configured: it resolves from GitHub per owner and repo and is cached for a day, because one pinned id cannot be correct for two owners.

   Optional, only for the self-improvement loop: `IMPROVE_SCORE_SECRET` (the root of the per-repo score-report keys) and, for `api` mode, `ANTHROPIC_API_KEY`. The loop stays off until `improve_mode` is set.

   ```
   npx wrangler secret put IMPROVE_SCORE_SECRET
   npx wrangler secret put ANTHROPIC_API_KEY        # api mode only
   ```

8. Type check and deploy:

   ```
   npm run check
   npm run deploy
   ```

9. Connect claude.ai: Settings, Connectors, Add custom connector, URL `https://capsid.<your-subdomain>.workers.dev/mcp`. The connector registers itself and walks you through the GitHub login. Only the `ADMIN_GITHUB_LOGIN` account gets in.

   Or test the flow first with the MCP Inspector:

   ```
   npx @modelcontextprotocol/inspector
   ```

   Set transport to Streamable HTTP, URL to `https://capsid.<your-subdomain>.workers.dev/mcp`, open the Auth tab, and run Quick OAuth Flow.

MCP clients cache the tool list at connect time. After deploying new tools, reconnect the connector or start a new chat to see them.

## Roadmap

Four things shipped on 2026-09-11. **Agents as users**: the credentials and the one enforcement point are live, and what remains there is operational, mint one agent per project and per machine then remove the operator hash (`docs/bootstrap.md`). **The console** (PR #20): the admin surface for what the queue holds, which jobs are blocked and on what command, and what the loop did last night. **The model-refresh skill**: a weekly cron in the claude-skills repo that rewrites the model-facing lines in this repo's skills and commands to match a named model's prompting guide, calibration only, never a gate or a ruling or task content. **Jobs as evidence** (PR #21): a verified outcome row per finished job, and agent records as counts and rates.

Two more shipped on 2026-09-12. **Autonomy** (PR #24): auto-merge by signed policy, pre-approved gate classes, and a nightly scheduled driver, all described under Autonomy above. **Skill records** (PR #25): the lifecycle, the evaluation cycle, the bounded edit gate and the console panel, described under Skills above.

One item left: **the experiment scheduler**, once the loop has real nights behind it.

**Three switches, all off by default, each turned on separately.** The loop runs only when `improve_mode` in `APP_KV` is set to `subscription` or `api`, by `improve_run` action `mode`; anything unreadable or unexpected falls back to `off`. Auto-merge and pre-approved gates run only when their policy document's `enabled` field is `true` **and** the document has been signed again afterwards with `improve_run` action `sign_policy`, which is admin only; editing without re-signing leaves the policy authorizing nothing. The nightly driver exists only after `node scripts/schedule-drivers.mjs --install --namespace <ns> --apply`, and the task it creates is disabled until it is enabled by hand.

## License

MIT
