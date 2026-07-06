# Capsid

Capsid is a single-user, Cloudflare-native MCP server that serves a consolidated knowledge base from D1 and R2. It speaks MCP over Streamable HTTP and exposes a small, purposeful tool set: list, read, write, delete, move, find, search (FTS5), and namespaces.

All access is gated. Human clients (claude.ai, MCP Inspector) authenticate via GitHub OAuth, and only the configured admin GitHub account is admitted. Headless agents and cron use a separate operator-key endpoint. Every write snapshots the prior version into `document_versions` and appends to `audit_log`, so you get history and rollback for free.

## Stack

- Cloudflare Worker (TypeScript), stateless MCP via `createMcpHandler` from the Agents SDK
- [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) wrapping the MCP handler: OAuth 2.1 with PKCE, dynamic client registration, and token storage in KV
- GitHub as the identity provider, locked to a single admin account
- D1 for documents, versions, namespaces, and audit log, with FTS5 full text search
- R2 (`MEDIA` binding) for media
- KV (`APP_KV` binding) for app state, plus an `OAUTH_KV` binding for OAuth tokens

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
2. **Operator key (`/ops/mcp`)** for agents and cron. Same tools, same server, gated by the existing sha256-hashed bearer key (`OPERATOR_KEY_HASH`). The OAuth library never sees this route, so the two paths cannot interfere. Note: this path moved from `/mcp` to `/ops/mcp`; update any headless client configs.

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

The response is a summary: the JSON dump key, document count, markdown files written and pruned, and how many JSON dumps were kept and pruned.

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

4. Apply the migration:

   ```
   npx wrangler d1 migrations apply capsid --remote
   ```

   Note: the migration is idempotent (IF NOT EXISTS everywhere). Applying it against an already-migrated database, including the original capsid D1, is a no-op. Cloners must run it once.

5. Generate an operator key and store its hash as a secret. Keep the raw key somewhere safe; it is what headless MCP clients send as the bearer token on `/ops/mcp`.

   ```
   npx wrangler secret put OPERATOR_KEY_HASH
   ```

   The value must be the lowercase hex sha256 of your raw key. Never store the raw key anywhere in the repo.

6. Create a GitHub OAuth App at https://github.com/settings/developers with:

   - Homepage URL: `https://capsid.<your-subdomain>.workers.dev`
   - Authorization callback URL: `https://capsid.<your-subdomain>.workers.dev/callback`

   Then set the OAuth secrets (none of these ever go in the repo):

   ```
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32
   npx wrangler secret put ADMIN_GITHUB_LOGIN      # your GitHub username, or your numeric GitHub user id
   ```

   For local dev with `wrangler dev`, create a second GitHub OAuth App with callback `http://localhost:8787/callback` and put the four values in `.dev.vars` (gitignored).

7. Type check and deploy:

   ```
   npx tsc --noEmit
   npx wrangler deploy
   ```

8. Connect claude.ai: Settings, Connectors, Add custom connector, URL `https://capsid.<your-subdomain>.workers.dev/mcp`. The connector registers itself via dynamic client registration and walks you through the GitHub login. Only the `ADMIN_GITHUB_LOGIN` account gets in.

9. Or test the flow first with the MCP Inspector:

   ```
   npx @modelcontextprotocol/inspector
   ```

   Set transport to Streamable HTTP, URL to `https://capsid.<your-subdomain>.workers.dev/mcp`, open the Auth tab, and run Quick OAuth Flow.

## Auth roadmap

- Phase 1 (done): single service token, bearer key checked against `OPERATOR_KEY_HASH`. Now served at `/ops/mcp`.
- Phase 2 (done): GitHub OAuth via workers-oauth-provider on `/mcp`, locked to a single admin account. This is what claude.ai and other OAuth-only clients use.
- Phase 3 (deferred): first-class service tokens for agents and cron, issued and revocable per client, replacing the single shared operator key.

## License

MIT
