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

1. Keep the worker lean. Few tools, no dead code, no speculative abstractions. The tool surface is deliberately small (19 tools) and should stay that way.
2. The operator key is stored only as a sha256 hash in a Worker secret (OPERATOR_KEY_HASH). Never commit wrangler.jsonc, .dev.vars, or .env.
3. No real vault content in any seed or fixture. Sample data must be obviously fake (example.com, lorem-style bodies, namespace "sample").
4. The lint loop never calls an LLM from the Worker. The driving client does all reasoning with ordinary read and write tools. Gather is read-only; finalize archives, never deletes.
5. Every overwrite and delete snapshots the prior row into document_versions and appends to audit_log. Do not add a write path that skips this.
6. Writes normalize wide dashes to ASCII server-side. This is the enforcement layer for the portfolio em dash rule; no client can store an em dash. Keep it that way. Note the scope: only DOCUMENT writes to D1 are normalized. Repo writes (write_repo_file) pass content through verbatim, which is how em dashes reached foxhound's docs/canon copies.

## Auth model

Two parallel gated paths.
- OAuth on `/mcp` for human clients (claude.ai, Inspector). GitHub login checked against ADMIN_GITHUB_LOGIN on every request. An admitted admin holds a full write grant, so claude.ai sessions can perform operator-gated writes.
- Operator keys on `/ops/mcp` for agents and cron. OPERATOR_KEY_HASH holds one or more comma-separated sha256 hashes; a plain entry is a write key, an entry prefixed `ro:` is read-only (writes, delete, move, register_namespace, repo writes, and lint finalize are denied). Revoke by removing a hash.
- `/ops/backup` requires a write-grant key specifically. Read-only keys get a 401.

## Backups and restore

D1 Time Travel already gives 30-day point-in-time recovery; backups are for longer retention and portability. The daily cron writes `backups/json/<timestamp>.json` (full dump of all four tables, 14 kept) and a `backups/markdown/` mirror of every document body. After each export it prunes document_versions past 90 days and audit_log past 180, so pruned rows always exist in a retained dump.

Restore gotcha: `wrangler d1 export` fails outright on this database because of the FTS5 virtual table. Export the four real tables individually with `--no-schema --table`, take the schema from the migration, and import documents first so the FTS triggers rebuild the index. The cron is unaffected because it dumps each table with its own SELECT.

## Known constraints and the current defect list

- claude.ai's connector UI is OAuth-only. No static bearer tokens, no API keys, no custom headers. That is why the OAuth layer exists at all.
- MCP tool lists are cached at connect time. Tools deployed after a session connected will not appear until the connector is reconnected or a new chat starts.
- `search_code` walks the repo tree and greps blobs server-side rather than calling GitHub's code-search API, which returns empty 200s for these private repos over an App installation token (verified 2026-07-17). Scope large repos with `path_prefix`; it refuses trees over 5,000 blobs.
- Repo tools take an optional `repo` argument (a label like "primary"/"legacy" or a mapped "owner/name") to address multi-repo namespaces (recova -> foxhound primary + recova legacy). Omit it for the primary repo. An unmapped selector is rejected with the valid values; the namespace mapping is the authorization boundary. Repo writes are audit-logged with the resolved repo.
- `register_namespace` creates a namespace; `update_namespace` remaps an existing one's repos (operator-gated, audit-logged, snapshots the prior mapping). Neither renames a namespace: a rename touches document keys, versions, and audit history and is a separate task.
- `delete_repo_file` removes a repo file (PR or direct mode), so deprecating a file no longer means leaving a stub.
- `manage_pr` merges or closes a PR from Capsid, so claude.ai can now land a PR without the hosted GitHub connector (which 404s on private repos). Merging can trigger CI deploys (foxhound), so prefer PR mode plus `manage_pr` for anything touching live behavior, and gate by blast radius.
- New tools require a connector reconnect or a new chat to appear: MCP tool lists cache at connect time (see the constraint above).
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
