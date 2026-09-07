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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// The marker the trusted container shell prints before each case file. It is
// matched at column 0, which a test cannot reach: node's TAP reporter prefixes
// every line a test writes to stdout with "# ", so an injected "##CAPSID-CASE x"
// arrives as "# ##CAPSID-CASE x" and does not match.
export const CASE_MARKER = "##CAPSID-CASE ";

// THE NONCE (2026-09-07, secondaries-in-the-container). TAP escaping is what
// protects the case markers, and it only protects output that went through node's
// TAP reporter. The secondary phases below pipe a lint tool's RAW stdout into the
// same stream, and a lint diagnostic can carry attacker text at column 0. So every
// marker is prefixed with a per-run nonce that the trusted shell holds in a shell
// variable and unsets from the environment before any attempt code runs. Passing
// "" reproduces the original spelling, which is what the pre-nonce tests pin.
/** @param {string} nonce */
export function markers(nonce = "") {
  const p = nonce ? `##CAPSID-${nonce}` : "##CAPSID";
  return { case: `${p}-CASE `, test: `${p}-TEST`, lint: `${p}-LINT`, status: `${p}-STATUS `, end: `${p}-END` };
}

// ---- the per-repo command map -----------------------------------------------
//
// WHY THE MAP LIVES HERE. The secondaries used to be measured by Job A, which
// runs attempt code by design, and handed to the scorer as metrics.json. The
// 2026-09-07 CI plant proved what that costs: a forged metrics.json set
// test_pass_rate 1, lint_count 0 and bundle_size_bytes 1 in a signed report. The
// anchors held; the tuning signal did not. So the two metrics that CAN be
// recomputed are recomputed inside the same --network none --read-only container
// as the holdout, and this file, which is copied off the DEFAULT BRANCH before any
// untrusted byte exists, is where the commands live. An attempt cannot edit it.
//
// EVERY COMMAND MUST RUN OFFLINE. The container has no network, so nothing may
// install, fetch or resolve anything. Binaries come from node_modules on the
// read-only default-branch mount; scripts are invoked directly rather than through
// a package manager, because corepack cannot provision one without a network.
//
// `verified` is the date the command was OBSERVED producing a real number in the
// container. An unverified entry is still run, and a command that does not run
// yields NULL rather than falling back to Job A's forgeable value: a metric we
// could not measure is reported as unmeasured, never as the number the attempt
// wrote down.
export const SECONDARY_COMMANDS = {
  capsid: {
    trees: ["src"],
    test: 'node --test --test-reporter=tap --import ./test/resolve-ts.mjs "test/*.test.ts"',
    lint: "node_modules/.bin/tsc -p tsconfig.test.json --noEmit --pretty false",
    lint_pattern: "error TS[0-9]+",
    verified: "2026-09-07",
  },
  dustinedwards: {
    trees: ["app", "workers"],
    test: "node_modules/.bin/vitest run --reporter=tap",
    lint: null,
    lint_pattern: null,
    verified: null,
  },
  foxhound: {
    trees: ["app", "workers"],
    test: "node_modules/.bin/vitest run --reporter=tap",
    lint: "node_modules/.bin/eslint .",
    lint_pattern: "^[ \t]+[0-9]+:[0-9]+",
    verified: null,
  },
  foxing: {
    trees: ["packages/core", "packages/api", "apps/web"],
    test: "node_modules/.bin/vitest run --reporter=tap",
    lint: "node_modules/.bin/biome check .",
    lint_pattern: "(lint|assist|format)/",
    verified: null,
  },
  germomics: {
    trees: ["app", "workers"],
    // No test or lint script in this repo. Both metrics stay null and the holdout
    // is the only behavioural signal, which is what its scores.md already says.
    test: null,
    lint: null,
    lint_pattern: null,
    verified: "2026-09-07",
  },
};

// The files the trusted step writes into $RUNNER_TEMP/trusted and the container
// reads from a read-only mount. Files rather than an inlined string because the
// container command is a single-quoted shell literal, and embedding a per-repo
// command into it is exactly the quoting hazard that does not need to exist. A
// namespace with no command for a phase gets no file, and the container skips it.
//
// `trees.txt` is the OTHER half of the trusted map and it matters as much as the
// commands. The container builds its working tree as the default-branch checkout
// with these paths, and only these paths, replaced by the attempt. Taking the
// list from the trusted map rather than from whatever /attempt happens to contain
// means an attempt cannot decide which of its own trees are believed, and taking
// each declared tree WHOLE means a file the attempt deleted is deleted in the
// sandbox too, rather than reappearing from the default branch.
/** @param {string} namespace */
export function secondaryScripts(namespace) {
  const spec = /** @type {Record<string, any>} */ (SECONDARY_COMMANDS)[namespace];
  if (!spec) return {};
  /** @type {Record<string, string>} */
  const out = { "trees.txt": (spec.trees ?? []).join("\n") + "\n" };
  if (spec.test) out["secondary-test.sh"] = `${spec.test}\n`;
  if (spec.lint) out["secondary-lint.sh"] = `${spec.lint}\n`;
  return out;
}

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

// Split a concatenated stream into its trusted segments. The container shell
// opens each segment by printing a marker at column 0; everything until the next
// marker belongs to it. Anything before the first marker is container preamble and
// is discarded. `##CAPSID-END` bounds the stream, so a truncated one (a killed
// container) is visible rather than silently scored on partial output.
//
// Four segment kinds: "case" (one holdout file), "test" and "lint" (the secondary
// phases), and "status" (the exit code of the phase that just closed, printed by
// the trusted shell so a phase that could not run is distinguishable from one that
// ran and found nothing).
/**
 * @param {string} text
 * @param {string} nonce
 */
export function splitStream(text, nonce = "") {
  const m = markers(nonce);
  /** @type {{ kind: string, name: string, lines: string[], status: number | null }[]} */
  const segments = [];
  /** @type {{ kind: string, name: string, lines: string[], status: number | null } | null} */
  let current = null;
  let terminated = false;
  const open = (kind, name) => {
    current = { kind, name, lines: [], status: null };
    segments.push(current);
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(m.case)) {
      open("case", line.slice(m.case.length).trim());
      continue;
    }
    if (line === m.test) {
      open("test", "test");
      continue;
    }
    if (line === m.lint) {
      open("lint", "lint");
      continue;
    }
    if (line.startsWith(m.status)) {
      const code = Number.parseInt(line.slice(m.status.length).trim(), 10);
      if (current) current.status = Number.isFinite(code) ? code : null;
      current = null;
      continue;
    }
    if (line === m.end) {
      current = null;
      terminated = true;
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  return { segments, terminated };
}

// The holdout view of the stream: one judgement per case file, with the same rule
// as a single report.
/**
 * @param {string} text
 * @param {string} nonce
 */
export function parseHoldoutStream(text, nonce = "") {
  const { segments, terminated } = splitStream(text, nonce);
  const cases = segments
    .filter((s) => s.kind === "case")
    .map((s) => ({ name: s.name, passed: holdoutFilePassed(s.lines.join("\n")) }));
  return { cases, terminated };
}

// How many holdout cases passed. An unterminated stream scores ZERO, not a
// partial count: a container killed halfway through is a failed measurement, and
// a failed measurement must never look like a good one.
/**
 * @param {string} text
 * @param {string} nonce
 */
export function holdoutPassCount(text, nonce = "") {
  const { cases, terminated } = parseHoldoutStream(text, nonce);
  if (!terminated) return 0;
  return cases.filter((c) => c.passed).length;
}

// THE RECOMPUTED SECONDARIES. Both numbers come out of the container, never out of
// metrics.json.
//
//   test_pass_rate  the top-level TAP ratio of the repo's OWN test command, run in
//                   the sandbox. Null when nothing parseable ran.
//   lint_count      how many lines of the lint command's output match this repo's
//                   pattern. Null when the repo declares no lint command, when the
//                   command could not be executed (126/127), or when the container
//                   did not finish.
//
// A phase that could not run yields null rather than falling back to Job A. That
// asymmetry is the whole point: an unmeasured metric must never be readable as the
// number the attempt wrote down.
/**
 * @param {string} text
 * @param {string} namespace
 * @param {string} nonce
 */
export function secondaryFromStream(text, namespace, nonce = "") {
  const { segments, terminated } = splitStream(text, nonce);
  const spec = /** @type {Record<string, any>} */ (SECONDARY_COMMANDS)[namespace] ?? {};
  const find = (kind) => segments.find((s) => s.kind === kind) ?? null;
  const ran = (seg) => terminated && seg !== null && seg.status !== null && seg.status < 126;

  const testSeg = find("test");
  const test_pass_rate = ran(testSeg) ? testPassRate(testSeg.lines.join("\n")) : null;

  const lintSeg = find("lint");
  let lint_count = null;
  if (ran(lintSeg) && spec.lint_pattern) {
    const re = new RegExp(spec.lint_pattern);
    lint_count = lintSeg.lines.filter((l) => re.test(l)).length;
  }
  return { test_pass_rate, lint_count };
}

// A metric read from Job A's metrics.json: a finite number, or null for anything
// else (missing, "", non-finite). Coercion is refused so a stray value cannot read
// as a real measurement.
/** @param {unknown} value */
function metric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---- CLI --------------------------------------------------------------------
// Six modes, all trusted (this file runs from a stash taken off the default
// branch), none of which runs attempt code:
//   --holdout <reportPath>              exit 0 if that single report passed, 1 otherwise.
//   --holdout-stream <tapPath> [nonce]  print how many cases passed in a piped stream.
//   --rate <testReportPath>             print the top-level pass rate, or "" if nothing ran.
//   --secondary-scripts <ns> <dir>      write this repo's sandbox commands as shell files.
//   --secondary <tapPath> <ns> <nonce> <metricsPath>
//                                       print GITHUB_OUTPUT lines for the RECOMPUTED
//                                       secondaries, and report any disagreement with
//                                       metrics.json on stderr.
//   <metricsPath> <total> <passed>      emit the score-report body to stdout. The
//                                       signing key never touches this.
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
      count = holdoutPassCount(readFileSync(argv[1], "utf8"), argv[2] ?? "");
    } catch {
      count = 0;
    }
    process.stdout.write(String(count));
    return;
  }
  if (argv[0] === "--secondary-scripts") {
    const [, namespace, dir] = argv;
    const files = secondaryScripts(namespace);
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents, { mode: 0o755 });
      process.stderr.write(`secondary command for ${namespace}: ${name} = ${contents.trim()}\n`);
    }
    const spec = /** @type {Record<string, any>} */ (SECONDARY_COMMANDS)[namespace];
    if (!spec) process.stderr.write(`no secondary command map for namespace ${namespace}; both metrics will be null\n`);
    else if (!spec.verified) {
      process.stderr.write(
        `the secondary command map for ${namespace} is UNVERIFIED: no run has yet been observed producing a real number in the sandbox. ` +
          `A command that does not run yields null, never Job A's value.\n`
      );
    }
    return;
  }
  if (argv[0] === "--secondary") {
    const [, tapPath, namespace, nonce, metricsPath] = argv;
    let stream = "";
    try {
      stream = readFileSync(tapPath, "utf8");
    } catch {
      stream = "";
    }
    const recomputed = secondaryFromStream(stream, namespace, nonce ?? "");
    /** @type {Record<string, unknown>} */
    let claimed = {};
    try {
      claimed = JSON.parse(readFileSync(metricsPath, "utf8"));
    } catch {
      claimed = {};
    }
    // THE CROSS-CHECK. metrics.json is written on a runner that has already run
    // attempt code, so a disagreement is exactly what a forged artifact looks
    // like. The container value wins in every case; the disagreement is printed
    // so the run log carries it.
    for (const name of ["test_pass_rate", "lint_count"]) {
      const mine = /** @type {Record<string, unknown>} */ (recomputed)[name];
      const theirs = metric(claimed[name]);
      if (mine !== theirs) {
        process.stderr.write(
          `SECONDARY MISMATCH ${name}: the artifact claims ${JSON.stringify(theirs)}, the sandbox measured ` +
            `${JSON.stringify(mine)}. The sandbox value is used.\n`
        );
      }
    }
    const line = (name, value) => `${name}=${value === null ? "" : String(value)}\n`;
    process.stdout.write(line("test_pass_rate", recomputed.test_pass_rate) + line("lint_count", recomputed.lint_count));
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
  // THE RECOMPUTED SECONDARIES ARE NOT READ FROM THE ARTIFACT EITHER (2026-09-07).
  // test_pass_rate and lint_count come from the sandbox run, through the score
  // job's own step outputs. metrics.json is read for bundle_size_bytes and for
  // NOTHING else: it is the one secondary no offline container can recompute,
  // because measuring it means running the repo's bundler.
  const body = {
    namespace: process.env.IMPROVE_NAMESPACE,
    run_id: process.env.RUN_ID,
    attempt_id: process.env.ATTEMPT_ID,
    head_sha: process.env.ATTEMPT_HEAD_SHA,
    jti: randomUUID(),
    anchors: { build_passes: buildPasses },
    secondary: {
      test_pass_rate: metric(numOrNull(process.env.SECONDARY_TEST_PASS_RATE)),
      lint_count: metric(numOrNull(process.env.SECONDARY_LINT_COUNT)),
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
