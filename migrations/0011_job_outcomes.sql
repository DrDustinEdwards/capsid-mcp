-- JOBS AS EVIDENCE: one outcome row per finished job.
--
-- WHAT WAS MISSING. The queue recorded that a job ended and what its driver said
-- about it, in one sentence of free text. The improve loop, next to it, records an
-- attempt row per attempt with a score, so a question like "does this driver's work
-- land" is a query there and was a reading exercise here. `result_summary` is prose
-- written by the party being measured, which is the one kind of evidence that
-- cannot be checked.
--
-- SO: a row per job, written once when the job reaches a terminal state, carrying
-- counts rather than prose. Counts compose; a sentence does not.
--
-- THE WORKER NEVER TRUSTS A COUNT IT COULD CHECK AND DID NOT. The driver reports
-- what it did; this Worker holds a GitHub App token and can ask GitHub what actually
-- happened. Where it checked, the number stored is GitHub's and the field is marked
-- verified. Where it could not check (the network was down, no pull request was
-- named), the driver's number is stored and the field is marked unverified. The
-- `verified` column is what separates the two, per field, so a reader never has to
-- guess which kind of number they are looking at. A table that mixed them would be
-- worse than no table: it would look like measurement.
--
-- NULL IS NOT ZERO, and every nullable column here exists for that distinction. A
-- job that reported no test count has `tests_added NULL`, meaning nobody said; a job
-- that added no tests has 0, meaning somebody counted and the answer was none. An
-- average over a column that spelled both as 0 would be an average over a lie.
--
-- ONE ROW PER JOB, ENFORCED BY THE PRIMARY KEY rather than by the code that writes
-- it. A job reaches a terminal state once (`complete` and `fail` are keyed updates
-- out of `claimed`), so a second insert means something went wrong upstream, and the
-- writer uses ON CONFLICT DO NOTHING so the FIRST record stands. An outcome that
-- could be rewritten after the fact is not evidence.

CREATE TABLE IF NOT EXISTS job_outcomes (
  -- The job this describes. PRIMARY KEY, so the table cannot hold two accounts of
  -- the same job. No REFERENCES clause: D1 runs with foreign keys off during
  -- migrations, and jobs is never pruned anyway, so the constraint would be a
  -- decoration that cost an index.
  job_id TEXT PRIMARY KEY,
  -- Who did the work: the actor string, `agent:<name>` | `github:<login>` |
  -- `opkey:<fingerprint>`, copied from jobs.claimed_by at the moment the job ended.
  -- Copied rather than joined because claimed_by is cleared when a lease expires,
  -- and an outcome whose author disappears on a later requeue is not a record.
  agent TEXT NOT NULL,
  namespace TEXT NOT NULL,

  -- WHAT THE WORK PRODUCED. All nullable: see NULL IS NOT ZERO above.
  --
  -- prs_opened and prs_merged are GitHub's answer whenever the driver named any
  -- pull request, because this Worker can ask. prs_merged counts the ones GitHub
  -- reports merged, which is the number that matters: a driver that opens ten pull
  -- requests nobody merged has not shipped ten changes.
  prs_opened INTEGER,
  prs_merged INTEGER,
  -- Commits and files touched. Taken from the pull requests when there are any, and
  -- from the driver otherwise.
  commits INTEGER,
  files_changed INTEGER,
  -- Driver-reported and never verifiable here: "a test was added" is a judgement
  -- about a diff, not a property of it. Stored because the driver knows and nothing
  -- else does, and marked unverified so it is read as a claim.
  tests_added INTEGER,
  -- 1, 0, or NULL for not checked. NULL is the common case and is not a failure:
  -- plenty of jobs produce no pull request and so have no head commit to ask about.
  ci_green INTEGER,

  -- How the job went, from the row rather than from anyone's report. A job on its
  -- third gate reads differently from one that sailed through, and these two are the
  -- only numbers here the Worker knows first-hand without asking anybody.
  blocked_count INTEGER NOT NULL,
  resumed_count INTEGER NOT NULL,

  -- claimed_at to recorded_at, in whole minutes. This is the FINAL working stretch,
  -- not the job's whole life: `resume` takes a fresh lease and resets claimed_at, so
  -- time a job spent blocked waiting on a human is excluded, deliberately. A human
  -- taking a day to run a command is not the driver being slow. resumed_count is the
  -- column that says whether there were earlier stretches this number omits.
  -- NULL when the job somehow had no claim timestamp to measure from.
  duration_minutes INTEGER,

  -- pr | doc | none, derived from result_ref rather than declared: a URL is a pull
  -- request, a path is a document, nothing is none.
  result_kind TEXT NOT NULL,

  -- WHICH FIELDS ABOVE THE WORKER CHECKED ITSELF, as a JSON object of booleans.
  -- JSON rather than a column per field for the same reason jobs.required_scopes is
  -- JSON: it is read as a whole by one function and never filtered on, and a column
  -- per field would be five more every time the evidence shape grows.
  verified TEXT NOT NULL,

  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The agent record's aggregation: every query in src/agent-record.ts groups by agent.
-- Carrying namespace second lets the per-namespace variant read out of the same index.
CREATE INDEX IF NOT EXISTS job_outcomes_agent ON job_outcomes (agent, namespace);

-- A JOB MAY REQUIRE A TRACK RECORD, not just a scope.
--
-- migrations/0009 let a job say which SCOPES its work needs, which is a question
-- about what a driver is permitted to do. This is the other question: what has this
-- driver actually done. Some work should not go to a credential that has never had a
-- pull request merged, and until now the queue had no way to say so.
--
-- CHECKED AGAINST THE SAME agent_record THE CONSOLE SHOWS (src/agent-record.ts), so
-- the bar a claim is measured against is the number a human can read on the page. A
-- second computation for the gate would be a gate nobody could audit.
--
-- JSON, and NULL MEANS NO REQUIREMENT, on the same reasoning as required_scopes: it
-- is read whole by one function, never filtered on, and most jobs require nothing.
--
-- NOT IDEMPOTENT, like 0007 and 0009: wrangler runs each migration file exactly once
-- and SQLite has no ADD COLUMN IF NOT EXISTS to spell it with. It rides in this file
-- rather than a 0012 of its own because it is the same arc: an outcome table nobody
-- can require anything of is a table that only gets read when somebody remembers to.
ALTER TABLE jobs ADD COLUMN min_record TEXT;
