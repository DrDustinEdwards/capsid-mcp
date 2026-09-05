import assert from "node:assert/strict";
import { test } from "node:test";
import { selectBase } from "../src/improve-select.ts";
import type { BestRecord } from "../src/improve-schema.ts";
import type { AttemptRow } from "../src/improve-state.ts";
import { IMPROVE_ATTEMPT_DEFAULTS } from "./improve-fakes.ts";

// Lineage-weighted base selection. Pure, so the policy is asserted directly
// rather than inferred from a run's behaviour.

function attempt(over: Partial<AttemptRow>): AttemptRow {
  return { ...(IMPROVE_ATTEMPT_DEFAULTS as unknown as AttemptRow), ...over };
}

function best(over: Partial<BestRecord> = {}): BestRecord {
  return {
    sha: "bestsha",
    run_id: "run-0",
    attempt_id: "a-best",
    recorded_at: "2026-09-01T00:00:00Z",
    anchors: {},
    secondary: {},
    score: 10,
    ...over,
  };
}

test("with nothing to go on it falls back to the default branch and says so", () => {
  const choice = selectBase(null, [], "defaultsha");
  assert.equal(choice.sha, "defaultsha");
  assert.equal(choice.attemptId, null);
  assert.match(choice.why, /branches from the repo's default branch/);
});

test("with no base at all it says that, rather than returning a plausible empty sha", () => {
  const choice = selectBase(null, [], null);
  assert.equal(choice.sha, "");
  assert.match(choice.why, /no base could be resolved/);
});

test("with only a best record it branches from best", () => {
  const choice = selectBase(best(), [], "defaultsha");
  assert.equal(choice.sha, "bestsha");
  assert.match(choice.why, /highest scoring base/);
});

test("A LOWER SCORING BASE WINS ON LINEAGE POTENTIAL, which is the whole point", () => {
  // best scores 10 and everything descended from it was reverted. The kept
  // attempt `a-fertile` scores less but four of its five descendants were kept.
  // Hill climbing would branch from best forever and never leave that hill.
  const attempts: AttemptRow[] = [
    attempt({ id: "a-fertile", kept: 1, head_sha: "fertilesha", score_after: 6, lineage_parent: null }),
    ...[1, 2, 3, 4].map((n) => attempt({ id: `f${n}`, kept: 1, lineage_parent: "a-fertile" })),
    attempt({ id: "f5", kept: 0, lineage_parent: "a-fertile" }),
    ...[1, 2, 3].map((n) => attempt({ id: `b${n}`, kept: 0, lineage_parent: "a-best" })),
  ];
  const choice = selectBase(best(), attempts, "defaultsha");
  assert.equal(choice.sha, "fertilesha");
  assert.match(choice.why, /lower scoring base on lineage potential/);
  assert.match(choice.why, /4 of 5 descendants were kept/);
});

test("but a big enough score difference still wins", () => {
  // The weights are a claim about how much exploration is worth, and the claim is
  // falsifiable in this direction too: one lucky descendant does not beat a base
  // that scores far higher.
  const attempts: AttemptRow[] = [
    attempt({ id: "a-lucky", kept: 1, head_sha: "luckysha", score_after: -8, lineage_parent: null }),
    attempt({ id: "l1", kept: 1, lineage_parent: "a-lucky" }),
  ];
  const choice = selectBase(best({ score: 8 }), attempts, "defaultsha");
  assert.equal(choice.sha, "bestsha");
});

test("a REVERTED attempt is never a candidate", () => {
  // Its head sha describes a state that was measured and rejected.
  const attempts = [attempt({ id: "a-bad", kept: 0, head_sha: "badsha", score_after: 100 })];
  const choice = selectBase(null, attempts, "defaultsha");
  assert.equal(choice.sha, "defaultsha");
  assert.deepEqual(choice.candidates, []);
});

test("an attempt with no commit is never a candidate", () => {
  const attempts = [attempt({ id: "a-nohead", kept: 1, head_sha: null, score_after: 100 })];
  assert.equal(selectBase(null, attempts, "defaultsha").sha, "defaultsha");
});

test("smoothing stops one sample outranking nine", () => {
  const oneForOne = attempt({ id: "one", kept: 1, head_sha: "onesha", score_after: 0 });
  const nineForTen = attempt({ id: "nine", kept: 1, head_sha: "ninesha", score_after: 0 });
  const attempts: AttemptRow[] = [
    oneForOne,
    attempt({ id: "o1", kept: 1, lineage_parent: "one" }),
    nineForTen,
    ...Array.from({ length: 9 }, (_, i) => attempt({ id: `n${i}`, kept: 1, lineage_parent: "nine" })),
    attempt({ id: "n9", kept: 0, lineage_parent: "nine" }),
  ];
  const choice = selectBase(null, attempts, null);
  assert.equal(choice.sha, "ninesha", "a one-for-one base outranked a nine-for-ten one");
});

test("selection is deterministic: the same input gives the same answer", () => {
  const attempts: AttemptRow[] = [
    attempt({ id: "a", kept: 1, head_sha: "asha", score_after: 3 }),
    attempt({ id: "b", kept: 1, head_sha: "bsha", score_after: 4 }),
  ];
  const first = selectBase(best(), attempts, "defaultsha");
  for (let i = 0; i < 5; i++) {
    assert.equal(selectBase(best(), attempts, "defaultsha").sha, first.sha);
  }
});

test("a lineage cycle does not hang the walk", () => {
  // lineage_parent is written by this Worker and should never form a cycle, but a
  // spliced repair or a restored dump could produce one, and a base selector that
  // hangs takes the whole tick with it.
  const attempts: AttemptRow[] = [
    attempt({ id: "x", kept: 1, head_sha: "xsha", lineage_parent: "y" }),
    attempt({ id: "y", kept: 1, head_sha: "ysha", lineage_parent: "x" }),
  ];
  const choice = selectBase(null, attempts, null);
  assert.ok(choice.sha === "xsha" || choice.sha === "ysha");
});

test("every candidate reports the numbers its weight was computed from", () => {
  // The archive document quotes these. A verdict a human cannot check is a
  // verdict nobody will question.
  const attempts: AttemptRow[] = [
    attempt({ id: "a", kept: 1, head_sha: "asha", score_after: 3 }),
    attempt({ id: "d", kept: 1, lineage_parent: "a" }),
  ];
  const choice = selectBase(null, attempts, null);
  const candidate = choice.candidates.find((c) => c.sha === "asha");
  assert.equal(candidate?.descendants, 1);
  assert.equal(candidate?.wins, 1);
  assert.ok((candidate?.potential ?? 0) > 0 && (candidate?.potential ?? 1) < 1, "potential was not smoothed");
});
