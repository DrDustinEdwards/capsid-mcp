// Trusted scoring glue for improve-score.yml, run from the DEFAULT branch in the
// scorer's second job. It never runs attempt-controlled code: it reads the TAP
// output node --test wrote to a file and counts results from the TOP-LEVEL ok /
// not ok lines, not from a process exit code. That is the fix for the 2026-09-06
// CRITICAL where an attempt forced holdout_pass_rate to 1.0 by calling
// process.exit(0) before assertions ran: an early exit means the file's ok line is
// never written, so the pass it never earned is simply absent rather than assumed.
//
// TAP, not "json": node --test has no builtin json reporter (its builtins are tap,
// spec, dot, junit, lcov). TAP is the line-oriented one, and a top-level result is
// an `ok N` or `not ok N` at column 0; subtests are indented under `# Subtest:` and
// are deliberately not counted, so a suite that uses subtests is not double-weighted.
//
// THIS FILE IS BYTE-IDENTICAL ACROSS ALL FIVE ROSTER REPOS, like the score job that
// calls it. Only Job A (per repo) differs. Pure functions are exported for
// test/improve-report.test.ts; the CLI has three modes, all repo-agnostic.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Count the TOP-LEVEL TAP results. A top-level pass is `ok N` at column 0; a
// top-level failure is `not ok N` at column 0. Indented lines (subtests), the plan
// (`1..N`), diagnostics (`#`) and YAML blocks (`  ---`) are all ignored.
/** @param {string} text */
export function parseTestReport(text) {
  let pass = 0;
  let fail = 0;
  for (const line of text.split("\n")) {
    if (/^not ok \d+/.test(line)) fail += 1;
    else if (/^ok \d+/.test(line)) pass += 1;
  }
  return { pass, fail };
}

// A pass rate in [0, 1], or null when nothing ran (which the Worker treats as
// "not reported" rather than as a catastrophic zero).
/** @param {string} text */
export function testPassRate(text) {
  const { pass, fail } = parseTestReport(text);
  const total = pass + fail;
  return total > 0 ? pass / total : null;
}

// One holdout case file passes iff its report has at least one top-level ok and no
// top-level not-ok. Zero results (the process.exit(0) case, or a load error) is
// NOT a pass, which is the whole point: silence cannot score.
/** @param {string} text */
export function holdoutFilePassed(text) {
  const { pass, fail } = parseTestReport(text);
  return pass > 0 && fail === 0;
}

// A metric read from Job A's metrics.json: a finite number, or null for anything
// else (missing, "", non-finite). Coercion is refused so a stray value cannot read
// as a real measurement.
/** @param {unknown} value */
function metric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---- CLI --------------------------------------------------------------------
// Three modes, all trusted (this file is on the default branch), none of which
// runs attempt code:
//   --holdout <reportPath>   exit 0 if that holdout case passed, 1 otherwise.
//   --rate <testReportPath>  print the top-level pass rate, or "" if nothing ran.
//   <metricsPath> <holdoutTotal> <holdoutPassed>
//                            emit the score-report body (Job A's numbers from
//                            metrics.json, plus the holdout counts and a fresh
//                            jti) to stdout. The signing key never touches this.
/** @param {string[]} argv */
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
  if (argv[0] === "--rate") {
    let rate = null;
    try {
      rate = testPassRate(readFileSync(argv[1], "utf8"));
    } catch {
      rate = null;
    }
    process.stdout.write(rate === null ? "" : String(rate));
    return;
  }
  const [metricsPath, holdoutTotal, holdoutPassed] = argv;
  /** @type {{ build_passes?: unknown, test_pass_rate?: unknown, lint_count?: unknown, bundle_size_bytes?: unknown }} */
  let m = {};
  try {
    m = JSON.parse(readFileSync(metricsPath, "utf8"));
  } catch {
    m = {};
  }
  /** @param {unknown} v */
  const numOrNull = (v) => (v === undefined || v === "" || v === "null" ? null : Number(v));
  const body = {
    namespace: process.env.IMPROVE_NAMESPACE,
    run_id: process.env.RUN_ID,
    attempt_id: process.env.ATTEMPT_ID,
    head_sha: process.env.ATTEMPT_HEAD_SHA,
    jti: randomUUID(),
    anchors: { build_passes: m.build_passes === 1 ? 1 : 0 },
    secondary: {
      test_pass_rate: metric(m.test_pass_rate),
      lint_count: metric(m.lint_count),
      error_count: null,
      p95_latency_ms: null,
      bundle_size_bytes: metric(m.bundle_size_bytes),
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
