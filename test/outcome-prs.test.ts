import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  REVERIFY_PER_SWEEP,
  REVERIFY_WINDOW_DAYS,
  SWEEP_INTERVAL_MS,
  outcomePrStatements,
  prUrlsFromJob,
} from "../src/outcome-prs.ts";
import { parseEvidence } from "../src/job-outcomes.ts";

// OUTCOME ROWS ARE IMMUTABLE EXCEPT MERGE STATE. A driver never merges: it blocks and
// the seat merges afterwards, so every row is written "opened, not merged" and stays
// wrong. These cover the one narrow path that corrects it.

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0015_outcome_prs.sql"), "utf8");
const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "outcome-prs.ts"), "utf8");
const TOOL = readFileSync(join(import.meta.dirname, "..", "src", "tools", "jobs.ts"), "utf8");

function recorder() {
  const recorded: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return {} as D1PreparedStatement;
      },
    }),
  } as unknown as D1Database;
  return { recorded, db };
}

// ---- the join rows written at complete --------------------------------------------

test("one row per pull request the evidence named", () => {
  const { recorded, db } = recorder();
  const statements = outcomePrStatements(db, "job_1", [
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/2",
  ]);
  assert.equal(statements.length, 2);
  assert.equal(recorded.length, 2);
  assert.match(recorded[0].sql, /INSERT INTO job_outcome_prs/);
  // merged and merge_verified_at are NULL literals in the VALUES list, not bound
  // params, so the statement binds exactly the two identifying columns.
  assert.deepEqual(recorded[0].params, ["job_1", "https://github.com/o/r/pull/1"]);
});

test("a repeated pull request is written once, because a batch conflict would abort the outcome write", () => {
  const { recorded, db } = recorder();
  outcomePrStatements(db, "job_1", ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/1", " "]);
  assert.equal(recorded.length, 1, "the duplicate and the blank are dropped before the batch");
});

test("evidence naming no pull requests writes no rows", () => {
  const { recorded, db } = recorder();
  assert.deepEqual(outcomePrStatements(db, "job_1", []), []);
  assert.equal(recorded.length, 0);
});

test("merged starts NULL, which is not the same as closed unmerged", () => {
  // Three states: 1 merged, 0 closed or open, NULL never checked. A row written when
  // GitHub was unreachable has never been looked at, and storing that as 0 would make
  // it indistinguishable from a pull request somebody closed.
  const { recorded, db } = recorder();
  outcomePrStatements(db, "job_1", ["https://github.com/o/r/pull/1"]);
  assert.match(recorded[0].sql, /VALUES \(\?1, \?2, NULL, NULL\)/, "both merge fields start unset");
  assert.match(MIGRATION, /NULL never checked/i);
});

// ---- seeding a row that stored no pull request -------------------------------------

test("pull request URLs are found in both result_ref and the summary prose", () => {
  const urls = prUrlsFromJob({
    result_ref: "https://github.com/DrDustinEdwards/capsid-mcp/pull/25",
    result_summary: "merged at cec9285, see https://github.com/DrDustinEdwards/capsid-mcp/pull/24 as well",
  });
  assert.deepEqual(urls.sort(), [
    "https://github.com/DrDustinEdwards/capsid-mcp/pull/24",
    "https://github.com/DrDustinEdwards/capsid-mcp/pull/25",
  ]);
});

test("the same URL in both fields is one URL", () => {
  const url = "https://github.com/o/r/pull/7";
  assert.deepEqual(prUrlsFromJob({ result_ref: url, result_summary: `landed in ${url}` }), [url]);
});

test("a job with no pull request anywhere seeds nothing", () => {
  assert.deepEqual(prUrlsFromJob({ result_ref: "capsid/some-doc.md", result_summary: "wrote a document" }), []);
  assert.deepEqual(prUrlsFromJob({ result_ref: null, result_summary: null }), []);
});

test("a near-miss URL is not mistaken for a pull request", () => {
  const urls = prUrlsFromJob({
    result_ref: null,
    result_summary: "see https://github.com/o/r/issues/25 and https://github.com/o/r/pull/abc",
  });
  assert.deepEqual(urls, [], "an issue and a non-numeric pull path are neither of them evidence");
});

test("a seeded URL is verified against GitHub before anything is counted", () => {
  // A URL scraped out of prose is a claim, and this whole change exists because a
  // claim is not evidence. The seed writes merged NULL and the ordinary re-verify
  // path is what sets it.
  const sweep = /export async function reverifySweep[\s\S]*?\n\}/.exec(SOURCE);
  assert.ok(sweep, "reverifySweep is gone");
  assert.ok(
    sweep[0].indexOf("outcomePrStatements") < sweep[0].indexOf("dueForReverify"),
    "seeding must happen before the verification pass, so a seeded row is verified in the same sweep"
  );
  assert.equal(/prs_merged/.test(sweep[0]), false, "the sweep itself must not write a count");
});

// ---- what re-verification touches ---------------------------------------------------

test("re-verification updates only the merge fields, and recomputes rather than increments", () => {
  const body = /export async function reverifyPr[\s\S]*?\n\}\n/.exec(SOURCE);
  assert.ok(body, "reverifyPr is gone");
  const update = /UPDATE job_outcomes[\s\S]*?WHERE job_id = \?1/.exec(body[0]);
  assert.ok(update, "the outcome update is gone");
  // An increment run twice drifts, and this path runs on a merge AND on a sweep, so
  // it will be run twice on the same pull request eventually.
  assert.match(update[0], /prs_merged = \(SELECT COUNT\(\*\)/);
  assert.equal(/prs_merged = prs_merged/.test(update[0]), false, "never an increment");
  for (const column of ["prs_opened", "commits", "files_changed", "tests_added", "ci_green", "duration_minutes"]) {
    assert.equal(new RegExp(`${column}\\s*=`).test(update[0]), false, `${column} must not be touched`);
  }
});

test("an unreachable GitHub leaves every row exactly as it was", () => {
  const body = /export async function reverifyPr[\s\S]*?\n\}\n/.exec(SOURCE);
  assert.ok(body);
  assert.match(body[0], /if \(typeof facts === "string"\) return \[\];/);
  assert.ok(
    body[0].indexOf('typeof facts === "string"') < body[0].indexOf("UPDATE job_outcome_prs"),
    "the bail must come before any write"
  );
});

test("a pull request closed unmerged is recorded as 0, and does not increment the count", () => {
  const body = /export async function reverifyPr[\s\S]*?\n\}\n/.exec(SOURCE);
  assert.ok(body);
  assert.match(body[0], /const merged = facts\.merged === true;/, "merged is strictly GitHub's answer");
  assert.match(body[0], /merged \? 1 : 0/);
  // And the recomputation counts merged = 1 only, so a 0 contributes nothing.
  assert.match(body[0], /WHERE job_id = \?1 AND merged = 1/);
});

test("a row that does not name the pull request is untouched", () => {
  const body = /export async function reverifyPr[\s\S]*?\n\}\n/.exec(SOURCE);
  assert.ok(body);
  assert.match(body[0], /SELECT job_id, merged FROM job_outcome_prs WHERE pr_url = \?1/);
  assert.match(body[0], /if \(named\.length === 0\) return \[\];/, "no naming row means no work and no writes");
});

// ---- the bounds ----------------------------------------------------------------------

test("the sweep is bounded per run and by age, and runs daily", () => {
  assert.equal(REVERIFY_PER_SWEEP, 50);
  assert.equal(REVERIFY_WINDOW_DAYS, 30);
  assert.equal(SWEEP_INTERVAL_MS, 86_400_000);
  assert.match(SOURCE, /LIMIT \?2/, "both queries bind their limit rather than interpolating it");
});

test("the sweep prefers what has never been checked", () => {
  const due = /export async function dueForReverify[\s\S]*?\n\}/.exec(SOURCE);
  assert.ok(due);
  assert.match(due[0], /ORDER BY p\.merge_verified_at IS NOT NULL, p\.merge_verified_at ASC/);
  assert.match(due[0], /p\.merged IS NULL OR p\.merged = 0/, "a row already known merged is not re-read");
});

test("a merge that fails to update an outcome does not fail the merge", () => {
  const repo = readFileSync(join(import.meta.dirname, "..", "src", "tools", "repo.ts"), "utf8");
  const hook = /if \(action === "merge"\) \{[\s\S]*?\n          \}/.exec(repo);
  assert.ok(hook, "the merge hook is gone from manage_pr");
  assert.match(hook[0], /try \{/, "the re-verification must be wrapped");
  assert.match(hook[0], /OUTCOME_REVERIFY_FAILED/);
});

// ---- evidence as an object or a JSON string ------------------------------------------

test("an evidence object passes through unchanged", () => {
  const evidence = { prs: ["https://github.com/o/r/pull/1"], commits: 6, files_changed: 19, tests_added: 75 };
  const parsed = parseEvidence(evidence);
  assert.ok("evidence" in parsed);
  assert.deepEqual(parsed.evidence, evidence);
});

test("the same evidence as a JSON string parses to the same thing", () => {
  // The point of the whole parameter: a session whose cached tool schema predates the
  // object form can still attach verified evidence.
  const evidence = { prs: ["https://github.com/o/r/pull/1"], commits: 6, files_changed: 19, tests_added: 75 };
  const fromString = parseEvidence(JSON.stringify(evidence));
  assert.ok("evidence" in fromString);
  assert.deepEqual(fromString.evidence, evidence);
});

test("a string that is not JSON is REFUSED rather than ignored", () => {
  // Silently discarding evidence is how a row ends up saying nothing happened.
  const parsed = parseEvidence("6 commits, 19 files");
  assert.ok("error" in parsed);
  assert.match(parsed.error, /not JSON/);
});

test("JSON that is not an object is refused", () => {
  for (const bad of ["[1,2,3]", '"a string"', "42", "null"]) {
    assert.ok("error" in parseEvidence(bad), `${bad} must be refused`);
  }
});

test("undefined and empty stay undefined, because absent evidence is not an error", () => {
  for (const empty of [undefined, "", "   "]) {
    const parsed = parseEvidence(empty);
    assert.ok("evidence" in parsed);
    assert.equal(parsed.evidence, undefined);
  }
});

test("a count that is not a non-negative integer is dropped rather than coerced to zero", () => {
  // A stored 0 reads as "somebody counted and the answer was none", which is a
  // different fact from "nobody counted".
  const parsed = parseEvidence(JSON.stringify({ commits: -3, files_changed: "many", tests_added: 1.5 }));
  assert.ok("evidence" in parsed);
  assert.deepEqual(parsed.evidence, {});
});

test("a non-string entry in prs is dropped and the rest survive", () => {
  const parsed = parseEvidence(JSON.stringify({ prs: ["https://github.com/o/r/pull/1", 7, null] }));
  assert.ok("evidence" in parsed);
  assert.deepEqual(parsed.evidence?.prs, ["https://github.com/o/r/pull/1"]);
});

test("the tool accepts both forms and refuses an unparseable string", () => {
  assert.match(TOOL, /\.union\(\[/, "the schema must accept both shapes");
  assert.match(TOOL, /const parsed = parseEvidence\(args\.evidence\);/);
  assert.match(TOOL, /if \("error" in parsed\) return fail\(parsed\.error\);/);
});
