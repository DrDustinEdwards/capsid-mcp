// Trusted scoring glue for improve-score.yml, run from the DEFAULT branch in the
// scorer's second job, from a copy stashed in $RUNNER_TEMP before any untrusted byte
// exists on the runner. It never runs attempt-controlled code: it reads the TAP the
// reporter produced and counts results from the TOP-LEVEL ok / not ok lines, not from
// a process exit code. That is the fix for the 2026-09-06 CRITICAL where an attempt
// forced holdout_pass_rate to 1.0 by calling process.exit(0) before assertions ran: an
// early exit means the file's ok line is never written, so the pass it never earned is
// absent rather than assumed.
//
// TAP, not "json": node --test has no builtin json reporter (tap, spec, dot, junit,
// lcov). TAP is the line-oriented one, and a top-level result is an `ok N` or `not ok
// N` at column 0. Subtests are indented under `# Subtest:` and are not counted, so a
// suite using subtests is not double-weighted.
//
// THE STREAM MODE IS THE 2026-09-07 FIX (Opus CRITICAL 5.1, Grok CRITICAL 2). Holdout
// cases used to run with --test-reporter-destination pointed at a file inside the
// attempt's own filesystem, which the attempt could rewrite from process.on('exit')
// after the reporter flushed. There is no destination file now: the container writes
// TAP to its stdout, the runner captures that pipe outside the container, and this
// script splits the stream on the ##CAPSID-CASE markers the trusted container shell
// emits. A test's own stdout is re-emitted by node's TAP reporter as `# ` comment
// lines, so nothing a test prints can produce a result line or a marker at column 0.
//
// THIS FILE IS BYTE-IDENTICAL ACROSS ALL FIVE ROSTER REPOS, like the score job that
// calls it. Only Job A differs per repo. Pure functions are exported for
// test/improve-report.test.ts; the CLI modes are repo-agnostic.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// The marker the trusted container shell prints before each case file. Matched at
// column 0, which a test cannot reach: node's TAP reporter prefixes every line a test
// writes to stdout with "# ", so an injected "##CAPSID-CASE x" arrives as
// "# ##CAPSID-CASE x" and does not match.
export const CASE_MARKER = "##CAPSID-CASE ";

// THE NONCE (2026-09-07, secondaries-in-the-container). TAP escaping protects only
// output that went through node's TAP reporter. The secondary phases pipe a lint
// tool's RAW stdout into the same stream, and a lint diagnostic can carry attacker
// text at column 0. Every marker is prefixed with a per-run nonce the trusted shell
// holds in a shell variable and unsets from the environment before any attempt code
// runs. Passing "" reproduces the original spelling, which the pre-nonce tests pin.
/** @param {string} nonce */
export function markers(nonce = "") {
  const p = nonce ? `##CAPSID-${nonce}` : "##CAPSID";
  return { case: `${p}-CASE `, test: `${p}-TEST`, lint: `${p}-LINT`, status: `${p}-STATUS `, end: `${p}-END` };
}

// One segment of the container's output stream: a holdout case, or one of the two
// secondary phases, plus the exit status the trusted shell printed after it. Declared
// once because splitStream builds them and both readers narrow them.
/**
 * @typedef {object} Segment
 * @property {string} kind
 * @property {string} name
 * @property {string[]} lines
 * @property {number | null} status
 */

// ---- the per-repo command map -----------------------------------------------
//
// WHY THE MAP LIVES HERE. The secondaries used to be measured by Job A, which runs
// attempt code by design, and handed to the scorer as metrics.json. The 2026-09-07 CI
// plant set test_pass_rate 1, lint_count 0 and bundle_size_bytes 1 in a signed report:
// the anchors held, the tuning signal did not. The two metrics that CAN be recomputed
// are recomputed inside the same --network none --read-only container as the holdout,
// and this file, copied off the DEFAULT BRANCH before any untrusted byte exists, is
// where the commands live.
//
// EVERY COMMAND MUST RUN OFFLINE. The container has no network, so nothing may
// install, fetch or resolve. Binaries come from node_modules on the read-only
// default-branch mount; scripts are invoked directly rather than through a package
// manager, because corepack cannot provision one without a network.
//
// `verified` is the date the command was OBSERVED producing a real number in the
// container. An unverified entry is still run, and a command that does not run yields
// NULL rather than falling back to Job A's forgeable value.
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
    verified: "2026-09-08",
  },
  foxhound: {
    trees: ["app", "workers"],
    test: "node_modules/.bin/vitest run --reporter=tap",
    lint: "node_modules/.bin/eslint .",
    lint_pattern: "^[ \t]+[0-9]+:[0-9]+",
    verified: "2026-09-08",
  },
  foxing: {
    trees: ["packages/core", "packages/api", "apps/web"],
    // UNIT TESTS ONLY, and that took two exclusions rather than one (ruled
    // 2026-09-08). The bare `vitest run` swept in apps/web/e2e/*.spec.ts, playwright
    // specs that cannot run behind --network none: 58 top-level results, 38 of them
    // failing for the environment rather than the code, and the repo scored 0.3448.
    //
    // Excluding e2e by folder took it to 0.5263 and revealed the second set:
    // *.integration.test.ts lives under test/ rather than e2e/, so a folder exclusion
    // never reached it. Both are UNSCORED and foxing/improve/scores.md says so.
    //
    // Neither is excluded to make a number go up. A score the loop cannot move is noise
    // it optimises against, and the hidden holdout suite covers what the unit tests do
    // not.
    test:
      'node_modules/.bin/vitest run --reporter=tap --exclude "**/e2e/**" --exclude "**/*.integration.test.ts"',
    lint: "node_modules/.bin/biome check .",
    lint_pattern: "(lint|assist|format)/",
    verified: "2026-09-08",
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

// ---- the holdout import manifest --------------------------------------------
//
// NOT A SECURITY CONTROL. `improve/holdout/<ns>/imports.txt` lists every name the
// hidden suite imports out of the repo's own source. Names only, one per line,
// committed and deliberately NOT secret: an export name is already in the source.
//
// WHAT IT BUYS, ruled 2026-09-08 after it cost a broken anchor. The bloat pass removed
// two exports on a scan that found no caller in src/ or test/. The holdout imports
// both, and the holdout is structurally invisible to anything that runs in the repo.
// The result was 28 of 30 against an anchor of min 1.0, which would have reverted
// every attempt forever. The list is the missing third place to look.
//
// TWO CONSUMERS, pulling in opposite directions and both needed:
//
//   the dead-export check   treats a name here as a caller, so removing it is a build
//                           failure rather than a surprise at 03:00.
//   Job B                   refuses a holdout case importing a name that is NOT here,
//                           so the list cannot fall behind the suite it describes.
export const HOLDOUT_IMPORTS_FILE = "imports.txt";

/** @param {string} namespace */
export function holdoutImportsPath(namespace) {
  return `improve/holdout/${namespace}/${HOLDOUT_IMPORTS_FILE}`;
}

// Names only. Blank lines and `#` comments are allowed so the file can say what it
// is; anything else is a name.
/** @param {string} text */
export function parseImportsManifest(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

// Every NAME a holdout case imports from the repo's own source. Matched on the import
// specifier being relative (../src/..., ../../app/...): an import of a node builtin or
// an npm package says nothing about this repo's exports.
//
// Default and namespace imports are reported under the names they bind, since removing
// what they point at breaks the case just the same.
/** @param {string} text */
export function importedNames(text) {
  /** @type {Set<string>} */
  const names = new Set();
  // ANCHORED AT A STATEMENT START, and the clause may not cross a `;`.
  //
  // The first spelling used a lazy `[\s\S]*?` for the clause, which crossed statement
  // boundaries: in a file whose first relative import is the third line, the match
  // began at line one and swallowed the two node-builtin imports above it. The first
  // five runs of this gate reported names like `assert`, `from` and `import`. An
  // import clause never contains a semicolon, so `[^;]*?` is the boundary.
  const re = /(?:^|\n)\s*import\s+([^;]*?)\s+from\s+["'](\.[^"']*)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const clause = m[1].trim();
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name) names.add(name);
      }
    }
    const bare = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
    for (const part of bare.split(/\s+/)) {
      const name = part.replace(/^\*$/, "").replace(/^type$/, "").trim();
      if (name && name !== "as") names.add(name);
    }
  }
  // A name is a JavaScript identifier and nothing else. A second check after the regex
  // above: a token that is not one is a parse artefact.
  //
  // THE SNAPSHOT IS LOAD-BEARING, and it is a NAMED CONST rather than a spread in the
  // for-of head. The loop DELETES from `names` while walking it, so it has to walk a
  // copy; written inline as `for (const name of [...names])` that is the exact shape
  // unicorn/no-useless-spread reports, because the rule cannot see the iterable is
  // mutated underneath it.
  //
  // NO SUPPRESSION COMMENT. This file is copied BYTE-IDENTICAL into five repos and they
  // do not all load the same lint plugins: an `eslint-disable` naming
  // unicorn/no-useless-spread is itself an error ("Definition for rule was not found")
  // in every repo whose config lacks the plugin, which turned foxhound's main red. A
  // disable comment is a dependency on another repo's plugin list.
  const scanned = [...names];
  for (const name of scanned) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) names.delete(name);
  }
  return names;
}

// The Job B gate. Returns the refusal to print and fail on, or null to proceed. It
// NEVER names a case file: a filename is part of the hidden suite and this runs in a
// job whose log is readable. It names the missing IMPORTS, which are source export
// names and are what the operator has to add.
/**
 * @param {string[]} caseTexts
 * @param {string[] | null} declared
 * @param {string} namespace
 */
export function holdoutImportRefusal(caseTexts, declared, namespace) {
  /** @type {Set<string>} */
  const used = new Set();
  for (const text of caseTexts) for (const name of importedNames(text)) used.add(name);
  const sorted = [...used].sort();
  if (declared === null) {
    return (
      `no ${holdoutImportsPath(namespace)} in this repo. The hidden suite imports names out of this repo's source, ` +
      `and nothing that runs here can see which, so a bloat pass removing one is a broken anchor nobody predicted. ` +
      `Create the file with these ${sorted.length} names, one per line:
${sorted.join("\n")}`
    );
  }
  const missing = sorted.filter((n) => !declared.includes(n));
  if (missing.length > 0) {
    return (
      `the hidden suite imports ${missing.length} name(s) that ${holdoutImportsPath(namespace)} does not list: ` +
      `${missing.join(", ")}. Add them, or stop importing them. The list is what makes those exports undeletable.`
    );
  }
  return null;
}

// The files the trusted step writes into $RUNNER_TEMP/trusted and the container reads
// from a read-only mount. Files rather than an inlined string because the container
// command is a single-quoted shell literal, and embedding a per-repo command into it is
// a quoting hazard. A namespace with no command for a phase gets no file, and the
// container skips it.
//
// `trees.txt` is the OTHER half of the trusted map. The container builds its working
// tree as the default-branch checkout with these paths, and only these paths, replaced
// by the attempt. Taking the list from the trusted map rather than from whatever
// /attempt contains means an attempt cannot decide which of its own trees are believed,
// and taking each declared tree WHOLE means a file the attempt deleted stays deleted.
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
// top-level not-ok. Zero results (the process.exit(0) case, or a load error) is NOT a
// pass: silence cannot score.
/** @param {string} text */
export function holdoutFilePassed(text) {
  const { pass, fail } = parseTestReport(text);
  return pass > 0 && fail === 0;
}

// Split a concatenated stream into its trusted segments. The container shell opens each
// segment by printing a marker at column 0; everything until the next marker belongs to
// it. Anything before the first marker is container preamble and is discarded.
// `##CAPSID-END` bounds the stream, so a truncated one (a killed container) is visible
// rather than silently scored on partial output.
//
// Four segment kinds: "case" (one holdout file), "test" and "lint" (the secondary
// phases), and "status" (the exit code of the phase that just closed, printed by the
// trusted shell so a phase that could not run is distinguishable from one that ran and
// found nothing).
/**
 * @param {string} text
 * @param {string} nonce
 */
export function splitStream(text, nonce = "") {
  const m = markers(nonce);
  /** @type {Segment[]} */
  const segments = [];
  /** @type {Segment | null} */
  let current = null;
  let terminated = false;
  // `open` RETURNS the segment and the loop assigns `current`, rather than assigning it
  // from inside the closure. A checker cannot follow an assignment made in a callback,
  // so the closure form narrowed `current` to `never` at every later use: it
  // type-checks under this repo's config, which does not check .mjs bodies, and fails
  // under dustinedwards-info's, which does.
  /**
   * @param {string} kind
   * @param {string} name
   * @returns {Segment}
   */
  const open = (kind, name) => {
    /** @type {Segment} */
    const segment = { kind, name, lines: [], status: null };
    segments.push(segment);
    return segment;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(m.case)) {
      current = open("case", line.slice(m.case.length).trim());
      continue;
    }
    if (line === m.test) {
      current = open("test", "test");
      continue;
    }
    if (line === m.lint) {
      current = open("lint", "lint");
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

// How many holdout cases passed. An unterminated stream scores ZERO, not a partial
// count: a container killed halfway through is a failed measurement, and a failed
// measurement must never look like a good one.
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
//   test_pass_rate  the top-level TAP ratio of the repo's OWN test command, run in the
//                   sandbox. Null when nothing parseable ran.
//   lint_count      how many lines of the lint command's output match this repo's
//                   pattern. Null when the repo declares no lint command, when the
//                   command could not be executed (126/127), or when the container did
//                   not finish.
//
// A phase that could not run yields null rather than falling back to Job A: an
// unmeasured metric must never be readable as the number the attempt wrote down.
/**
 * @param {string} text
 * @param {string} namespace
 * @param {string} nonce
 */
export function secondaryFromStream(text, namespace, nonce = "") {
  const { segments, terminated } = splitStream(text, nonce);
  const spec = /** @type {Record<string, any>} */ (SECONDARY_COMMANDS)[namespace] ?? {};
  /** @param {string} kind @returns {Segment | null} */
  const find = (kind) => segments.find((/** @type {Segment} */ s) => s.kind === kind) ?? null;
  // A phase RAN if the container finished and the phase reported an exit status that is
  // not "could not execute" (126, 127). Written as an explicit null check rather than a
  // predicate helper so the narrowing is visible to a checker: the callers below
  // dereference `.lines` on the strength of it.
  /** @param {Segment | null} seg */
  const ran = (seg) => terminated && seg !== null && seg.status !== null && seg.status < 126;

  const testSeg = find("test");
  const test_pass_rate = testSeg !== null && ran(testSeg) ? testPassRate(testSeg.lines.join("\n")) : null;

  const lintSeg = find("lint");
  /** @type {number | null} */
  let lint_count = null;
  if (lintSeg !== null && ran(lintSeg) && spec.lint_pattern) {
    const re = new RegExp(spec.lint_pattern);
    const matches = lintSeg.lines.filter((/** @type {string} */ l) => re.test(l)).length;
    // A CRASH IS NOT A CLEAN LINT. Measured on foxing 2026-09-08: biome could not
    // resolve its platform binary, exited 1, printed a Node module-not-found dump, and
    // NOTHING in that dump matched the count pattern, so "zero matches" read as "zero
    // problems" and the report carried lint_count 0 for a lint that never ran. A clean
    // lint exits 0; a lint that found problems exits nonzero AND matches the pattern.
    // Nonzero with no matches is neither, so it is null.
    lint_count = matches > 0 || lintSeg.status === 0 ? matches : null;
  }
  return { test_pass_rate, lint_count };
}

// THE SECONDARY METRICS THIS SCORER ACTUALLY REPORTS, in report order.
//
// It used to be five. error_count and p95_latency_ms were emitted as a literal null on
// every run, by every repo, since the loop was built, and were declared in all five
// scores documents as though they were signals (audits 2026-09-07, MAJOR 5.7).
// germomics' document read as five and behaved as one.
//
// test/null-metrics.test.ts derives seedScoresDoc's Secondary list from this array and
// fails in BOTH directions, so a metric cannot be declared in the canon without
// something reporting it, or reported without being declared.
export const REPORTED_SECONDARY = ["test_pass_rate", "lint_count", "bundle_size_bytes"];

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
  // Job B's gate on the holdout import manifest. Reads the synced holdout directory and
  // this repo's committed list, and exits non-zero with a named refusal when they
  // disagree. It never prints a case FILENAME: a filename is part of the hidden suite
  // and this runs in a job whose log is readable.
  if (argv[0] === "--check-holdout-imports") {
    const [, holdoutDir, namespace, manifestPath] = argv;
    /** @type {string[]} */
    const texts = [];
    try {
      for (const name of readdirSync(holdoutDir)) {
        if (!/\.test\./.test(name)) continue;
        texts.push(readFileSync(join(holdoutDir, name), "utf8"));
      }
    } catch (err) {
      process.stderr.write(`could not read the holdout directory: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    if (texts.length === 0) {
      process.stderr.write("no holdout cases were synced, so their imports cannot be checked. Refusing rather than passing on an empty read.\n");
      process.exit(1);
    }
    /** @type {string[] | null} */
    let declared = null;
    try {
      declared = parseImportsManifest(readFileSync(manifestPath, "utf8"));
    } catch {
      declared = null;
    }
    const refusal = holdoutImportRefusal(texts, declared, namespace);
    if (refusal) {
      process.stderr.write(`${refusal}\n`);
      process.exit(1);
    }
    process.stdout.write(`holdout imports: ${declared?.length ?? 0} declared, all accounted for across ${texts.length} cases\n`);
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

    // WHY IT IS NULL, IN THE RUN LOG. A null that does not say why is the shape this
    // change exists to stop. The four roster repos reported null on their first scored
    // run and the log could not distinguish "the command was not found" from "it ran and
    // produced no parseable result", which is the difference between a typo in the map
    // and a reporter flag the tool no longer supports.
    const { segments, terminated } = splitStream(stream, nonce ?? "");
    if (!terminated) {
      process.stderr.write("SECONDARY: the container did not finish; every recomputed metric is null.\n");
    }
    for (const kind of ["test", "lint"]) {
      const seg = segments.find((x) => x.kind === kind);
      if (!seg) {
        process.stderr.write(`SECONDARY ${kind}: no phase ran (this namespace declares no ${kind} command).\n`);
        continue;
      }
      const why =
        seg.status === null
          ? "no exit status was printed"
          : seg.status >= 126
            ? `exit ${seg.status}, which is "could not execute": check the command in SECONDARY_COMMANDS`
            : `exit ${seg.status}`;
      // HEAD AND TAIL. The tail of a Node crash is the version banner, which says
      // nothing. The message naming the missing module is at the TOP, and printing only
      // the tail turned "vitest could not resolve X" into three closing braces.
      const nonEmpty = seg.lines.filter((l) => l.trim() !== "");
      process.stderr.write(
        `SECONDARY ${kind}: ${seg.lines.length} lines, ${why}. First: ${JSON.stringify(nonEmpty.slice(0, 3))}\n`
      );
      process.stderr.write(`SECONDARY ${kind}: last: ${JSON.stringify(nonEmpty.slice(-3))}\n`);
    }
    /** @type {Record<string, unknown>} */
    let claimed = {};
    try {
      claimed = JSON.parse(readFileSync(metricsPath, "utf8"));
    } catch {
      claimed = {};
    }
    // THE CROSS-CHECK. metrics.json is written on a runner that has already run attempt
    // code, so a disagreement is what a forged artifact looks like. The container value
    // wins in every case; the disagreement is printed so the run log carries it.
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
    /**
     * @param {string} name
     * @param {number | null} value
     */
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
  // BUILD_PASSES comes from Job A's job output, which the Actions runner sets from the
  // build step's own outcome. metrics.json is written on a runner that has already
  // executed attempt code and is treated as hostile for this field. Absent is 0, not 1.
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
