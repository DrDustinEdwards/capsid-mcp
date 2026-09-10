-- The work queue: one table, three indexes, no FTS. Idempotent.
--
-- WHAT IT IS FOR. The ruling seat posts work from a chat; a driver session on a
-- machine claims it, does it, and reports back. Before this there was no handoff
-- that survived a session ending: a plan lived in a task document nobody had
-- claimed, and two sessions reading the same document both did the work.
--
-- THE TABLE IS THE SOURCE OF TRUTH FOR STATUS, and the mirrored document is not.
-- Every job also lands at <namespace>/jobs/<id>.md so brief and search can see it,
-- which is what makes a queued job findable from a chat that has never called the
-- jobs tool. A document is text and a status is a state machine; keeping the state
-- in the row means two claims cannot both win by writing prose.
--
-- LEASES, NOT LOCKS. A claim sets lease_expires four hours out. The five-minute
-- improve tick returns an expired claim to queued, so a driver that dies mid-job
-- costs one lease rather than a job nobody can ever pick up. Same reasoning as the
-- improve driver lease in APP_KV, and the opposite implementation: that one is
-- best-effort because KV has no compare-and-set, and this one is a keyed UPDATE
-- with RETURNING, so exactly one claimer wins.

CREATE TABLE IF NOT EXISTS jobs (
  -- A caller-visible handle, minted by the Worker: job_<12 hex>. Not an
  -- AUTOINCREMENT integer, because a job id is quoted in chat and in a commit
  -- message, and a guessable sequence invites addressing a job by arithmetic.
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  title TEXT NOT NULL,
  -- The full prompt the driver executes, signed by post. See improve-task.ts.
  body TEXT NOT NULL,
  -- Higher runs first. A plain integer, because the ordering question is only ever
  -- "which of these two" and a scheme with more range invites tuning it.
  priority INTEGER NOT NULL DEFAULT 0,
  -- queued | claimed | done | failed | blocked. Enforced in src/jobs-schema.ts and
  -- asserted against this comment by test/jobs.test.ts, in both directions.
  status TEXT NOT NULL DEFAULT 'queued',
  -- The actor that posted it and the actor that holds it: "github:<login>" for an
  -- OAuth session, "opkey:<fingerprint>" for an operator key. Same shape as
  -- audit_log.actor, so one query joins a job to what its driver did.
  posted_by TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  lease_expires TEXT,
  -- Where the work landed: a document key or a PR URL. Free text on purpose, since
  -- a result can be either and refusing one of them would push it into the summary.
  result_ref TEXT,
  result_summary TEXT,
  -- The job is known in advance to hit something a human must confirm (a push, a
  -- deploy, a secret). The driver stops at it rather than discovering the gate
  -- halfway through.
  gate_required INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ONE OPEN JOB PER (namespace, title). PARTIAL, so the same title can be posted
-- again once the last one finished: a job called "run the lint loop" is a thing
-- that recurs, and a unique index over every row would make the second one
-- impossible. Over queued and claimed only, so a double post while one is still
-- open is a refusal rather than two drivers doing the same work.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_open_title ON jobs (namespace, title) WHERE status IN ('queued', 'claimed');

-- The claim query: highest priority first, oldest first within a priority.
CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (namespace, status, priority DESC, created_at);

-- The tick's expiry sweep, which has no namespace: WHERE status = 'claimed' AND
-- lease_expires < datetime('now').
CREATE INDEX IF NOT EXISTS jobs_lease ON jobs (status, lease_expires);
