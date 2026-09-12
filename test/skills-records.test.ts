import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  FAILURE_NOTES_PER_SKILL,
  MAX_OFFERED,
  attributionStatements,
  dueTransitions,
  offerSkills,
  failureNoteStatements,
  ftsQuery,
  shouldCreateCandidate,
} from "../src/skills-records.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// GROUPS 2, 3 AND 7: what gets offered, what earns a candidate, and what a failed run
// leaves behind for the next driver to read.

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0013_skill_attribution.sql"), "utf8");
const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "skills-records.ts"), "utf8");

// A statement recorder thin enough to read the bound parameters back out.
function recorder() {
  const recorded: Array<{ sql: string; params: unknown[] }> = [];
  const stmt = (sql: string, params: unknown[] = []): D1PreparedStatement =>
    ({
      sql: sql.replace(/\s+/g, " ").trim(),
      params,
      bind: (...bound: unknown[]) => {
        const s = stmt(sql, bound);
        recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), params: bound });
        return s;
      },
    }) as unknown as D1PreparedStatement;
  return { recorded, db: { prepare: (sql: string) => stmt(sql) } as unknown as D1Database };
}

// ---- group 2: what earns a candidate --------------------------------------------

test("a kept attempt earns a candidate and a reverted one does not", () => {
  assert.equal(shouldCreateCandidate({ kind: "attempt", id: "a1", kept: true }).create, true);
  assert.equal(shouldCreateCandidate({ kind: "attempt", id: "a1", kept: false }).create, false);
});

test("a job earns a candidate only when its outcome is fully verified", () => {
  assert.equal(shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: 1, ciGreen: 1 }).create, true);
  // Each half missing on its own, and the null case, which is not the same as zero.
  assert.equal(shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: 1, ciGreen: 0 }).create, false);
  assert.equal(shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: 0, ciGreen: 1 }).create, false);
  assert.equal(shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: null, ciGreen: null }).create, false);
  assert.match(
    shouldCreateCandidate({ kind: "job", id: "j1", prsMerged: null, ciGreen: 1 }).reason,
    /prs_merged null/,
    "the refusal must name which half was missing"
  );
});

test("this module cannot create a skill at all, so it cannot create one that is live", () => {
  // Group 2 is "never live on creation". The cheapest way to keep that true is for
  // the deciding module to have no write that creates a row: creation goes through
  // recordSkill, and the status column defaults to candidate in the schema. An
  // earlier version of this test banned the word "live" outright and wrongly failed
  // on the query that selects which skills to OFFER.
  assert.equal(/INSERT INTO improve_skills/i.test(SOURCE), false, "this module must not insert a skill row");
  assert.equal(/SET status\s*=/i.test(SOURCE.replace(/commitTransition[\s\S]*?\n\}/, "")), false, "only commitTransition may move a status");
});

test("a source that already produced a skill is looked up without filtering by status", () => {
  // A skill retired for not helping would otherwise be abstracted again from the same
  // attempt next pass, evaluated again, and retired again, forever. Both columns are
  // spelled out rather than interpolated, because a query assembled by concatenation
  // cannot be reconstructed by the integration suite's query-plan guard, which is the
  // only thing that reads every statement this Worker issues.
  const query = /alreadyAbstracted[\s\S]*?\n\}/.exec(SOURCE);
  assert.ok(query, "alreadyAbstracted is gone");
  assert.match(query[0], /WHERE source_attempt = \?1 LIMIT 1/);
  assert.match(query[0], /WHERE source_job = \?1 LIMIT 1/);
  assert.equal(/\$\{/.test(query[0]), false, "no interpolation into the statement");
  assert.equal(/status\s*(=|IN)/.test(query[0]), false, "and no status filter, or a retired source would look unused");
});

// ---- group 3: what gets offered --------------------------------------------------

test("at most three skills are offered, and the bound is stated once", () => {
  assert.equal(MAX_OFFERED, 3);
  assert.match(SOURCE, /LIMIT \?3/, "the limit must be bound rather than interpolated");
});

test("only candidate and live skills are offered, never retired ones", () => {
  // A retired skill is a record of something that did not work. Offering it would be
  // recommending the thing the evidence retired.
  assert.match(SOURCE, /s\.status IN \('candidate', 'live'\)/);
});

test("a skill with no trigger condition is never offered", () => {
  // The rows that predate migration 0012 have none, and matching them on title would
  // be inventing the field the match runs on.
  assert.match(SOURCE, /s\.trigger_condition IS NOT NULL/);
});

test("ftsQuery reduces free prose to bare words, so an operator in a description cannot change the query", () => {
  // FTS5 takes a query language and work descriptions regularly contain its
  // operators. A description containing NEAR or a quote must not become a syntax
  // error, or worse, a query meaning something other than it says.
  assert.equal(ftsQuery('a "slow" query NEAR the loader'), "slow OR query OR near OR the OR loader");
  assert.equal(ftsQuery("a* OR b^"), null, "nothing over two characters survives, so there is no query");
  assert.equal(ftsQuery(""), null);
  assert.equal(ftsQuery("   "), null);
  const long = ftsQuery(Array.from({ length: 100 }, (_, i) => `word${i}`).join(" "));
  assert.equal((long ?? "").split(" OR ").length, 24, "the term list is bounded");
});

// ---- group 3: attribution, applied -----------------------------------------------

test("only used skills produce a write, and the direction follows the verifier", () => {
  const { recorded, db } = recorder();
  attributionStatements(db, {
    offered: ["s1", "s2", "s3"],
    used: ["s1", "s2"],
    signal: "verified-success",
  });
  assert.equal(recorded.length, 2, "the unused skill must produce no write at all");
  assert.ok(recorded.every((r) => /SET wins = wins \+ 1/.test(r.sql)));
  assert.deepEqual(recorded.map((r) => r.params[0]), ["s1", "s2"]);
});

test("improvised success and environment failure write nothing, even for a used skill", () => {
  for (const signal of ["improvised", "environment-failure"] as const) {
    const { recorded, db } = recorder();
    attributionStatements(db, { offered: ["s1"], used: ["s1"], signal });
    assert.equal(recorded.length, 0, `${signal} must move nothing`);
  }
});

test("a verified failure charges a loss to the used skill only", () => {
  const { recorded, db } = recorder();
  attributionStatements(db, { offered: ["s1", "s2"], used: ["s2"], signal: "verified-failure" });
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].sql, /SET losses = losses \+ 1/);
  assert.equal(recorded[0].params[0], "s2");
});

// ---- group 7: failure memory ------------------------------------------------------

test("a failure note is written per skill in use, carrying the source it came from", () => {
  const { recorded, db } = recorder();
  failureNoteStatements(db, "capsid", { kind: "job", id: "job_abc" }, ["s1", "s2"], "the migration was refused");
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded[0].params, ["s1", "capsid", "job", "job_abc", "the migration was refused"]);
  assert.match(recorded[0].sql, /INSERT INTO skill_failures/);
});

test("no skills in use means no notes, rather than a note attributed to nothing", () => {
  const { recorded, db } = recorder();
  failureNoteStatements(db, "capsid", { kind: "attempt", id: "a1" }, [], "it failed");
  assert.equal(recorded.length, 0);
});

test("a very long note is bounded before it is stored", () => {
  const { recorded, db } = recorder();
  failureNoteStatements(db, "capsid", { kind: "job", id: "j" }, ["s1"], "x".repeat(5000));
  assert.equal(String(recorded[0].params[4]).length, 2000);
});

test("the recommend step attaches exactly two notes per skill", () => {
  assert.equal(FAILURE_NOTES_PER_SKILL, 2);
  assert.match(SOURCE, /ORDER BY created_at DESC LIMIT \?2/, "newest first, and bounded");
});

test("a failure note never moves a skill's status", () => {
  // Only an evaluation does that. A note is prose about one run, and a system that let
  // prose retire a skill would have two status mechanisms disagreeing.
  const notes = /failureNoteStatements[\s\S]*?\n\}/.exec(SOURCE);
  assert.ok(notes);
  assert.equal(/improve_skills/.test(notes[0]), false, "the failure path must not touch the skill row");
  assert.match(MIGRATION, /THIS IS NOT A SECOND SCORE/i);
});

// ---- the migration ----------------------------------------------------------------

test("migration 0013 adds both attribution columns and the failures table", () => {
  assert.match(MIGRATION, /ALTER TABLE job_outcomes ADD COLUMN skill_ids_offered TEXT/);
  assert.match(MIGRATION, /ALTER TABLE job_outcomes ADD COLUMN skill_ids_used TEXT/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS skill_failures/);
  for (const column of ["skill", "namespace", "source_kind", "source_id", "note"]) {
    assert.match(MIGRATION, new RegExp(`\\b${column}\\b`), `skill_failures needs ${column}`);
  }
});

test("offered and used are stored separately, and the migration says why", () => {
  // The GAP is the measurement: a skill offered fifty times and used twice is a
  // trigger condition that does not describe the work, not a failing skill.
  assert.match(MIGRATION, /gap between them is the measurement/i);
  assert.match(MIGRATION, /NULL is not an empty array/i);
});

// ---- offerSkills and dueTransitions, driven against the fake ---------------------

test("offerSkills returns only candidate and live skills, with their recent failures", async () => {
  const { db, rows } = fakeD1({
    documents: [
      { namespace: "capsid", path: "improve/skills/s1.md", title: "slow query", body: "look for a slow database query in a loader" },
      { namespace: "capsid", path: "improve/skills/s3.md", title: "retired idea", body: "a slow database query in a loader" },
    ],
  });
  rows.improve_skills.push(
    { id: "s1", status: "candidate", version: 1, trigger_condition: "a slow database query", body_ref: "improve/skills/s1.md", title: "slow query", namespaces: null },
    { id: "s3", status: "retired", version: 1, trigger_condition: "a slow database query", body_ref: "improve/skills/s3.md", title: "retired idea", namespaces: null }
  );
  rows.skill_failures.push(
    { skill: "s1", namespace: "capsid", source_kind: "job", source_id: "j1", note: "older", created_at: "2026-09-01" },
    { skill: "s1", namespace: "capsid", source_kind: "job", source_id: "j2", note: "newer", created_at: "2026-09-09" }
  );

  const offered = await offerSkills(fakeEnv({ DB: db }), "capsid", "a slow database query in a loader");
  assert.deepEqual(offered.map((s) => s.id), ["s1"], "the retired skill must not be offered");
  assert.equal(offered[0].recent_failures.length, 2);
  assert.equal(offered[0].recent_failures[0].note, "newer", "newest first");
});

test("offerSkills returns nothing when the work description yields no searchable terms", async () => {
  const { db } = fakeD1({});
  assert.deepEqual(await offerSkills(fakeEnv({ DB: db }), "capsid", "a of to"), []);
});

test("dueTransitions reads each skill's evaluations at its own version and applies the rules", async () => {
  const { db, rows } = fakeD1({});
  rows.improve_skills.push(
    { id: "ready", status: "candidate", version: 1 },
    { id: "thin", status: "candidate", version: 1 },
    { id: "bumped", status: "candidate", version: 2 }
  );
  const evaluation = (skill: string, version: number, verdict: string, day: string) => ({
    skill, version, namespace: "capsid", probe_set_version: "p1", delta: verdict === "positive" ? 0.1 : -0.1, runs: 5, verdict, evaluated_at: `2026-09-${day}`,
  });
  rows.skill_evaluations.push(
    evaluation("ready", 1, "positive", "01"),
    evaluation("ready", 1, "positive", "02"),
    evaluation("thin", 1, "positive", "01"),
    // Two positives, but recorded against version 1 while the skill is now version 2.
    evaluation("bumped", 1, "positive", "01"),
    evaluation("bumped", 1, "positive", "02")
  );

  const verdicts = await dueTransitions(fakeEnv({ DB: db }));
  const by = new Map(verdicts.map((v) => [v.skill, v.verdict]));
  assert.equal(by.get("ready")?.change, true, "two positives at the current version promote");
  assert.equal(by.get("thin")?.change, false, "one is not enough");
  assert.equal(by.get("bumped")?.change, false, "evidence at an older version does not carry forward");
});
