# Capsid

Capsid is a single-user, Cloudflare-native MCP server that serves a consolidated knowledge base from D1 and R2, and reaches your GitHub repositories directly. It speaks MCP over Streamable HTTP and exposes a small, purposeful tool set:

- **Documents:** list, read, write, delete, move, find, search (FTS5), namespaces
- **Repo access:** list_repo_tree, read_repo_file, search_code, write_repo_file, create_branch, open_pr
- **Maintenance:** lint (the consolidation loop)

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
- `concept`, `decision`, `note`, `spec`, `task`, `protocol`, `post` the compiled knowledge and content
- `episodic` session summaries, written at the end of a work session so the next session resumes
- `procedural` agent-updatable rules
- `prompt` reusable prompt templates with `{{variable}}` placeholders
- `source` raw, un-compiled input

Namespaces are projects, each mapped to its GitHub repo(s) in the `namespaces` table.

## Repo access

Capsid reaches your repositories directly through a dedicated GitHub App. The Worker mints a short-lived installation token (RS256 JWT signed with Web Crypto, exchanged for an installation access token, cached in KV), so no long-lived token is stored. The repo per namespace is resolved from the `namespaces` table.

- **Read** (open to admitted clients): `list_repo_tree`, `read_repo_file`, `search_code`
- **Write** (operator-gated): `write_repo_file`, `create_branch`, `open_pr`. `write_repo_file` defaults to `mode: "pr"` (commit to a new branch and open a pull request); `mode: "direct"` commits straight to the default branch.

## Consolidation (lint)

The `lint` tool runs the wiki maintenance loop. The Worker never calls an LLM; the driving client does the reasoning with the ordinary read and write tools.

- `lint(namespace, mode: "gather")` returns a read-only packet: the namespace `core.md`, the compiled `concept` and `decision` docs, every un-archived `episodic` and `source` doc, and the schema and conventions. The driving LLM synthesizes an updated `core.md` and any new concept docs from this.
- `lint(namespace, mode: "finalize", consumed: [paths])` archives the consumed raw entries under an `archive/` path prefix and writes one audit row. It only moves and never deletes, so nothing is lost, and `gather` excludes `archive/`, so the loop is idempotent.

## Endpoints

- `POST /mcp` MCP over Streamable HTTP, requires an OAuth access token (admin only)
- `POST /ops/mcp` MCP over Streamable HTTP for headless agents, requires the operator key as `Authorization: Bearer <key>`
- `POST /ops/backup` runs a backup on demand, requires the operator key, returns a JSON summary
- `GET /authorize`, `POST /authorize`, `GET /callback` GitHub OAuth flow
- `POST /token`, `POST /register` OAuth token exchange and dynamic client registration (served by the library)
- `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` OAuth discovery metadata (served by the library)
- `GET /health` returns `ok`, no auth

## Auth model

Two parallel paths, both fully gated:

1. **OAuth (`/mcp`)** for human clients. The client discovers the server via the `.well-known` endpoints, registers itself dynamically, and is sent through `/authorize`. After a one-time approval screen, the browser goes to GitHub. On return, the GitHub user is checked against `ADMIN_GITHUB_LOGIN`: set it to your GitHub username, or to your immutable numeric GitHub user id (find it at `https://api.github.com/users/<login>`). Any other GitHub account gets a 403. The admin check runs again on every `/mcp` request as defense in depth.
2. **Operator key (`/ops/mcp`)** for agents and cron. Same tools, same server, gated by the existing sha256-hashed bearer key (`OPERATOR_KEY_HASH`). The OAuth library never sees this route, so the two paths cannot interfere.

Login and repo access use two different GitHub credentials: a GitHub **OAuth App** for login (OAuth Apps cannot mint installation tokens) and a separate GitHub **App** for repo access. Keep both.

## Destructive writes need confirmation

`delete`, and any `write` that would overwrite an existing document, ask for confirmation first. When the connected client supports [MCP elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation), the server sends an elicitation request and proceeds only on an explicit accept. Most Streamable HTTP clients run stateless and cannot answer server-initiated requests, so the fallback applies: the tool rejects with a clear message and you re-run it with `confirm: true`. Creating a brand new document never needs confirmation.

Deletes are never unrecoverable at the data layer: every delete (and every overwrite) snapshots the prior row into `document_versions` first, so recovery exists regardless of how the confirmation went.

## Backups

D1 Time Travel already provides 30-day point-in-time recovery, so backups here are for longer retention and portability, not short-term recovery.

A daily Cron Trigger (09:00 UTC) exports the whole database to the `MEDIA` R2 bucket:

- `backups/json/<timestamp>.json` a full JSON dump of all four tables (documents, namespaces, document_versions, audit_log). The 14 most recent dumps are kept; older ones are pruned automatically.
- `backups/markdown/<namespace>/<path>` a plain-markdown mirror of every document body, verbatim, one file per document. This mirror tracks the current state (files for deleted documents are pruned), so the knowledge base stays readable and portable with no Capsid dependency.

Run one on demand with the operator key:

```
curl -X POST https://capsid.<your-subdomain>.workers.dev/ops/backup -H "Authorization: Bearer <key>"
```

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
   npx tsc --noEmit
   npx wrangler deploy
   ```

9. Connect claude.ai: Settings, Connectors, Add custom connector, URL `https://capsid.<your-subdomain>.workers.dev/mcp`. The connector registers itself via dynamic client registration and walks you through the GitHub login. Only the `ADMIN_GITHUB_LOGIN` account gets in.

   Or test the flow first with the MCP Inspector:

   ```
   npx @modelcontextprotocol/inspector
   ```

   Set transport to Streamable HTTP, URL to `https://capsid.<your-subdomain>.workers.dev/mcp`, open the Auth tab, and run Quick OAuth Flow.

## Roadmap

- Phase 1 (done): single operator token on `/ops/mcp`, bearer key checked against `OPERATOR_KEY_HASH`.
- Phase 2 (done): GitHub OAuth via workers-oauth-provider on `/mcp`, locked to a single admin account.
- Phase 3 (deferred): first-class service tokens for agents and cron, issued and revocable per client, replacing the single shared operator key; an autonomous, scheduled lint run once agents exist to drive it.

## License

MIT
