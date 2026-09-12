# Capsid

Capsid is a control plane for AI agents working across a portfolio of repositories. It stores structured memory, issues scoped credentials with an audit trail over every write, runs a signed work queue that hands a task from a chat to a machine, and optionally runs a self-improvement loop scored against hidden tests.

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

## How it works

- **Memory.** Documents are typed (`core`, `concept`, `decision`, `task`, `episodic`, `procedural`, `prompt`, `source` and more), stored in D1 with FTS5 search, and grouped into namespaces that map to GitHub repos. `write` validates the type, so an off-schema document cannot escape the consolidation loop. Full model: [docs/schema.md](docs/schema.md).
- **Agents.** Every caller resolves to an agent with its own key, scopes and audit identity, through one enforcement point. Scopes are five axes, and the blast-radius flags (merge, direct write, dispatch, workflows, protected paths, money paths) are held one at a time by separate roles.
- **Repo access.** A dedicated GitHub App mints short-lived installation tokens. The Worker reads and writes mapped repositories with no long-lived credential stored. The namespace mapping is the authorization boundary.
- **The work queue.** A job hands a task from a chat that has no shell to a session that has no conversation. Bodies are signed, claims take a four-hour lease, and a job reaching a push, a deploy or a merge blocks with the exact command a human runs.
- **The self-improvement loop.** An optional nightly loop proposes one scoped change at a time, has each repo's own CI score it against hidden tests, and opens a pull request only for changes that improved the repo without regressing an anchor. Off by default, and it never merges.
- **The console.** One admin page at `/console` showing every namespace: pauses, job counts, the command each blocked job waits on, the agent inventory and recent activity. It renders what the tools already compute.
- **Backups.** A daily cron exports every table to R2 as JSON plus a markdown mirror of every document body, pulled off-account daily. Restore is documented and rehearsed weekly against a scratch database.
- **Audit trail.** Every write snapshots the prior version into `document_versions` and appends to `audit_log`. Every destructive write asks for confirmation first.

## Documentation

- [docs/auth.md](docs/auth.md) the agent model, the five scope axes, the roles, and the two gated endpoints
- [docs/repo-access.md](docs/repo-access.md) how the GitHub App token flow works and which tools read and write repos
- [docs/work-queue.md](docs/work-queue.md) the job lifecycle, signing, leases, gates, evidence and agent records
- [docs/autonomy.md](docs/autonomy.md) auto-merge, pre-approved gate classes, the nightly driver and the watcher
- [docs/improve.md](docs/improve.md) the self-improvement loop: how it runs, and what stops it moving its own goalposts
- [docs/skills.md](docs/skills.md) how an idea abstracted from work that landed is offered to other projects
- [docs/console.md](docs/console.md) what the admin page shows, who gets in, and what it cannot do
- [docs/consolidation.md](docs/consolidation.md) the wiki maintenance loop, and the confirmation step on destructive writes
- [docs/backups.md](docs/backups.md) what the daily dump contains, and three restore paths in the order to try them
- [docs/rollback.md](docs/rollback.md) serving the previous Worker version when a deploy shipped a bad one
- [docs/schema.md](docs/schema.md) the knowledge model, the document types and the tables
- [docs/bootstrap.md](docs/bootstrap.md) minting agents and removing the operator key

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
- `GET /health` no auth. Reports deploy provenance (git sha, whether the tree was dirty, build time) and probes the store: `SELECT 1` against D1 plus an FTS5 MATCH pinned to one known document. Either probe failing returns 503 with `status: "degraded"` and a `store` object naming which one. A Worker whose bindings resolved to nothing starts normally and would otherwise answer `ok` while every read tool errors.

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

## What's next

The experiment scheduler, once the loop has real nights behind it. Nothing else is planned.

## Switches

Three switches, all off by default. Each is turned on separately.

The loop runs only when `improve_mode` in `APP_KV` is set to `subscription` or `api`, by `improve_run` action `mode`. Anything unreadable or unexpected falls back to `off`.

Auto-merge and pre-approved gates run only when their policy document's `enabled` field is `true` and the document has been signed again afterwards with `improve_run` action `sign_policy`, which is admin only. Editing without re-signing leaves the policy authorizing nothing.

The nightly driver exists only after `node scripts/schedule-drivers.mjs --install --namespace <ns> --apply`. The task it creates is disabled until it is enabled by hand.

## Security

Independent audits of this surface produced these fixes, now in the code: path traversal closed on every document path, OAuth consent bound to the exact redirect it was granted for, the scorer isolated so attempt code never runs beside a credential, protected paths enforced by a deterministic guard, an Origin allowlist on the browser-facing routes, and a replay cache keyed by a database primary key rather than a read-then-write. Each fix ships with a test observed failing against the code it replaced. The audits live in Capsid, not in this repository.

## License

MIT
