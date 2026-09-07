// Trusted scoring glue for improve-score.yml, run from the DEFAULT branch in the
// scorer's second job, from a copy stashed in $RUNNER_TEMP before any untrusted
// byte exists on the runner. It never runs attempt-controlled code: it reads the
// TAP the reporter produced and counts results from the TOP-LEVEL ok / not ok
// lines, not from a process exit code. That is the fix for the 2026-09-06
// CRITICAL where an attempt forced holdout_pass_rate to 1.0 by calling
// process.exit(0) before assertions ran: an early exit means the file's ok line is
// never written, so the pass it never earned is simply absent rather than assumed.
//
// TAP, not "json": node --test has no builtin json reporter (its builtins are tap,
// spec, dot, junit, lcov). TAP is the line-oriented one, and a top-level result is
// an `ok N` or `not ok N` at column 0; subtests are indented under `# Subtest:` and
// are deliberately not counted, so a suite that uses subtests is not double-weighted.
//
// THE STREAM MODE IS THE 2026-09-07 FIX (Opus CRITICAL 5.1, Grok CRITICAL 2).
// Holdout cases used to be run with --test-reporter-destination pointed at a file
// inside the attempt's own filesystem, which the attempt could rewrite from
// process.on('exit') after the reporter flushed. There is no destination file any
// more: the container writes TAP to its stdout, the runner captures that pipe
// outside the container, and this script splits the stream on the ##CAPSID-CASE
// markers the trusted container shell emits. A test's own stdout is captured by
// node's TAP reporter and re-emitted as `# ` comment lines, so nothing a test
// prints can produce a result line or a marker at column 0.
//
// THIS FILE IS BYTE-IDENTICAL ACROSS ALL FIVE ROSTER REPOS, like the score job that
// calls it. Only Job A (per repo) differs. Pure functions are exported for
// test/improve-report.test.ts; the CLI has four modes, all repo-agnostic.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// The marker the trusted container shell prints before each case file. It is
// matched at column 0, which a test cannot reach: node's TAP reporter prefixes
// every line a test writes to stdout with "# ", so an injected "##CAPSID-CASE x"
// arrives as "# ##CAPSID-CASE x" and does not match.
export const CASE_MARKER = "##CAPSID-CASE ";

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

// Split a concatenated TAP stream into one segment per holdout case and judge each
// with the same rule as a single report. Anything before the first marker is
// container preamble and is discarded; the trailing ##CAPSID-END bounds the last
// case so a truncated stream (a killed container) does not silently score its last
// case on a partial report.
/** @param {string} text */
export function parseHoldoutStream(text) {
  /** @type {{ name: string, passed: boolean }[]} */
  const cases = [];
  /** @type {string | null} */
  let current = null;
  /** @type {string[]} */
  let buffer = [];
  let terminated = false;
  const flush = () => {
    if (current !== null) cases.push({ name: current, passed: holdoutFilePassed(buffer.join("\n")) });
    current = null;
    buffer = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(CASE_MARKER)) {
      flush();
      current = line.slice(CASE_MARKER.length).trim();
      continue;
    }
    if (line === "##CAPSID-END") {
      flush();
      terminated = true;
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  // An unterminated stream means the container did not finish. Its last case is
  // dropped rather than judged on a partial report.
  flush();
  return { cases, terminated };
}

// How many holdout cases passed. An unterminated stream scores ZERO, not a
// partial count: a container killed halfway through is a failed measurement, and
// a failed measurement must never look like a good one.
/** @param {string} text */
export function holdoutPassCount(text) {
  const { cases, terminated } = parseHoldoutStream(text);
  if (!terminated) return 0;
  return cases.filter((c) => c.passed).length;
}

// A metric read from Job A's metrics.json: a finite number, or null for anything
// else (missing, "", non-finite). Coercion is refused so a stray value cannot read
// as a real measurement.
/** @param {unknown} value */
function metric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---- CLI --------------------------------------------------------------------
// Four modes, all trusted (this file runs from a stash taken off the default
// branch), none of which runs attempt code:
//   --holdout <reportPath>          exit 0 if that single report passed, 1 otherwise.
//   --holdout-stream <tapPath>      print how many cases passed in a piped stream.
//   --rate <testReportPath>         print the top-level pass rate, or "" if nothing ran.
//   <metricsPath> <total> <passed>  emit the score-report body to stdout. The
//                                   signing key never touches this.
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
  if (argv[0] === "--holdout-stream") {
    let count = 0;
    try {
      count = holdoutPassCount(readFileSync(argv[1], "utf8"));
    } catch {
      count = 0;
    }
    process.stdout.write(String(count));
    return;
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
  // THE ANCHOR IS NOT READ FROM THE ARTIFACT (audit 2026-09-07, Grok MAJOR 3).
  // BUILD_PASSES comes from Job A's job output, which the Actions runner sets from
  // the build step's own outcome. metrics.json is written on a runner that has
  // already executed attempt code and is treated as hostile for this field.
  // Absent (an old caller, or a job output that did not resolve) is 0, not 1.
  const buildPasses = process.env.BUILD_PASSES === "1" ? 1 : 0;
  const body = {
    namespace: process.env.IMPROVE_NAMESPACE,
    run_id: process.env.RUN_ID,
    attempt_id: process.env.ATTEMPT_ID,
    head_sha: process.env.ATTEMPT_HEAD_SHA,
    jti: randomUUID(),
    anchors: { build_passes: buildPasses },
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
