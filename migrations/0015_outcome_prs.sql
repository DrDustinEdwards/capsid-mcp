-- OUTCOME ROWS ARE IMMUTABLE EXCEPT MERGE STATE, WHICH IS RE-VERIFIED FROM GITHUB.
--
-- THE DEFECT. An outcome row records a pull request's merge state at the moment the
-- driver calls `complete`. A driver never merges: it blocks, and the seat merges
-- afterwards, so at complete time the honest answer is always "opened, not merged".
-- The row then stands forever, and every driver's prs_merged and pr_merge_rate
-- undercount permanently. Measured: claude-skills-driver reads 5 opened and 0 merged
-- with two of them merged.
--
-- WHY THIS IS NOT A HOLE IN THE IMMUTABILITY RULE. migrations/0011 made an outcome
-- write-once because it is evidence and evidence that can be rewritten after the fact
-- is not evidence. That still holds for every field describing what the driver DID.
-- Merge state is different in kind: it is a fact about the world that changes after
-- the row is written, and the row was never wrong, it was early. So one narrow path
-- updates one field, from GitHub rather than from anybody's report, and records when
-- it looked.
--
-- WHY A JOIN TABLE. The evidence a driver reports names pull request URLs, and until
-- now those URLs were read once during verification and thrown away: the row kept
-- counts and no way to get back to what they counted. Re-verification needs to go
-- from a merged pull request to the rows that named it, which is a lookup nothing
-- could serve. One row per (job, pull request) is that index, and it also makes the
-- evidence itself inspectable, which the counts alone never were.
CREATE TABLE IF NOT EXISTS job_outcome_prs (
  -- The outcome this pull request was evidence for. Not a foreign key, on the same
  -- reasoning as job_outcomes: D1 runs with foreign keys off during migrations and
  -- neither table is pruned.
  job_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  -- 1 merged, 0 closed or still open, NULL never checked. THREE STATES, and the third
  -- is the one that matters: a row written at complete time when GitHub was
  -- unreachable has never been looked at, and storing that as 0 would make it
  -- indistinguishable from a pull request somebody closed.
  merged INTEGER,
  -- When the merge state above was last read from GitHub. NULL while merged is NULL.
  -- This is what bounds the re-verification sweep: a row checked recently is not
  -- checked again, and a row that has never been checked sorts first.
  merge_verified_at TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- One row per pull request per job. A job naming the same pull request twice is a
  -- driver repeating itself, not two pieces of evidence.
  PRIMARY KEY (job_id, pr_url)
);

-- The merge path's lookup: given a pull request that just merged, which outcome rows
-- named it. This is the query the whole table exists to serve.
CREATE INDEX IF NOT EXISTS job_outcome_prs_url ON job_outcome_prs (pr_url);

-- The sweep's lookup: what has never been checked, or was checked longest ago.
CREATE INDEX IF NOT EXISTS job_outcome_prs_stale ON job_outcome_prs (merged, merge_verified_at);
