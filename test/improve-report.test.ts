import assert from "node:assert/strict";
import { test } from "node:test";
import { holdoutFilePassed, parseTestReport, testPassRate } from "../scripts/improve-report.mjs";

// Fix 1 (audit 2026-09-06): the scorer counts holdout passes from node --test's TAP
// reporter (node has no json reporter), not from a process exit code. These tests
// pin the property that makes that a fix: an early process.exit, or any
// truncated/empty report, cannot be counted as a pass, so an attempt cannot force
// holdout_pass_rate to 1.0 by exiting 0 before its assertions run.

// A realistic node --test TAP fragment: top-level results at column 0, subtests
// indented under "# Subtest:".
const tap = (lines: string[]) => ["TAP version 13", ...lines].join("\n");
const okLine = (n: number, name: string) => `ok ${n} - ${name}`;
const notOkLine = (n: number, name: string) => `not ok ${n} - ${name}`;
const nestedOk = (name: string) => `    ok 1 - ${name}`; // indented subtest, must NOT count

test("parseTestReport counts top-level ok/not ok, ignoring nested and non-result lines", () => {
  const report = tap([
    "# Subtest: a",
    okLine(1, "a"),
    nestedOk("a.1"),
    "# Subtest: b",
    notOkLine(2, "b"),
    "  ---",
    "  duration_ms: 1",
    "  ...",
    "1..2",
  ]);
  assert.deepEqual(parseTestReport(report), { pass: 1, fail: 1 });
});

test("testPassRate is the ratio, and null when nothing ran", () => {
  assert.equal(testPassRate(tap([okLine(1, "a"), okLine(2, "b"), notOkLine(3, "c")])), 2 / 3);
  assert.equal(testPassRate(""), null, "an empty report is null, not a division by zero or a zero");
  assert.equal(testPassRate("TAP version 13\n"), null, "a header with no results is null");
});

test("holdoutFilePassed requires a real pass and no failure", () => {
  assert.equal(holdoutFilePassed(tap([okLine(1, "case")])), true);
  assert.equal(holdoutFilePassed(tap([okLine(1, "case"), notOkLine(2, "other")])), false);
});

test("an early process.exit(0) cannot be counted as a holdout pass", () => {
  // The attack: attempt code imported by a holdout case calls process.exit(0)
  // before any assertion. No `ok` line was written for the case, so the trusted
  // counter sees zero passes and does NOT credit it.
  assert.equal(holdoutFilePassed(""), false);
  assert.equal(holdoutFilePassed(tap(["# Subtest: case"])), false, "a started-but-unfinished case is not a pass");
});
