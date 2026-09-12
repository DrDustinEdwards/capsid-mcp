-- THE INDEX THE SKILL LIFECYCLE'S TWO HOT READS NEED.
--
-- Caught by the integration suite's query-plan guard rather than by review: both of
-- the reads added with migrations 0012 and 0013 filter `improve_skills` by status and
-- both planned as a full table scan.
--
--   improve-run.ts     SELECT status, COUNT(*) ... GROUP BY status     (the console and
--                      improve_status summary, once per namespace per call)
--   skills-records.ts  SELECT id, status, version WHERE status IN (...)  (every
--                      evaluation cycle)
--
-- A scan is harmless on a table with six rows and is the kind of thing that stops
-- being harmless quietly, which is why the guard fails on the PLAN rather than on a
-- measured duration: by the time a scan is slow enough to measure, it is in production.
--
-- STATUS FIRST, then version, because both queries filter on status and the second
-- also reads version. The summary's GROUP BY status is served by the same index.
--
-- NOT the namespaces column: it is matched with LIKE against a JSON array, which no
-- index can serve, and the filter is there to scope a summary rather than to find a
-- row. Narrowing by status first is what makes that comparison cheap.
CREATE INDEX IF NOT EXISTS improve_skills_status ON improve_skills (status, version);

-- THE OTHER TWO READS the same guard caught: "has this source already produced a
-- skill", asked once per candidate the loop considers writing. Both are point lookups
-- on a column with no index, so both planned as a scan.
--
-- Two indexes rather than one composite, because the two columns are alternatives and
-- never queried together: a skill comes from an attempt or from a job, and the query
-- names exactly one. A composite on (source_attempt, source_job) would serve the first
-- lookup and scan for the second.
--
-- This check is what stops a skill retired for not helping being abstracted again from
-- the same source on the next pass, so it runs often enough to be worth the two
-- indexes.
CREATE INDEX IF NOT EXISTS improve_skills_source_attempt ON improve_skills (source_attempt);
CREATE INDEX IF NOT EXISTS improve_skills_source_job ON improve_skills (source_job);
