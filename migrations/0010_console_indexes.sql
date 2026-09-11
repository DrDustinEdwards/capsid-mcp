-- The console's reads of audit_log, indexed.
--
-- PR #20 went red on test-integration/query-plans.test.ts with three bare scans of
-- audit_log. Reading the plans by hand found the guard was UNDERSTATING it: the
-- statement walker substitutes an optional `${clause}` with `WHERE 1 = 1` on the
-- stated assumption that "an optional filter can only narrow the scan the plan
-- reports", and that is false here. Measured before this migration:
--
--   activity, no filter     SCAN audit_log
--   activity, by namespace  SEARCH audit_log USING INDEX audit_log_doc (namespace=?)
--                           USE TEMP B-TREE FOR ORDER BY      <-- sorts every row
--   activity, by actor      SCAN audit_log                     <-- whole table
--   prs opened              SCAN audit_log + TEMP B-TREE FOR GROUP BY
--   prs merged              SCAN audit_log + TEMP B-TREE FOR GROUP BY
--
-- The two the guard could not see (the filtered variants) are the expensive ones: a
-- namespace filter found its rows through audit_log_doc and then SORTED ALL OF THEM
-- to take the newest 50, because that index is (namespace, path, id DESC) and `path`
-- is unconstrained here, so its id ordering is unreachable.
--
-- WHAT IS DELIBERATELY NOT FIXED HERE: the unfiltered read still reports
-- `SCAN audit_log`, and that one is correct as it stands. With no WHERE and
-- `ORDER BY id DESC LIMIT 50`, SQLite walks the rowid b-tree backwards and stops at
-- 50 rows; the plan carries no TEMP B-TREE, so nothing is sorted. It reads LIMIT
-- rows, not the table, and no index improves on that. It is named in
-- WHOLE_TABLE_BY_DESIGN in the guard, with that reason.

-- console-reputation.ts: the two per-actor aggregations, both filtering on `action`
-- and grouping by `actor`. Leading with `action` makes the filter a SEARCH; carrying
-- `actor` second lets the GROUP BY read out in index order instead of building a
-- temporary b-tree.
CREATE INDEX IF NOT EXISTS audit_log_action_actor ON audit_log (action, actor);

-- console-activity.ts, filtered by actor. `id DESC` inside the index is what makes
-- the LIMIT stop at the first rows rather than sorting what it found, the same
-- reasoning 0005 recorded for audit_log_doc.
CREATE INDEX IF NOT EXISTS audit_log_actor_recent ON audit_log (actor, id DESC);

-- console-activity.ts, filtered by namespace. NOT served by audit_log_doc: that
-- index is (namespace, path, id DESC), and with `path` unconstrained SQLite cannot
-- use its trailing id order, which is exactly where the TEMP B-TREE came from.
CREATE INDEX IF NOT EXISTS audit_log_ns_recent ON audit_log (namespace, id DESC);
