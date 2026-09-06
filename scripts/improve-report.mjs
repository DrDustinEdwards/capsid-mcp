// Trusted scoring glue for improve-score.yml, run from the DEFAULT branch in the
// scorer's second job. It never runs attempt-controlled code: it reads the JSON
// reporter output node --test wrote and counts results from EVENTS, not from a
// process exit code. That is the fix for the 2026-09-06 CRITICAL where an attempt
// forced holdout_pass_rate to 1.0 by calling process.exit(0) before assertions
// ran: an early exit truncates the event stream, so the pass it never earned is
// simply absent rather than assumed.
//
// Pure functions are exported for test/improve-report.test.ts; the CLI at the
// bottom builds the score-report body (numbers only, plus a fresh jti) for the
// workflow to sign.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// node --test --test-reporter=json emits newline-delimited JSON events. Count the
// top-level (nesting 0) test:pass and test:fail events; nested subtests are part of
// their parent's result and counting them too would double-weight a suite that uses
// subtests. A line that does not parse is ignored rather than fatal.
export function parseTestReport(text) {
  let pass = 0;
  let fail = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.data?.nesting !== 0) continue;
    if (event.type === "test:pass") pass += 1;
    else if (event.type === "test:fail") fail += 1;
  }
  return { pass, fail };
}

// A pass rate in [0, 1], or null when nothing ran (which the Worker treats as
// "not reported" rather than as a catastrophic zero).
export function testPassRate(text) {
  const { pass, fail } = parseTestReport(text);
  const total = pass + fail;
  return total > 0 ? pass / total : null;
}

// One holdout case file passes iff its report has at least one top-level pass and
// no top-level failure. Zero events (the process.exit(0) case, or a load error)
// is NOT a pass, which is the whole point: silence cannot score.
export function holdoutFilePassed(text) {
  const { pass, fail } = parseTestReport(text);
  return pass > 0 && fail === 0;
}

// ---- CLI --------------------------------------------------------------------
// Two modes, both trusted (this file is on the default branch):
//   --holdout <reportPath>   exit 0 if that holdout case passed, 1 otherwise.
//   <testReportPath> <holdoutTotal> <holdoutPassed> <lintCount> <bundleBytes> <buildOutcome>
//                            emit the score-report body (numbers + a fresh jti) to
//                            stdout. The signing key never touches this process.
function main(argv) {
  if (argv[0] === "--holdout") {
    let passed = false;
    try {
      passed = holdoutFilePassed(readFileSync(argv[1], "utf8"));
    } catch {
      passed = false;
    }
    process.exit(passed ? 0 : 1);
  }
  const [testReportPath, holdoutTotal, holdoutPassed, lintCount, bundleBytes, buildOutcome] = argv;
  const numOrNull = (v) => (v === undefined || v === "" || v === "null" ? null : Number(v));
  let rate = null;
  try {
    rate = testPassRate(readFileSync(testReportPath, "utf8"));
  } catch {
    rate = null;
  }
  const body = {
    namespace: process.env.IMPROVE_NAMESPACE,
    run_id: process.env.RUN_ID,
    attempt_id: process.env.ATTEMPT_ID,
    head_sha: process.env.ATTEMPT_HEAD_SHA,
    jti: randomUUID(),
    anchors: { build_passes: buildOutcome === "success" ? 1 : 0 },
    secondary: {
      test_pass_rate: rate,
      lint_count: numOrNull(lintCount),
      error_count: null,
      p95_latency_ms: null,
      bundle_size_bytes: numOrNull(bundleBytes),
    },
    holdout: { total: numOrNull(holdoutTotal) ?? 0, passed: numOrNull(holdoutPassed) ?? 0 },
    ci_minutes: Number(process.env.CI_MINUTES ?? "0"),
  };
  process.stdout.write(JSON.stringify(body));
}

// Only run the CLI when invoked directly, so importing the pure functions in a test
// does not trigger it.
if (process.argv[1] && process.argv[1].endsWith("improve-report.mjs")) {
  main(process.argv.slice(2));
}
