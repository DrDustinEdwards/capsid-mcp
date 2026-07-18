# Capsid

Capsid is a single-user, Cloudflare-native MCP server that serves a consolidated knowledge base from D1 and R2, and reaches your GitHub repositories directly. It speaks MCP over Streamable HTTP and exposes a small, purposeful tool set (22 tools):

- **Documents:** list, read, write, delete, move, find, search (FTS5, with a plain-text fallback when a query is not valid FTS5 syntax), namespaces, backlinks (typed edges), brief (one-call session start)
- **Repo access:** list_repo_tree, read_repo_file, search_code, write_repo_file, create_branch, open_pr, delete_repo_file, manage_pr, ci_status (CI runs via the GitHub App)
- **Maintenance:** lint (the consolidation loop), register_namespace (create), update_namespace (remap)

Writes normalize wide dashes (em and en) to plain ASCII punctuation server-side, so no client can store an em dash. The `namespaces` tool reports each namespace's count of unconsolidated episodic/source docs, so any session can see where a lint run is due.

It also exposes the rest of the MCP surface: **Resources** (every document addressable at `capsid://<namespace>/<path>`) and **Prompts** (reusable templates stored as documents).

All access is gated. Human clients (claude.ai, MCP Inspector) authenticate via GitHub OAuth, and only the configured admin GitHub account is admitted. Headless agents and cron use a separate operator-key endpoint. Every write snapshots the prior version into `document_versions` and appends to `audit_log`, so you get history and rollback for free.

## Stack

- Cloudflare Worker (TypeScript), stateless MCP via `createMcpHandler` from the Agents SDK
- [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) wrapping the MCP handler: OAuth 2.1 with PKCE, dynamic client registration, and token storage in KV
- GitHub OAuth App as the identity provider for login, locked to a single admin account
- A separate GitHub App for repo access, minting short-lived installation tokens
- D1 for documents, versions, namespaces, and audit log, with FTS5 full text search
- R2 (`MEDIA` binding) for media
- KV (`APP_KV` binding) for app state, plus an `OAUTH_KV` binding for OAuth tokens

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

- **Read** (open to admitted clients): `list_repo_tree`, `read_repo_file`, `search_code`
- **Write** (operator-gated): `write_repo_file`, `create_branch`, `open_pr`, `delete_repo_file`, `manage_pr`. `write_repo_file` defaults to `mode: "pr"` (commit to a new branch and open a pull request); `mode: "direct"` commits straight to the default branch. `manage_pr` merges (squash by default) or closes a pull request.

`search_code` is a server-side tree walk (recursive Git Trees listing, then bounded content scans), not GitHub's code search API, because that API returns empty results for private repositories under a GitHub App installation token. Use `path_prefix` to narrow large repos.

## Consolidation (lint)

The `lint` tool runs the wiki maintenance loop. The Worker never calls an LLM; the driving client does the reasoning with the ordinary read and write tools.

- `lint(namespace, mode: "gather")` returns a read-only packet: the namespace `core.md`, the compiled `concept` and `decision` docs, every un-archived `episodic` and `source` doc, and the schema and conventions. The driving LLM synthesizes an updated `core.md` and any new concept docs from this.
- `lint(namespace, mode: "finalize", consumed: [paths])` archives the consumed raw entries under an `archive/` path prefix and writes one audit row. It only moves and never deletes, so nothing is lost, and `gather` excludes `archive/`, so the loop is idempotent.

## Endpoints

- `POST /mcp` MCP over Streamable HTTP, requires an OAuth access token (admin only)
- `POST /ops/mcp` MCP over Streamable HTTP for headless agents, requires the operator key as `Authorization: Bearer <key>`
- `POST /ops/backup` runs a backup on demand, requires a write-grant operator key, returns a JSON summary
- `GET /authorize`, `POST /authorize`, `GET /callback` GitHub OAuth flow
- `POST /token`, `POST /register` OAuth token exchange and dynamic client registration (served by the library)
- `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` OAuth discovery metadata (served by the library)
- `GET /health` returns `ok`, no auth

## Auth model

Two parallel paths, both fully gated:

1. **OAuth (`/mcp`)** for human clients. The client discovers the server via the `.well-known` endpoints, registers itself dynamically, and is sent through `/authorize`. After a one-time approval screen, the browser goes to GitHub. On return, the GitHub user is checked against `ADMIN_GITHUB_LOGIN`: set it to your GitHub username, or to your immutable numeric GitHub user id (find it at `https://api.github.com/users/<login>`). Any other GitHub account gets a 403. The admin check runs again on every `/mcp` request as defense in depth. An admitted admin holds a full write grant.
2. **Operator keys (`/ops/mcp`)** for agents and cron. Same server, gated by sha256-hashed bearer keys. `OPERATOR_KEY_HASH` holds one or more comma-separated hashes: a plain entry is a full (write) key, and an entry prefixed `ro:` is a read-only key that can use the read tools but is denied write, delete, move, register_namespace, update_namespace, repo writes, PR management, and lint finalize. Revoke a key by removing its hash; the others keep working. The OAuth library never sees this route, so the two paths cannot interfere.

Login and repo access use two different GitHub credentials: a GitHub **OAuth App** for login (OAuth Apps cannot mint installation tokens) and a separate GitHub **App** for repo access. Keep both.

## Destructive writes need confirmation

`delete`, and any `write` that would overwrite an existing document, ask for confirmation first. When the connected client supports [MCP elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation), the server sends an elicitation request and proceeds only on an explicit accept. Most Streamable HTTP clients run stateless and cannot answer server-initiated requests, so the fallback applies: the tool rejects with a clear message and you re-run it with `confirm: true`. Creating a brand new document never needs confirmation.

Deletes are never unrecoverable at the data layer: every delete (and every overwrite) snapshots the prior row into `document_versions` first, so recovery exists regardless of how the confirmation went.

## Backups

D1 Time Travel already provides 30-day point-in-time recovery, so backups here are for longer retention and portability, not short-term recovery.

A daily Cron Trigger (09:00 UTC) exports the whole database to the `MEDIA` R2 bucket:

- `backups/json/<timestamp>.json` a full JSON dump of all four tables (documents, namespaces, document_versions, audit_log). The 14 most recent dumps are kept; older ones are pruned automatically.
- `backups/markdown/<namespace>/<path>` a plain-markdown mirror of every document body, verbatim, one file per document. This mirror tracks the current state (files for deleted documents are pruned), so the knowledge base stays readable and portable with no Capsid dependency.

After each export the history tables are pruned in D1: `document_versions` rows older than 90 days and `audit_log` rows older than 180 days. Pruning runs after the export, so every pruned row exists in at least one retained JSON dump.

Run one on demand with a write-grant operator key (read-only keys are refused):

```
curl -X POST https://capsid.<your-subdomain>.workers.dev/ops/backup -H "Authorization: Bearer <key>"
```

## Restore

Three paths, in the order to try them. Path 2 has been executed end to end against a scratch database: all four table counts matched the source and search worked on the restored copy.

1. **D1 Time Travel** (last 30 days, fastest), for fat-finger recovery or a bad bulk change. `wrangler d1 time-travel info capsid`, then `wrangler d1 time-travel restore capsid --bookmark=<bookmark>`. This rewinds the live database in place, so take a fresh bookmark first to keep the restore itself reversible.

2. **Table-scoped export and import**, for rebuilding into a new database (migration, region move, corruption). Note that `wrangler d1 export` fails outright on this database, because D1 cannot export databases with FTS5 virtual tables. Export the four real tables individually and data-only, taking the schema from the migration instead:

   ```
   wrangler d1 export capsid --remote --no-schema --table <table> --output export-<table>.sql
   ```

   Create the new database, apply `migrations/0001_init.sql`, then execute the four exports with `documents` first. Importing `documents` fires the FTS sync triggers, so `documents_fts` rebuilds itself and needs no separate step. Verify with count queries against both databases and one MATCH query on the new one, then point `wrangler.jsonc` at the new `database_id` and deploy.

3. **The R2 JSON dump**, for anything beyond the 30-day Time Travel window. Wrangler cannot list R2 objects, so get the exact key from the Cloudflare dashboard or from the `json_key` field of a `/ops/backup` response, then `wrangler r2 object get capsid-media/backups/json/<key>.json --file dump.json`. Convert each table in `dump.tables` to INSERT statements and follow path 2 from the create step. The `backups/markdown/` mirror is the last-resort human-readable copy: bodies only, no metadata.

Single-document recovery rarely needs any of this. Every overwrite and delete snapshots the prior row into `document_versions` first, so recovering one document is usually just reading its latest snapshot back.

## Clone setup

1. Install dependencies:

   ```
   npm install
   ```

2. Create your own Cloudflare resources:

   ```
   npx wrangler d1 create capsid
   npx wrangler kv namespace create APP_KV
   npx wrangler r2 bucket create capsid-media
   ```

3. Copy the config template and fill in your IDs from step 2. The `OAUTH_KV` binding can reuse the same KV namespace id as `APP_KV` (the OAuth library prefixes all of its keys), or point at a dedicated namespace if you prefer:

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
   npx wrangler secret put GITHUB_APP_INSTALLATION_ID    # optional; auto-resolved if omitted
   ```

   Only the private key is used to mint installation tokens; the App client secret is not needed.

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

- Phase 1 (done): single operator token on `/ops/mcp`, bearer key checked against `OPERATOR_KEY_HASH`.
- Phase 2 (done): GitHub OAuth via workers-oauth-provider on `/mcp`, locked to a single admin account.
- Phase 3 (partial): multiple operator keys with a read-only tier, individually revocable by editing the secret. Still deferred: per-client issued tokens with names and per-key audit, and an autonomous, scheduled lint run once agents exist to drive it.
- Phase 4 (done, 2026-07): multi-repo namespaces with a repo selector on every repo tool; update_namespace; delete_repo_file; manage_pr (merge/close); search_code reimplemented as a tree walk.
- Phase 5 (done, 2026-07): typed document links (`document_links`) with a `backlinks` query; `brief` for one-call session start; `ci_status` for CI visibility via the GitHub App; truth lints documented as lint-loop steps (cross-doc contradiction, doc-vs-artifact binding, and doc-vs-live-Cloudflare infra binding via the Cloudflare MCP tools, since the Worker holds no Cloudflare API token).
- Later: alignment with the 2026-07-28 MCP spec revision (readiness audited; waiting on the SDK release); adopting fiberplane/drift for doc-code drift on repos where docs and code are co-located (foxhound keeps its canon in Capsid, so it does not fit); per-client issued operator tokens.

## License

MIT
