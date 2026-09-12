# Backups and restore

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

   Create the new database and apply every migration in order: `0001_init.sql`, `0002_document_links.sql`, `0003_improve.sql`, `0004_improve_jti.sql`, `0005_query_plan_indexes.sql`, `0006_jobs.sql`, `0007_jobs_resume.sql`, `0008_agents.sql`, `0009_jobs_required_scopes.sql`, `0010_console_indexes.sql`, `0011_job_outcomes.sql`, `0012_skill_records.sql`, `0013_skill_attribution.sql`, `0014_skill_status_index.sql`, `0015_outcome_prs.sql`, `0016_jobs_retry_cap.sql`, `0017_jobs_review.sql`. Stopping early leaves later tables missing for the import to land in, and a column the code reads absent from a table that does exist. Then execute the exports with `documents` first: importing it fires the FTS sync triggers, so `documents_fts` rebuilds itself. The rest have no triggers and no foreign keys, so their order does not matter. Verify with count queries against both databases and one MATCH query on the new one, then point `wrangler.jsonc` at the new `database_id` and deploy.

3. **The R2 JSON dump**, beyond the 30-day Time Travel window. Wrangler cannot list R2 objects, so take the exact keys from the Cloudflare dashboard or the `json_keys` field of a `/ops/backup` response, then fetch each: `wrangler r2 object get capsid-media/backups/json/<timestamp>/<table>.json --file <table>.json`. Convert each object's `rows` to INSERT statements and follow path 2 from the create step, `documents` first. The same dumps are mirrored off-account in `capsid-backups`, so this path works if the Cloudflare account is gone. The `backups/markdown/` mirror is the last-resort human-readable copy: bodies only, no metadata.

   Two underscore-prefixed sidecars ride beside the tables and neither is D1, so a restore that rebuilds the database and stops is incomplete:

   - `_kv.json` holds the loop's control pins, by allowlist: `improve_mode`, `improve:budget`, `improve:meta:last`, `backup:last-ok`, and per roster namespace its best record, pause reason and anchor checksum. Put them back with `wrangler kv key put` before turning the loop on, or every namespace runs unanchored. This is not a prefix sweep of `APP_KV`: that namespace also holds cached GitHub installation tokens, and a dump leaves the account.
   - `_holdout-manifests.json` holds each namespace's hidden-suite count, never a test. Without it every namespace scores as "no holdout manifest", which the scorer refuses.

   The dump is written as a single D1 batch, so its tables describe one instant. `scripts/restore-rehearsal.mjs` checks that weekly and refuses a torn one.

Recovering one document rarely needs any of this: read its latest `document_versions` snapshot back.
