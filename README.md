# Capsid

Capsid is a public, Cloudflare-native MCP server that serves a consolidated knowledge base from D1 and R2. It speaks MCP over Streamable HTTP and exposes a small, purposeful tool set: list, read, write, delete, move, find, search (FTS5), and namespaces.

Reads are open. Writes (write, delete, move) require an operator key sent as `Authorization: Bearer <key>`, verified against a sha256 hash stored as a Worker secret. Every write snapshots the prior version into `document_versions` and appends to `audit_log`, so you get history and rollback for free.

## Stack

- Cloudflare Worker (TypeScript), stateless MCP via `createMcpHandler` from the Agents SDK
- D1 for documents, versions, namespaces, and audit log, with FTS5 full text search
- R2 (`MEDIA` binding) for media
- KV (`APP_KV` binding) for app state

## Endpoints

- `POST /mcp` MCP over Streamable HTTP
- `GET /health` returns `ok`, no auth

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

3. Copy the config template and fill in your IDs from step 2:

   ```
   cp wrangler.jsonc.example wrangler.jsonc
   ```

   The real `wrangler.jsonc` is gitignored on purpose. Never commit it.

4. Apply the migration:

   ```
   npx wrangler d1 migrations apply capsid --remote
   ```

   Note: the migration is idempotent (IF NOT EXISTS everywhere). Applying it against an already-migrated database, including the original capsid D1, is a no-op. Cloners must run it once.

5. Generate an operator key and store its hash as a secret. Keep the raw key somewhere safe; it is what MCP clients send as the bearer token.

   ```
   npx wrangler secret put OPERATOR_KEY_HASH
   ```

   The value must be the lowercase hex sha256 of your raw key. Never store the raw key anywhere in the repo.

6. Type check and deploy:

   ```
   npx tsc --noEmit
   npx wrangler deploy
   ```

7. Connect an MCP client to `https://capsid.<your-subdomain>.workers.dev/mcp`. Add the `Authorization: Bearer <key>` header to enable writes.

## Auth roadmap

v1 uses a single service token (bearer key checked against `OPERATOR_KEY_HASH`). The planned next step is human SSO via [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider), which slots in front of the same MCP handler. Not built yet.

## License

MIT
