-- SKILL ATTRIBUTION AND FAILURE MEMORY: what was offered, what was used, and what
-- went wrong afterwards.
--
-- 0012 gave a skill a lifecycle and the evidence to move through it. This gives the
-- lifecycle its INPUT. Two halves, and they are in one migration because neither is
-- any use alone: a record of what was offered with no record of what happened is a
-- log, and a record of failures with nothing to attribute them to is a list.
--
-- WHY OFFERED AND USED ARE BOTH STORED, when storing "used" alone would be smaller.
-- The gap between them is the measurement. A skill offered fifty times and used twice
-- is not a skill that failed, it is a skill whose trigger condition does not describe
-- the work it is being matched to, and those are different problems with different
-- fixes. SkillsVote (arXiv 2605.18401) is the result this follows: credit only what
-- was used, and keep the offered count so the recommend step can be judged separately
-- from the skills it recommends.

-- ---- what the recommend step offered, and what the driver actually used --------
--
-- Both JSON arrays of skill ids, both nullable. NULL is not an empty array: NULL means
-- this job predates the recommend step or ran without it, and [] means skills were
-- considered and none matched. An average over a column that spelled both as [] would
-- be an average over a lie, which is the same distinction 0011 drew for its counts.
--
-- NOT IDEMPOTENT, like 0007, 0009, 0011 and 0012: wrangler runs each migration file
-- exactly once and SQLite has no ADD COLUMN IF NOT EXISTS.
ALTER TABLE job_outcomes ADD COLUMN skill_ids_offered TEXT;
ALTER TABLE job_outcomes ADD COLUMN skill_ids_used TEXT;

-- ---- failure memory ------------------------------------------------------------
--
-- A note per reverted attempt and per failed job, linked to the skills that were in
-- use at the time. The recommend step attaches the two most recent notes for each
-- skill it offers, so a driver about to follow a skill sees how it went wrong the last
-- two times before it follows it.
--
-- THIS IS NOT A SECOND SCORE. Nothing here moves a skill's status: only an evaluation
-- does that, and a failure note is prose about one run. It exists so the next driver
-- reads the failure rather than repeating it, which is the optimizer-memory half of
-- SkillOpt (arXiv 2605.23904) applied to the driver rather than to the editor.
CREATE TABLE IF NOT EXISTS skill_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill TEXT NOT NULL,
  namespace TEXT NOT NULL,
  -- attempt | job. Which kind of run produced this, because the two are read from
  -- different tables and a note that did not say would send its reader to the wrong
  -- one.
  source_kind TEXT NOT NULL,
  -- The attempt id or the job id. Not a foreign key, on the same reasoning as
  -- job_outcomes: D1 runs with foreign keys off during migrations and neither table
  -- is pruned.
  source_id TEXT NOT NULL,
  -- What went wrong, in a sentence or two. Written by the driver, and read by the
  -- next one rather than counted, so it is prose on purpose.
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The recommend step's query: this skill's notes, newest first, bounded to two.
CREATE INDEX IF NOT EXISTS skill_failures_skill ON skill_failures (skill, created_at DESC);
