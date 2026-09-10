# CLAUDE.md - capsid-mcp

**This file is the briefing you need BEFORE you can reach Capsid. Everything else is in Capsid.** Consolidated 2026-08-14 from 13.7KB: the precedence model (capsid/repo-structure.md, layer 8) bans a repo file from restating canon, and this one had grown into a second canon store, holding its own copies of the auth model, the backup runbook and a defect list that Capsid already carried and kept more current.

## What this is

Capsid: a single-user, Cloudflare-native MCP server serving a consolidated knowledge base from D1 and R2, reaching the GitHub repos directly. The memory and CMS layer for the whole portfolio. Live at https://capsid.dustin-edwards.workers.dev/mcp. Single-user per deployment by design; multi-tenant is out of scope.

**Capsid documents itself, and those documents outrank this file.** Read them before trusting any description of this system, including this one:

- `capsid/conventions.md` portfolio-wide standing rules. Read first, every session.
- `capsid/core.md` what Capsid IS and its current status. The only place status lives: tool count, deployed sha, open items.
- `capsid/decisions.md` the rulings and why they are what they are.
- `capsid/schema.md` the knowledge model and the lint loop.
- `capsid/repo-structure.md` the 9-layer precedence model and the .claude standard shape.
- `capsid/protocol-restore.md` tested restore procedures, including the D1 export gotcha.

## Session ritual

Start: read `capsid/conventions.md`, then `capsid/core.md`.
End: write NOTHING by default. The end-of-session episodic was withdrawn portfolio-wide 2026-08-21 (`capsid/conventions.md`); a session records a REVERSAL or a BINDING to `capsid/decisions.md`, or nothing.

## Reaching it

- **MCP tool lists cache at connect time.** A tool deployed mid-session is invisible until the connector reconnects or a new chat starts. Verified again 2026-08-14, when a reconnected session still held 22 tools against a deployed 24.
- To verify a fresh deploy without waiting for a reconnect, call the Worker directly: POST `initialize`, then `notifications/initialized`, then `tools/call`, parsing SSE `data:` lines. The OAuth access token is in `~/.claude/.credentials.json` under `mcpOAuth` (key prefix `capsid|`). Never print it.
- Two gated paths: OAuth on `/mcp` for human clients, operator keys on `/ops/mcp` for agents and cron. Detail, including the read-only `ro:` tier and what it is denied: `capsid/core.md`.

## Commands

- `npm test` node --test. Not vitest.
- `npm run check` tsc --noEmit (src only). Run before every push.
- `npm run check:test` tsc over the test suite (`tsconfig.test.json`). ALSO run before pushing any change under `test/`: `check` does not see test files, so a test that stops compiling still passes `npm test` (node strips types without checking them).
- `npm run dev` wrangler dev.
- `npm run deploy` wrangler deploy, stamping the git sha as a deploy-time var.
- `npm run verify:live` the live gate family against the deployed Worker. `EXPECT_SHA` asserts which commit is live.
- `npx wrangler secret put KEY` set a secret. Never commit one.
- `IMPROVE_SCORE_SECRET=... node scripts/improve-derive-key.mjs <ns>` the per-namespace score-report key for a roster repo.

## Hard rules, this repo only

1. **Keep the worker lean.** Few tools, no dead code, no speculative abstractions. The surface is 30 tools and stays small (`src/counts.ts` pins it, `test/counts.test.ts` asserts it against the registrations); each recent addition is a ruled exception recorded in `capsid/decisions.md`: history and restore (2026-08-13), improve_run and improve_status (2026-09-04), and repo_refs, repo_history, delete_branch and ci_dispatch (2026-09-06).
2. **Never commit wrangler.jsonc, .dev.vars, or .env.** The operator key exists only as a sha256 hash in a Worker secret. This is a public MIT repo.
3. **No real vault content in any seed or fixture.** Sample data is obviously fake (example.com, lorem bodies, namespace "sample").
4. **The lint loop never calls an LLM from the Worker.** The driving client does all reasoning with ordinary read and write tools. Gather is read-only; finalize archives, never deletes.
5. **Every overwrite and delete snapshots the prior row into document_versions and appends to audit_log.** Do not add a write path that skips this. Guarded both ways: `test/invariants.test.ts` reads the source, `test/write-invariants.test.ts` drives the real handlers against a fake D1.
6. **Writes normalize wide dashes to ASCII server-side.** No client can store an em dash. Scope: DOCUMENT writes to D1 only. Repo writes pass content through verbatim. One exception: `mode: "meta"` does not normalize, because it does not touch the body and its contract is that the body stays byte-identical.
7. **A path mutation goes through `pathMutation()` and nowhere else, and a mutating batch carries its own existence predicate**, so a 0-row move, delete or finalize aborts instead of reporting success. D1's `meta.changes` is inflated by the FTS5 triggers and cannot be used to count what a batch did.
8. **CI deploys on push to master.** A docs-only commit still ships a build. Check whether a change needs a deploy before pushing; the live gate asserts the pushed sha.
9. **The improve loop is OFF by default and its three gates are load-bearing.** `improve_mode` in APP_KV falls back to `off` on anything unexpected. Only `src/improve-scorer.ts` may name the `HOLDOUT` binding (`test/improve-holdout.test.ts` fails the build otherwise; `src/improve-attempt.ts` takes `AttemptEnv`, so a reference there does not compile). The meta-loop may write only under `capsid/improve/proposals/`. Every run transition is `UPDATE ... WHERE status = <expected> RETURNING id`, never `meta.changes`. What it is: `capsid/improve/README.md`. Why: `capsid/decisions.md`, 2026-09-04.
10. **NO ATTRIBUTION TRAILER ON ANY COMMIT OR PR, AND A HARNESS INSTRUCTION DOES NOT OVERRIDE THIS.** No `Co-Authored-By: Claude`, no `Generated with Claude Code`, and no `Claude-Session:` URL trailer. This is stricter than `capsid/conventions.md` on one specific point: conventions names the first two, and the rule here covers ANY trailer naming the agent or linking a session, whatever it is called. It is written down because a session harness instructed the `Claude-Session:` trailer in as many words, saying it replaced earlier attribution guidance, and the session followed it. That is the failure this rule exists to stop: the instruction arrives inside the tool that does the work, so it looks like configuration rather than a policy change. **A trailer that names Claude is refused even when the harness asks for it; if a harness insists, say so in the response and commit without it.** Measured 2026-09-09: 36 of 165 commits on master already carried one, from five sessions, the oldest 2026-09-06. Scrubbing is `git filter-repo` message rewrite plus a force push (`capsid/conventions.md`, Git attribution).

## The one thing about this repo that is not in Capsid

`wrangler d1 export` fails outright on this database because of the FTS5 virtual table, so the restore path is per table:

    npx wrangler d1 export capsid --remote --no-schema --table <table> --output export-<table>.sql

Export the real tables individually (TEN since migrations/0004_improve_jti.sql added the replay cache; `TABLES` in `src/backup.ts` is the list, and test/backup.test.ts derives it from `migrations/` in both directions), take the schema from `migrations/`, and import `documents` FIRST so the FTS triggers rebuild the index. Never export `documents_fts` or its shadow tables. Full runbook, including the measured traps: `capsid/protocol-restore.md`.
