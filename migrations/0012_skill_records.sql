-- SKILL RECORDS: a lifecycle driven by evidence rather than by a driver's opinion
-- of its own run.
--
-- WHAT WAS MISSING. improve_skills (migrations/0003) already held a skill per row
-- with a wins and losses counter, incremented when an attempt that was offered the
-- skill was kept or reverted. That is one number, and it conflates three different
-- things: a skill that was offered and used and helped, a skill that was offered and
-- ignored while the attempt succeeded anyway, and a skill that was used in a run that
-- failed for reasons having nothing to do with it. A counter that moves on all three
-- cannot answer whether the skill is any good.
--
-- SO, TWO TABLES AND SOME COLUMNS, and the shape follows two published results the
-- job named. From SkillOpt (arXiv 2605.23904): enough evidence before an edit,
-- bounded edits, rejected edits kept as negative feedback, slow update, optimizer
-- memory. From SkillsVote (arXiv 2605.18401): credit a skill only when it was
-- actually used AND the verifier says the run succeeded.
--
-- THE RULE THE WHOLE ARC RESTS ON: a skill's status changes on EVALUATION EVIDENCE
-- and never on a driver's judgement of its own run. Two evaluations minimum for any
-- transition, in either direction. One good result is noise, and a system that
-- promoted on one would spend its life promoting and retiring the same skill.

-- ---- the L1 fields a skill package declares ---------------------------------
--
-- These live on the row as well as in the repo's SKILL.md frontmatter, because the
-- Worker matches triggers and enforces status without cloning a repository. The repo
-- copy is the reviewable source; these are what the Worker reads, the same split the
-- policy documents use.
--
-- NOT IDEMPOTENT, like 0007, 0009 and 0011: wrangler runs each migration file exactly
-- once and SQLite has no ADD COLUMN IF NOT EXISTS.

-- 1, 2, 3. Bumped by an accepted bounded edit and by nothing else, so a version is a
-- count of edits that survived evaluation rather than a label somebody chose.
ALTER TABLE improve_skills ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- candidate | live | retired. EVERY SKILL STARTS candidate, including one abstracted
-- from an attempt that was kept: being born of a success is not evidence that the
-- WRITTEN FORM of the idea helps anybody else, which is the only thing an evaluation
-- measures.
--
-- retired rows are KEPT, with their whole record. Two reasons, and the second is the
-- one that is easy to miss: a retired skill is evidence about what does not work, and
-- it is shown to the creator so the same idea is not abstracted again from the same
-- source next month.
ALTER TABLE improve_skills ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate';

-- When it left live. NULL while it has not.
ALTER TABLE improve_skills ADD COLUMN retired_at TEXT;

-- The trigger condition, in prose. Matched by FTS when the recommend step asks which
-- skills are worth offering for a piece of work. Nullable because the rows that
-- predate this migration have none and inventing one would be fabricating the field
-- the match runs on.
ALTER TABLE improve_skills ADD COLUMN trigger_condition TEXT;

-- Which namespaces the skill claims to apply to, as a JSON array, or NULL for any.
-- JSON on the same reasoning as jobs.required_scopes: read whole by one function,
-- never filtered on.
ALTER TABLE improve_skills ADD COLUMN namespaces TEXT;

-- HOW A READER KNOWS THE SKILL IS DONE, and how it composes with another. Both are
-- required L1 fields of the package format and both are stored, because a skill whose
-- termination test lives only in a repo file is one the Worker cannot check it has.
ALTER TABLE improve_skills ADD COLUMN termination_test TEXT;
ALTER TABLE improve_skills ADD COLUMN composition_interface TEXT;

-- The job a skill was written from, when it came from a verified job outcome rather
-- than from a kept loop attempt. source_attempt already covers the other case, and
-- the pair is how a retired skill is traced back to the thing that produced it so it
-- is not produced again.
ALTER TABLE improve_skills ADD COLUMN source_job TEXT;

-- ---- evaluations -------------------------------------------------------------
--
-- One row per skill per evaluation cycle. The cycle runs the namespace's probe set in
-- the scorer sandbox twice, with the skill and without it, and `delta` is the
-- difference. A status change reads these rows and nothing else.
CREATE TABLE IF NOT EXISTS skill_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill TEXT NOT NULL,
  -- The version evaluated. An evaluation of version 2 says nothing about version 3,
  -- so a transition counts rows at the CURRENT version and a bump starts the count
  -- again. That is the slow-update rule: an edit costs the skill its accumulated
  -- evidence, which is why edits are bounded and rare.
  version INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  -- Which probe set produced this number. A delta measured against a different probe
  -- set is not comparable, so a transition counts rows sharing one version.
  probe_set_version TEXT NOT NULL,
  -- With-skill minus without-skill. Positive is an improvement. REAL because scores
  -- are weighted sums, not counts.
  delta REAL NOT NULL,
  -- How many paired runs the delta averages. One run is a sample, not a measurement;
  -- this is recorded so a reader can tell the difference.
  runs INTEGER NOT NULL,
  -- positive | neutral | negative, derived from delta at write time and stored, so a
  -- later change to the threshold cannot silently restate old evaluations as
  -- something they were not.
  verdict TEXT NOT NULL,
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The transition query: every row for one skill at one version, newest first.
CREATE INDEX IF NOT EXISTS skill_evaluations_skill ON skill_evaluations (skill, version, evaluated_at DESC);

-- ---- edits -------------------------------------------------------------------
--
-- One row per PROPOSED edit, accepted or not. The rejected ones are the point: an
-- optimizer that cannot see what was already tried and refused proposes it again, and
-- these rows are the memory that stops that. Nothing here is ever deleted.
CREATE TABLE IF NOT EXISTS skill_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  -- The version this edit would produce. Equal to from_version + 1 for an accepted
  -- edit; recorded for a rejected one too, so the row reads the same either way.
  to_version INTEGER NOT NULL,
  -- The add, delete and replace operations, as a JSON array. Stored verbatim, because
  -- the next optimizer run is shown what was proposed and not a summary of it.
  ops TEXT NOT NULL,
  -- 1 or 0. An edit is accepted only on STRICT improvement against the probe set: a
  -- tie is a rejection, because an edit that changes nothing measurable still costs
  -- the skill its accumulated evaluations.
  accepted INTEGER NOT NULL,
  -- Why, in a sentence. For a rejection this is what the next optimizer reads.
  reason TEXT NOT NULL,
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the optimizer is handed before it proposes: this skill's rejected edits,
-- newest first.
CREATE INDEX IF NOT EXISTS skill_edits_skill ON skill_edits (skill, accepted, evaluated_at DESC);
