import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_EDIT_FRACTION,
  MERGE_DIFFERENCE_THRESHOLD,
  MIN_EVALUATIONS,
  acceptEdit,
  attribute,
  bodyDifference,
  isSkillStatus,
  isVerdict,
  nextStatus,
  shouldProposeMerge,
  triggersOverlap,
  verdictFor,
  withinEditBound,
  type Evaluation,
  type SkillStatus,
} from "../src/skills-lifecycle.ts";

// THE SKILL RECORD LIFECYCLE. Status changes on evaluation evidence and never on a
// driver's judgement of its own run, so every test here drives a rule to its refusal.

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0012_skill_records.sql"), "utf8");

function evaluation(over: Partial<Evaluation> = {}): Evaluation {
  return {
    skill: "skill_1",
    version: 1,
    namespace: "capsid",
    probe_set_version: "p1",
    delta: 0.05,
    runs: 5,
    verdict: "positive",
    evaluated_at: "2026-09-12T00:00:00Z",
    ...over,
  };
}

const at = (n: number) => `2026-09-${String(10 + n).padStart(2, "0")}T00:00:00Z`;

// ---- the minimum-evidence rule, in both directions -----------------------------

test("one positive evaluation cannot promote a candidate", () => {
  const verdict = nextStatus("candidate", 1, [evaluation({ evaluated_at: at(1) })]);
  assert.equal(verdict.change, false);
  assert.match(verdict.reason, /needs 2/);
});

test("two positive evaluations promote a candidate to live", () => {
  const verdict = nextStatus("candidate", 1, [
    evaluation({ evaluated_at: at(1) }),
    evaluation({ evaluated_at: at(2) }),
  ]);
  assert.equal(verdict.change, true);
  assert.equal(verdict.change && verdict.to, "live");
});

test("two evaluations that are not both positive do not promote", () => {
  for (const second of ["neutral", "negative"] as const) {
    const verdict = nextStatus("candidate", 1, [
      evaluation({ evaluated_at: at(1) }),
      evaluation({ evaluated_at: at(2), verdict: second, delta: second === "neutral" ? 0 : -0.1 }),
    ]);
    assert.equal(verdict.change, false, `positive then ${second} must not promote`);
  }
});

test("one non-positive evaluation cannot retire a live skill", () => {
  const verdict = nextStatus("live", 1, [evaluation({ evaluated_at: at(1), verdict: "negative", delta: -0.2 })]);
  assert.equal(verdict.change, false);
});

test("two consecutive non-positive evaluations retire a live skill", () => {
  const verdict = nextStatus("live", 1, [
    evaluation({ evaluated_at: at(1), verdict: "negative", delta: -0.1 }),
    evaluation({ evaluated_at: at(2), verdict: "neutral", delta: 0 }),
  ]);
  assert.equal(verdict.change, true);
  assert.equal(verdict.change && verdict.to, "retired");
});

test("a live skill that alternates is doing something and is not retired", () => {
  // negative, positive, negative: three non-positive-ish results but not two in a
  // row at the newest end. Retirement asks for a RUN of not helping.
  const verdict = nextStatus("live", 1, [
    evaluation({ evaluated_at: at(1), verdict: "negative", delta: -0.1 }),
    evaluation({ evaluated_at: at(2), verdict: "positive" }),
    evaluation({ evaluated_at: at(3), verdict: "negative", delta: -0.1 }),
  ]);
  assert.equal(verdict.change, false, "one recent negative after a positive is not a run");
});

test("evaluations are counted at one version, so an edit resets the evidence", () => {
  // Two positives at version 1, and the skill is now version 2. The old rows say
  // nothing about the new body.
  const history = [evaluation({ evaluated_at: at(1) }), evaluation({ evaluated_at: at(2) })];
  assert.equal(nextStatus("candidate", 1, history).change, true, "at version 1 they promote");
  assert.equal(nextStatus("candidate", 2, history).change, false, "at version 2 they count for nothing");
});

test("deltas from different probe sets are not mixed", () => {
  const verdict = nextStatus("candidate", 1, [
    evaluation({ evaluated_at: at(1), probe_set_version: "p1" }),
    evaluation({ evaluated_at: at(2), probe_set_version: "p2" }),
  ]);
  assert.equal(verdict.change, false);
  assert.match(verdict.reason, /not comparable/);
});

test("a retired skill stays retired, and its record is kept", () => {
  const verdict = nextStatus("retired", 1, [
    evaluation({ evaluated_at: at(1) }),
    evaluation({ evaluated_at: at(2) }),
  ]);
  assert.equal(verdict.change, false);
  assert.match(verdict.reason, /stays retired/);
});

test("verdictFor calls a tie neutral rather than positive", () => {
  assert.equal(verdictFor(0.01), "positive");
  assert.equal(verdictFor(0), "neutral");
  assert.equal(verdictFor(-0.01), "negative");
});

// ---- bounded edits --------------------------------------------------------------

const BODY_20 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

test("an edit within the bound is allowed and reports what it touched", () => {
  const verdict = withinEditBound(BODY_20, [
    { op: "replace", line: 3, text: "x" },
    { op: "replace", line: 4, text: "y" },
  ]);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.allowed, 4, "20 percent of 20 lines is 4");
  assert.equal(verdict.ok && verdict.touched, 2);
});

test("an edit over 20 percent is refused", () => {
  const ops = [1, 2, 3, 4, 5].map((line) => ({ op: "replace" as const, line, text: "x" }));
  const verdict = withinEditBound(BODY_20, ops);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.reason, /touches 5 of 20 lines and the bound is 4/);
});

test("several operations on one line count as one line", () => {
  const verdict = withinEditBound(BODY_20, [
    { op: "replace", line: 7, text: "a" },
    { op: "replace", line: 7, text: "b" },
    { op: "add", line: 7, text: "c" },
  ]);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.touched, 1);
});

test("a short skill is still editable, and an empty edit is refused", () => {
  const short = "one\ntwo\nthree";
  assert.equal(withinEditBound(short, [{ op: "replace", line: 1, text: "x" }]).ok, true, "at least one line is always allowed");
  assert.equal(withinEditBound(short, []).ok, false);
});

test("an operation naming a line outside the body is refused", () => {
  const verdict = withinEditBound(BODY_20, [{ op: "replace", line: 40, text: "x" }]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.reason, /outside the 20-line body/);
});

test("an edit is accepted only on strict improvement, and a tie is a rejection", () => {
  assert.equal(acceptEdit(0.1, 0.2).accepted, true);
  assert.equal(acceptEdit(0.1, 0.1).accepted, false);
  assert.match(acceptEdit(0.1, 0.1).reason, /tie is a rejection/);
  assert.equal(acceptEdit(0.1, 0.05).accepted, false);
});

// ---- attribution ----------------------------------------------------------------

test("attribution ignores improvised success", () => {
  const verdict = attribute(true, "improvised");
  assert.equal(verdict.credit, "none");
  assert.match(verdict.reason, /not the skill's/);
});

test("an offered but unused skill earns nothing either way", () => {
  for (const signal of ["verified-success", "verified-failure", "improvised", "environment-failure"] as const) {
    assert.equal(attribute(false, signal).credit, "none", `unused must earn nothing on ${signal}`);
  }
});

test("a used skill earns a win only when the verifier reports success", () => {
  assert.equal(attribute(true, "verified-success").credit, "win");
  assert.equal(attribute(true, "verified-failure").credit, "loss");
});

test("an environment failure is not charged to the skill", () => {
  // A checkout that failed would otherwise retire every skill that happened to be
  // used during an outage.
  assert.equal(attribute(true, "environment-failure").credit, "none");
});

// ---- merging --------------------------------------------------------------------

test("two live skills with overlapping triggers and near-identical bodies are proposed for merge", () => {
  const body = Array.from({ length: 20 }, (_, i) => `step ${i}`).join("\n");
  const nearly = body.replace("step 19", "step nineteen");
  const verdict = shouldProposeMerge(
    { status: "live", trigger: "a slow database query in a loader", body },
    { status: "live", trigger: "slow database query inside a loader", body: nearly }
  );
  assert.equal(verdict.merge, true);
});

test("bodies that differ at or above the threshold are saying different things", () => {
  const body = Array.from({ length: 10 }, (_, i) => `step ${i}`).join("\n");
  const changed = body.split("\n").map((l, i) => (i < 3 ? `${l} rewritten` : l)).join("\n");
  assert.ok(bodyDifference(body, changed) >= MERGE_DIFFERENCE_THRESHOLD);
  const verdict = shouldProposeMerge(
    { status: "live", trigger: "a slow query", body },
    { status: "live", trigger: "a slow query", body: changed }
  );
  assert.equal(verdict.merge, false);
});

test("a candidate or a retired skill is never merged", () => {
  const body = "one\ntwo";
  for (const status of ["candidate", "retired"] as SkillStatus[]) {
    const verdict = shouldProposeMerge(
      { status, trigger: "a slow query", body },
      { status: "live", trigger: "a slow query", body }
    );
    assert.equal(verdict.merge, false, `${status} must not merge`);
  }
});

test("non-overlapping triggers are not merged however similar the bodies", () => {
  const body = "one\ntwo\nthree";
  const verdict = shouldProposeMerge(
    { status: "live", trigger: "a slow database query", body },
    { status: "live", trigger: "an accessibility label missing", body }
  );
  assert.equal(verdict.merge, false);
  assert.match(verdict.reason, /do not overlap/);
});

test("triggersOverlap is word-based, so the same situation spelled differently matches", () => {
  assert.equal(triggersOverlap("a slow database query in a loader", "slow database query inside a loader"), true);
  assert.equal(triggersOverlap("a slow database query", "a missing aria label"), false);
  assert.equal(triggersOverlap("", "a slow database query"), false);
});

// ---- the migration --------------------------------------------------------------

test("migration 0012 creates both tables and every column the rules read", () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS skill_evaluations/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS skill_edits/);
  for (const column of ["probe_set_version", "delta", "runs", "verdict"]) {
    assert.match(MIGRATION, new RegExp(`\\b${column}\\b`), `skill_evaluations needs ${column}`);
  }
  for (const column of ["from_version", "to_version", "ops", "accepted", "reason"]) {
    assert.match(MIGRATION, new RegExp(`\\b${column}\\b`), `skill_edits needs ${column}`);
  }
  for (const column of ["version", "status", "trigger_condition", "termination_test", "composition_interface", "source_job"]) {
    assert.match(MIGRATION, new RegExp(`ADD COLUMN ${column}\\b`), `improve_skills needs ${column}`);
  }
});

test("a new skill is a candidate by default, in the schema rather than only in code", () => {
  assert.match(MIGRATION, /ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate'/);
  assert.match(MIGRATION, /ADD COLUMN version INTEGER NOT NULL DEFAULT 1/);
});

test("the constants the migration comments describe are the constants the code uses", () => {
  assert.equal(MIN_EVALUATIONS, 2);
  assert.equal(MAX_EDIT_FRACTION, 0.2);
  assert.match(MIGRATION, /Two evaluations minimum/i);
});

// ---- the stored vocabularies ----------------------------------------------------

test("an unknown status or verdict is refused rather than coerced", () => {
  // A row carrying "Candidate" or "" read as a known status would let a retired
  // skill be promoted, which is the one transition the rules never allow.
  assert.equal(isSkillStatus("candidate"), true);
  assert.equal(isSkillStatus("live"), true);
  assert.equal(isSkillStatus("retired"), true);
  for (const bad of ["Candidate", "", "active", "deleted"]) {
    assert.equal(isSkillStatus(bad), false, `${bad} is not a status`);
  }
  assert.equal(isVerdict("positive"), true);
  for (const bad of ["Positive", "", "good", "pass"]) {
    assert.equal(isVerdict(bad), false, `${bad} is not a verdict`);
  }
});
