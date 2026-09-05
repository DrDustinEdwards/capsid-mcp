-- The self-improvement loop's own tables (the improve arc).
--
-- Four tables, one index family, and no FTS. Idempotent: applying this on an
-- already-migrated database is a no-op.
--
-- WHY THESE LIVE IN THE SAME DATABASE as documents rather than their own: the
-- loop's archive documents, its task docs and its skill docs are ordinary Capsid
-- documents written through the ordinary write path, and an attempt's row has to
-- land in the same batch as the audit_log row that records it. A second database
-- cannot join that transaction, which is the same reason the repo tools carry a
-- post-hoc audit warning and the D1-only tools do not.
--
-- COLUMNS BEYOND THE SPEC are marked with the reason they exist. Every one of
-- them is state the resumable state machine cannot reconstruct after an isolate
-- dies, which is the only test applied when deciding whether to add one.

-- Per-metric measurements. One row per (run, namespace, metric), and optionally
-- per attempt, so a run's baseline and each attempt's result are the same shape.
--
-- value is NULLABLE and that is load-bearing: a stub metric (recovery_rate,
-- dispute_win_rate) returns null until it is wired, and a null is EXCLUDED from
-- scoring rather than read as a zero. A zero would look like a catastrophic
-- regression on a maximize metric and a perfect result on a minimize one.
CREATE TABLE IF NOT EXISTS improve_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  run_id TEXT NOT NULL,
  -- NULL for a run's baseline measurement; set for an attempt's measurement.
  -- Added beyond the spec because keep/revert compares an attempt against its
  -- base, and without this column the two are indistinguishable rows.
  attempt_id TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS improve_scores_run ON improve_scores (run_id, namespace, metric);
CREATE INDEX IF NOT EXISTS improve_scores_ns ON improve_scores (namespace, metric, ts);

-- One row per attempt. Never deleted, never updated except to move an attempt
-- forward through its own lifecycle.
CREATE TABLE IF NOT EXISTS improve_attempts (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  run_id TEXT NOT NULL,
  change_summary TEXT,
  -- The archive document path, which is the durable copy of the diff and the
  -- reasoning trace. "diff_ref" rather than "diff" because a diff belongs in a
  -- document the lint loop can see, not in a column nothing can read back.
  diff_ref TEXT,
  score_before REAL,
  score_after REAL,
  kept INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  -- The attempt id this attempt branched from, or NULL for a run's first
  -- attempt, which branches from improve:best. Lineage selection reads this.
  lineage_parent TEXT,
  -- Beyond the spec, all six of them state the machine cannot rebuild:
  -- pending -> awaiting-score -> kept | reverted | flagged | timed-out
  status TEXT NOT NULL DEFAULT 'pending',
  branch TEXT,
  head_sha TEXT,
  base_sha TEXT,
  -- The monitor's verdict, kept apart from `reason` so a flagged attempt can say
  -- BOTH why it was reverted and what the monitor saw.
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_reason TEXT,
  -- The skill that proposed this attempt, so a transferred skill's win/loss can
  -- be attributed. NULL when the attempt was generated from scratch.
  skill_id TEXT,
  -- The full metric maps, as JSON, for both sides of the comparison. The two
  -- REAL columns above hold the aggregate secondary score; these hold what it
  -- was computed from, which is the only thing that makes a decision auditable.
  anchors_json TEXT,
  secondary_json TEXT,
  -- When the scorer workflow was dispatched. The 20 minute stale guard is
  -- measured from here and nowhere else.
  dispatched_at TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS improve_attempts_run ON improve_attempts (run_id, ts);
CREATE INDEX IF NOT EXISTS improve_attempts_ns ON improve_attempts (namespace, ts);
CREATE INDEX IF NOT EXISTS improve_attempts_lineage ON improve_attempts (lineage_parent);
CREATE INDEX IF NOT EXISTS improve_attempts_skill ON improve_attempts (skill_id);

-- One row per run. The state machine's whole memory lives here.
CREATE TABLE IF NOT EXISTS improve_runs (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  mode TEXT NOT NULL,
  started TEXT NOT NULL DEFAULT (datetime('now')),
  finished TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  kept INTEGER NOT NULL DEFAULT 0,
  reverts INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  -- Ruled alongside cost_usd: the loop spends two budgets and only one of them
  -- was being recorded. CI minutes are the one that runs out first on a free
  -- Actions allowance.
  ci_minutes REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'opening',
  -- Beyond the spec, and each is state a tick cannot recompute:
  -- consecutive_reverts survives across invocations, which is the whole point of
  -- the restore-after-5 rule: counting them from the attempts table would work
  -- until an attempt row is written by a tick that then dies.
  consecutive_reverts INTEGER NOT NULL DEFAULT 0,
  -- The attempt the run is currently waiting on. NULL unless awaiting-score.
  current_attempt TEXT,
  -- The commit the run started from, so a restore-to-best has somewhere to go
  -- even if KV is unreachable.
  base_sha TEXT,
  pr_url TEXT,
  -- Why the run stopped, in the run's own words. Never null on a finished run.
  note TEXT,
  -- Ruled: the experimental condition this run was executed under. 'full' is the
  -- system as designed; 'no-memory' runs without lineage history; 'no-transfer'
  -- runs without cross-project skills. Recorded on every run so an ablation is a
  -- query rather than an archaeology exercise.
  condition TEXT NOT NULL DEFAULT 'full',
  -- The tick that last advanced this run. Read by the 6 hour finalize guard.
  advanced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS improve_runs_ns ON improve_runs (namespace, started);
CREATE INDEX IF NOT EXISTS improve_runs_status ON improve_runs (status, advanced_at);

-- ONE ACTIVE RUN PER NAMESPACE, enforced by the database rather than by the
-- code that opens runs.
--
-- A partial UNIQUE index is the only mechanism here that survives two ticks
-- racing: both read "no active run", both insert, and without this one of the
-- two inserts fails instead of both succeeding. Cheap, and it makes the opener's
-- own check an optimization rather than the guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS improve_runs_one_active
  ON improve_runs (namespace)
  WHERE status NOT IN ('done', 'paused');

-- Skills abstracted out of a kept attempt, offered to every other namespace on
-- the next run. wins and losses are per skill, counted from the attempts that
-- carried its id.
CREATE TABLE IF NOT EXISTS improve_skills (
  id TEXT PRIMARY KEY,
  source_namespace TEXT NOT NULL,
  title TEXT NOT NULL,
  -- The capsid document path holding the skill's text: improve/skills/<id>.md.
  -- Same reasoning as diff_ref: the prose lives where the lint loop can see it.
  body_ref TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  -- Beyond the spec: the attempt this was abstracted from, so a skill can be
  -- traced back to the change that earned it.
  source_attempt TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS improve_skills_source ON improve_skills (source_namespace, ts);
