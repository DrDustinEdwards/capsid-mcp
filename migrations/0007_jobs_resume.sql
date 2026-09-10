-- BLOCKED IS NOT TERMINAL. Two counters, so a resumed job carries its own history.
--
-- WHAT WAS WRONG. `blocked` was a dead end: the only transitions into a claim were
-- from `queued`, so a job the driver blocked at a gate could never be picked back
-- up. A human ran the blocked command, the work landed, and the row still said
-- blocked with a summary describing the state before the gate. Measured 2026-09-10:
-- job_1b957927a714 shipped its work (capsid-mcp fe48a06 plus four PRs) while its row
-- claimed the push had not happened, and the driver could not correct it because
-- `claim` refuses anything that is not queued.
--
-- A gate is a PAUSE, and the queue had modelled it as an ending. `resume` moves a
-- blocked job back to claimed for the caller with a fresh lease, so the same job
-- carries its own outcome instead of a second job being posted to describe the
-- first.
--
-- WHY TWO COUNTERS RATHER THAN ONE. A job may be blocked and resumed any number of
-- times (a job with three gates hits three). blocked_count alone cannot say whether
-- the current block is the first; resumed_count alone cannot say how many gates the
-- job has hit. Deriving either from the other holds only while a job is currently
-- blocked, and a derivation that is true in one state and silently wrong in another
-- is the kind of thing that gets read as fact later. Both are counted where they
-- happen.
--
-- NOT IDEMPOTENT, unlike the migrations before it, and it does not need to be:
-- wrangler's migration tracking runs each file exactly once, and SQLite has no
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to spell it with.

ALTER TABLE jobs ADD COLUMN resumed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN blocked_count INTEGER NOT NULL DEFAULT 0;
