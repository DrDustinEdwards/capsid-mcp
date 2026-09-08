import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPORTED_SECONDARY } from "../scripts/improve-report.mjs";
import { parseScoresDoc } from "../src/improve-scores";
import { seedScoresDoc } from "./seed-scores.ts";
import { ROSTER } from "../src/improve-schema";

// A DECLARED METRIC THAT NOTHING REPORTS IS A LIE THE DOCUMENT TELLS.
//
// Both 2026-09-07 audits rated this MAJOR 5.7: error_count and p95_latency_ms were
// emitted as a literal null on every run by every repo since the loop was built,
// and were declared in all five scores documents beside three real ones. foxhound
// carried two more, recovery_rate and dispute_win_rate, marked `stub`. The effect
// is not cosmetic. A reader of germomics' document sees five signals; the loop
// scores it on bundle size alone.
//
// The rule these tests keep: the scores canon and the scorer are derived from each
// other and fail in BOTH directions, so a metric cannot be declared without
// something reporting it, or reported without being declared.

const SCORER = join(import.meta.dirname, "..", "scripts", "improve-report.mjs");

function signedBody(): { secondary: Record<string, number | null> } {
  const dir = mkdtempSync(join(tmpdir(), "capsid-null-metrics-"));
  const metricsPath = join(dir, "metrics.json");
  writeFileSync(metricsPath, JSON.stringify({ bundle_size_bytes: 4242 }));
  return JSON.parse(
    execFileSync(process.execPath, [SCORER, metricsPath, "30", "30"], {
      encoding: "utf8",
      env: {
        ...process.env,
        IMPROVE_NAMESPACE: "capsid",
        RUN_ID: "r1",
        ATTEMPT_ID: "a1",
        ATTEMPT_HEAD_SHA: "deadbeef",
        BUILD_PASSES: "1",
        SECONDARY_TEST_PASS_RATE: "0.9",
        SECONDARY_LINT_COUNT: "3",
      },
    })
  );
}

test("PLANT: the signed report carries no metric that nothing measures", () => {
  const body = signedBody();
  assert.deepEqual(
    Object.keys(body.secondary),
    REPORTED_SECONDARY,
    "the report's secondary block is exactly the wired metrics, in order"
  );
  assert.ok(!("error_count" in body.secondary), "error_count was null on every run ever posted");
  assert.ok(!("p95_latency_ms" in body.secondary), "p95_latency_ms was null on every run ever posted");
});

test("PLANT: the seed document declares no metric the scorer does not report", () => {
  for (const namespace of ROSTER) {
    const doc = parseScoresDoc(namespace, seedScoresDoc(namespace));
    assert.deepEqual(doc.problems, [], `${namespace}'s seed document must parse cleanly`);
    const declared = doc.secondary.map((s) => s.metric);
    assert.deepEqual(
      declared,
      REPORTED_SECONDARY,
      `${namespace} declares ${JSON.stringify(declared)}; the scorer reports ${JSON.stringify(REPORTED_SECONDARY)}`
    );
  }
});

test("PLANT: no namespace parks an intention as a stub", () => {
  // The `stub` marker stays in the parser for a metric that is genuinely
  // half-wired. foxhound's recovery_rate and dispute_win_rate were not that: they
  // were named products of work nobody had started, and they sat in the canon for
  // three days reading like measurements. They live in
  // capsid/improve/TASK-wire-the-metrics.md now.
  for (const namespace of ROSTER) {
    const doc = parseScoresDoc(namespace, seedScoresDoc(namespace));
    const stubs = doc.secondary.filter((s) => s.stub).map((s) => s.metric);
    assert.deepEqual(stubs, [], `${namespace} still declares stub metrics: ${stubs.join(", ")}`);
  }
});

test("the parser still understands a stub, for the day one is genuinely half-wired", () => {
  // Removing the stubs from the canon must not remove the ability to declare one.
  // This is the innocent-case half of the widened matcher: a guard that also
  // deletes the mechanism gets reverted rather than kept.
  const doc = parseScoresDoc(
    "capsid",
    ["## Anchors", "", "- build_passes: required", "", "## Secondary", "", "- half_wired: maximize weight 0 stub", ""].join("\n")
  );
  assert.deepEqual(doc.problems, []);
  assert.equal(doc.secondary.length, 1);
  assert.equal(doc.secondary[0].stub, true);
});

test("the anchor block is untouched by any of this, so no pin moves", () => {
  // Removing a Secondary line cannot change the anchor checksum: sectionSlice
  // stops at the next `## ` heading. This is the assertion that lets a reader
  // trust the KV commands in the session report, which re-pin the same values.
  for (const namespace of ROSTER) {
    const doc = parseScoresDoc(namespace, seedScoresDoc(namespace));
    assert.ok(doc.anchorBlock.startsWith("## Anchors"), "the block starts at the heading");
    assert.ok(!doc.anchorBlock.includes("## Secondary"), "and stops before the tunable section");
    assert.ok(!doc.anchorBlock.includes("bundle_size_bytes"), "no secondary metric is inside the checksummed block");
  }
});
