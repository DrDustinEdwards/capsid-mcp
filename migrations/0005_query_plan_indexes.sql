-- COVERED INDEXES FOR THE SCANS D1 ACTUALLY REPORTS, audit 2026-09-07.
--
-- Every read in src/ was run through EXPLAIN QUERY PLAN against the real schema
-- (test-integration/query-plans.test.ts, which walks the statements out of the
-- source rather than from a list). Six of them scanned a table with no index on
-- the column they filter or order by, and all six are on tables that grow without
-- bound. The rest of the SCAN lines are index scans, the FTS virtual table, or the
-- backup dump reading a whole table on purpose; those stay.
--
-- WHY THIS MATTERS MORE THAN IT LOOKS. `document_versions` went 25.5MB to 53.9MB
-- in the 23 days to 2026-09-07 and has never been pruned; `audit_log` grows with
-- every write this Worker has ever made. Neither table had a single index. The
-- worst of the six is `lastActor`, which runs on EVERY `read` and once per row of
-- every `brief`, and was a full scan of audit_log each time.

-- 1. lastActor: SELECT actor FROM audit_log WHERE namespace = ?1 AND path = ?2
--    ORDER BY id DESC LIMIT 1. The hottest read in the store, and it was scanning
--    the largest append-only table in it. `id DESC` is part of the index so the
--    LIMIT 1 stops at the first entry instead of sorting what it found.
CREATE INDEX IF NOT EXISTS audit_log_doc ON audit_log (namespace, path, id DESC);

-- 2. The nightly prune: SELECT COUNT(*) ... WHERE at < datetime('now', ?1), then
--    the DELETE with the same predicate. Ran twice a night over every audit row
--    ever written.
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at);

-- 3. history and restore: both address a snapshot by (namespace, path) and want
--    the newest first. Same shape as audit_log_doc and the same reason for the
--    DESC.
CREATE INDEX IF NOT EXISTS document_versions_doc ON document_versions (namespace, path, id DESC);

-- 4. The other half of the nightly prune, on the table that is doubling every
--    three weeks. This is also the index that decides whether the first real prune
--    (about 2026-10-04, against a projected 87MB) fits inside the CPU ceiling.
CREATE INDEX IF NOT EXISTS document_versions_snapshot ON document_versions (snapshot_at);

-- 5. The budget check, which runs on every opener and every tick:
--    SELECT SUM(cost_usd), SUM(ci_minutes) FROM improve_runs WHERE started >= ?1.
--    improve_runs_ns is (namespace, started) and this query has no namespace, so
--    it could not use it.
CREATE INDEX IF NOT EXISTS improve_runs_started ON improve_runs (started);

-- 6. The cross-project skill offer: WHERE source_namespace != ?1 ORDER BY ts DESC
--    LIMIT 200. The inequality cannot use improve_skills_source, so the ordering
--    was a sort over the whole table. This index lets the LIMIT stop early.
CREATE INDEX IF NOT EXISTS improve_skills_ts ON improve_skills (ts DESC);
