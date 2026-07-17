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

1. Keep the worker lean. Few tools, no dead code, no speculative abstractions. The tool surface is deliberately small (16 tools) and should stay that way.
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
- DEFECT: `search_code` returns 0 results for every query, including terms verified present via read_repo_file (2026-07-16). The hosted GitHub MCP connector's search_code returns 0 on these repos too, so cross-repo audits in this window are read-verified, not grep-verified.
- DEFECT: repo tools resolve a namespace to its `primary` repo only. Multi-repo namespaces (recova -> foxhound primary + recova legacy) are declarable in the schema but not addressable; there is no repo or label argument. This currently makes the legacy recova repo unreachable through Capsid.
- GAP: `register_namespace` is create-only. Remapping an existing namespace requires a raw D1 update (done once, 2026-07-16). Needs `update_namespace`, operator-gated and audit-logged.
- GAP: no `delete_repo_file`, so deprecating a repo file can only overwrite it with a stub.
- GAP: no `merge_pr`. Combined with the hosted GitHub connector 404ing on private repos, nothing reachable from claude.ai can merge a PR. On a phone-only workflow this makes `mode: "direct"` the only way to land a change without the owner tapping Merge in the GitHub app. Prefer PR mode for anything touching live behavior regardless.
- The MCP spec ships breaking changes on 2026-07-28: stateless core, Multi Round-Trip Requests replacing server-initiated elicitation, auth hardening, Sampling deprecated. The stateless design and `confirm: true` fallback already match the direction, but a compliance pass is due once the Agents SDK updates.

## Commands

- `npm test` - node --test (test/auth.test.ts, test/normalize.test.ts). Not vitest.
- `npm run check` - tsc --noEmit. Run before every push.
- `npm run dev` - wrangler dev.
- `npm run deploy` - wrangler deploy.
- `npx wrangler secret put KEY` - set a secret. Never commit one.
