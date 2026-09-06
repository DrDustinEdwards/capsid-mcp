import assert from "node:assert/strict";
import { test } from "node:test";
import { holdoutFilePassed, parseTestReport, testPassRate } from "../scripts/improve-report.mjs";

// Fix 1 (audit 2026-09-06): the scorer counts holdout passes from node --test's
// JSON reporter, not from a process exit code. These tests pin the property that
// makes that a fix: an early process.exit, or any truncated/empty report, cannot
// be counted as a pass, so an attempt cannot force holdout_pass_rate to 1.0 by
// exiting 0 before its assertions run.

const passEvent = (name: string) => JSON.stringify({ type: "test:pass", data: { name, nesting: 0 } });
const failEvent = (name: string) => JSON.stringify({ type: "test:fail", data: { name, nesting: 0 } });
const nestedPass = (name: string) => JSON.stringify({ type: "test:pass", data: { name, nesting: 1 } });

test("parseTestReport counts top-level passes and failures, ignoring nested and junk", () => {
  const report = [passEvent("a"), nestedPass("a.1"), failEvent("b"), "not json", ""].join("\n");
  assert.deepEqual(parseTestReport(report), { pass: 1, fail: 1 });
});

test("testPassRate is the ratio, and null when nothing ran", () => {
  assert.equal(testPassRate([passEvent("a"), passEvent("b"), failEvent("c")].join("\n")), 2 / 3);
  assert.equal(testPassRate(""), null, "an empty report is null, not a division by zero or a zero");
});

test("holdoutFilePassed requires a real pass and no failure", () => {
  assert.equal(holdoutFilePassed(passEvent("case")), true);
  assert.equal(holdoutFilePassed([passEvent("case"), failEvent("other")].join("\n")), false);
});

test("an early process.exit(0) cannot be counted as a holdout pass", () => {
  // The attack: attempt code imported by a holdout case calls process.exit(0)
  // before any assertion. The reporter emitted nothing for this file, so the
  // trusted counter sees zero passes and does NOT credit it.
  assert.equal(holdoutFilePassed(""), false);
  // Even a partial stream with no pass event is not a pass.
  assert.equal(holdoutFilePassed(JSON.stringify({ type: "test:start", data: { name: "case", nesting: 0 } })), false);
});
