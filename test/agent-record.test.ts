import assert from "node:assert/strict";
import { test } from "node:test";
import { recordFor, recordsFrom, type RecordRows, type RecordSubject } from "../src/agent-record.ts";
import { sourceFile } from "./source-files.ts";

// THE AGENT RECORD: counts and rates over the outcome rows.
//
// A PURE FUNCTION OVER FIXTURES, on purpose. The aggregation is the part that can be
// subtly wrong in a way nothing notices: a denominator that counts the wrong rows
// still produces a plausible percentage. Checked against rows written here rather
// than through a fake that would agree with whatever it was handed.

const ACTOR = "agent:capsid-driver";

function outcome(overrides: Partial<RecordRows["outcomes"][number]> = {}): RecordRows["outcomes"][number] {
  return {
    agent: ACTOR,
    prs_opened: null,
    prs_merged: null,
    ci_green: null,
    blocked_count: 0,
    resumed_count: 0,
    duration_minutes: null,
    verified: JSON.stringify({ prs_opened: false, prs_merged: false, commits: false, files_changed: false, ci_green: false }),
    ...overrides,
  };
}

// A row the Worker checked. Written as a helper because "verified" is the whole
// distinction this module turns on and spelling it out per row would bury it.
function verified(overrides: Partial<RecordRows["outcomes"][number]> = {}) {
  return outcome({
    verified: JSON.stringify({ prs_opened: true, prs_merged: true, commits: true, files_changed: true, ci_green: true }),
    ...overrides,
  });
}

const EMPTY: RecordRows = { outcomes: [], jobs: [], runs: [] };

test("a credential that has done nothing reports zero counts and NULL rates", () => {
  // The asymmetry is the point. A count of zero is a fact: this agent finished no
  // jobs. A rate of zero would be a claim it has a bad record, and it has no record.
  const record = recordFor(ACTOR, EMPTY, null);
  assert.equal(record.jobs_done, 0);
  assert.equal(record.prs_opened, 0);
  assert.equal(record.pr_merge_rate, null);
  assert.equal(record.ci_green_rate, null);
  assert.equal(record.median_duration_minutes, null);
  assert.equal(record.actor, ACTOR);
});

test("job states come from the jobs table, because a blocked job has no outcome yet", () => {
  const record = recordFor(ACTOR, {
    ...EMPTY,
    jobs: [
      { actor: ACTOR, status: "done", n: 5 },
      { actor: ACTOR, status: "failed", n: 2 },
      { actor: ACTOR, status: "blocked", n: 1 },
      { actor: "agent:foxing-driver", status: "done", n: 40 },
      // A bare name is a different caller. The queue records agent:<name>, and
      // matching the name alone would credit somebody else's work.
      { actor: "capsid-driver", status: "done", n: 99 },
    ],
  }, null);
  assert.equal(record.jobs_done, 5);
  assert.equal(record.jobs_failed, 2);
  assert.equal(record.jobs_blocked, 1);
});

test("ONLY A VERIFIED FIELD FEEDS A RATE", () => {
  // The load-bearing rule. An unverified count is still stored on its row, because it
  // is better than nothing; a RATE built from it would be a credential grading its
  // own work and presenting the result as measurement.
  const record = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [
      // Unverified and generous: forty opened, forty merged. If this counted, the
      // merge rate would be a perfect 100%.
      outcome({ prs_opened: 40, prs_merged: 40 }),
      // Verified and modest.
      verified({ prs_opened: 4, prs_merged: 1 }),
    ],
  }, null);
  assert.equal(record.prs_opened, 4, "an unverified pull request count reached the record");
  assert.equal(record.prs_merged, 1);
  assert.equal(record.pr_merge_rate, 0.25);
});

test("the CI rate's denominator is what was checked, not what was done", () => {
  // A documentation job has no build. Counting it as a CI miss would mark an agent
  // down for work that never had CI to be green.
  const record = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [
      verified({ ci_green: 1 }),
      verified({ ci_green: 1 }),
      verified({ ci_green: 0 }),
      // Three jobs with nothing to check: no pull request, or CI that had not
      // finished. None of them belongs in the denominator.
      outcome({ ci_green: null }),
      outcome({ ci_green: null }),
      verified({ ci_green: null }),
    ],
  }, null);
  assert.equal(record.ci_checked, 3, "the denominator counted rows the Worker never checked");
  assert.equal(record.ci_green_rate, 0.667);
});

test("the duration is a MEDIAN, so one job left open over a weekend does not move it", () => {
  const weekend = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [
      outcome({ duration_minutes: 20 }),
      outcome({ duration_minutes: 25 }),
      outcome({ duration_minutes: 30 }),
      outcome({ duration_minutes: 4000 }),
    ],
  }, null);
  // The mean here is over a thousand minutes. The median says what a job usually took.
  assert.equal(weekend.median_duration_minutes, 28);
  // An odd count takes the middle rather than averaging.
  const odd = recordFor(ACTOR, { ...EMPTY, outcomes: [outcome({ duration_minutes: 1 }), outcome({ duration_minutes: 5 }), outcome({ duration_minutes: 90 })] }, null);
  assert.equal(odd.median_duration_minutes, 5);
  // A job with no duration is not a job of length zero.
  const mixed = recordFor(ACTOR, { ...EMPTY, outcomes: [outcome({ duration_minutes: null }), outcome({ duration_minutes: 10 })] }, null);
  assert.equal(mixed.median_duration_minutes, 10);
});

test("gates hit and resumes are totals over the agent's own rows", () => {
  const record = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [
      outcome({ blocked_count: 2, resumed_count: 2 }),
      outcome({ blocked_count: 1, resumed_count: 1 }),
      // Another credential's job, which must not land on this record.
      outcome({ agent: "agent:foxing-driver", blocked_count: 9, resumed_count: 9 }),
    ],
  }, null);
  assert.equal(record.gates_hit, 3);
  assert.equal(record.resumed, 3);
});

test("a corrupt verified column withholds a rate rather than inventing one", () => {
  // Fail closed, which for a rate means refusing to compute it. The alternative is a
  // percentage derived from a column nobody can read.
  for (const bad of ["{", "null", "[]", '"true"']) {
    const record = recordFor(ACTOR, { ...EMPTY, outcomes: [outcome({ prs_opened: 9, prs_merged: 9, verified: bad })] }, null);
    assert.equal(record.prs_opened, 0, `a row with a ${bad} verified column was counted`);
    assert.equal(record.pr_merge_rate, null);
  }
});

test("the improve loop's columns belong to drivers and are NULL for everybody else", () => {
  const runs = [
    { namespace: "capsid", kept: 6, reverts: 14 },
    { namespace: "foxing", kept: 1, reverts: 3 },
  ];
  const driver = recordFor(ACTOR, { ...EMPTY, runs }, ["capsid"]);
  assert.equal(driver.attempts_kept, 6);
  assert.equal(driver.attempts_reverted, 14);

  const wildcard = recordFor(ACTOR, { ...EMPTY, runs }, "*");
  assert.equal(wildcard.attempts_kept, 7, "a wildcard driver sums every namespace");
  assert.equal(wildcard.attempts_reverted, 17);

  // A seat reads everywhere and runs nothing. Crediting it with a namespace's
  // attempts would attribute one credential's work to another.
  const seat = recordFor(ACTOR, { ...EMPTY, runs }, null);
  assert.equal(seat.attempts_kept, null);
  assert.equal(seat.attempts_reverted, null);
});

test("recordsFrom keys by agent name and fills the loop columns only for drivers", () => {
  const agents: RecordSubject[] = [
    { name: "capsid-driver", kind: "driver", namespaces: ["capsid"] },
    { name: "seat", kind: "seat", namespaces: "*" },
  ];
  const records = recordsFrom(agents, {
    outcomes: [verified({ prs_opened: 2, prs_merged: 2 })],
    jobs: [{ actor: ACTOR, status: "done", n: 3 }],
    runs: [{ namespace: "capsid", kept: 4, reverts: 1 }],
  });
  assert.equal(records["capsid-driver"].jobs_done, 3);
  assert.equal(records["capsid-driver"].pr_merge_rate, 1);
  assert.equal(records["capsid-driver"].attempts_kept, 4);
  // The seat gets a record too, and it is empty rather than absent: a credential
  // that has done nothing should read as nothing, not as missing.
  assert.equal(records["seat"].jobs_done, 0);
  assert.equal(records["seat"].attempts_kept, null);
  // Object.create(null), so a credential named for a prototype member cannot collide
  // with one. The same bug counts.ts fixed with Object.hasOwn.
  assert.equal(Object.getPrototypeOf(records), null);
});

test("NO COMPOSITE SCORE IS COMPUTED ANYWHERE IN THE RECORD", () => {
  // The rule stated as a guard. Every field is a count with a name on it or a rate
  // with a stated denominator; the moment one number stands for all of them,
  // somebody gates on it and the gate is an opinion nobody wrote down.
  const record = recordFor(ACTOR, EMPTY, null);
  const named = Object.keys(record);
  for (const forbidden of ["score", "rating", "trust", "grade", "rank"]) {
    assert.ok(
      !named.some((field) => field.toLowerCase().includes(forbidden)),
      `the record grew a '${forbidden}' field, which is the composite this design refuses`
    );
  }
  // And the source says so, so the next reader finds the reason rather than the rule.
  assert.match(sourceFile("agent-record.ts"), /COUNTS AND RATES, NEVER A SCORE/);
});

test("the inventory is read with grouped queries, not one set per credential", () => {
  // A per-agent loop would grow the query count with the number of credentials, on a
  // page that renders all of them.
  const source = sourceFile("agent-record.ts");
  const prepares = [...source.matchAll(/\.prepare\(/g)].length;
  assert.equal(prepares, 3, `loadRecordRows issues ${prepares} queries; it should be three grouped reads`);
  assert.doesNotMatch(source, /for \(const agent of agents\) \{[^}]*await/s, "the loader awaits inside a per-agent loop");
});
