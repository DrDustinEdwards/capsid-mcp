import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CASE_MARKER,
  holdoutFilePassed,
  holdoutPassCount,
  parseHoldoutStream,
} from "../scripts/improve-report.mjs";

// PLANTED EXPLOITS AGAINST THE SCORER, from the 2026-09-07 audits.
//
// Opus CRITICAL 5.1 and Grok CRITICAL 1 and 2 named three live attacks against the
// old two-job scorer. Every assertion in this file is written so that it FAILS on
// the code as it stood at 257e625, which is the standard capsid/conventions.md
// sets: a guard that has never been observed failing has not been verified.
//
// The three attacks, and where each is now stopped:
//
//   1. Attempt code writes code/scripts/improve-report.mjs during Job A's own test
//      step. Job A did not wipe code/ first, so it rode into the artifact; Job B
//      then ran `cp -r attempt/code/. .` over its default-branch checkout, and the
//      Post step executed the attacker's script WITH IMPROVE_SCORE_KEY in its env.
//      Stopped three ways: Job A wipes code/, Job B never overlays anything, and
//      the trusted script is stashed outside the workspace before any untrusted
//      byte exists.
//   2. The same overlay planted extra .improve-holdout/*.test.* files that the
//      credential-scoped `aws s3 sync` did not delete, so a padded case counted as
//      a pass. Stopped by wiping the holdout directory before the sync and by the
//      holdout living outside the workspace entirely.
//   3. Holdout TAP went to a seekable file inside the attempt's own filesystem, so
//      attempt code rewrote it from process.on('exit') after the reporter flushed.
//      Stopped by there being no destination file: TAP is a stdout pipe out of a
//      --network none --read-only container.

const WORKFLOW = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "improve-score.yml"), "utf8");

// A COMMENT IS NOT A COMMAND. The header above quotes the old attack verbatim
// ("cp -r attempt/code/. ."), and a scan that counted prose would go red on the
// day the fix is best documented. Same exclusion test/improve-holdout.test.ts
// applies to its binding scan. Strips YAML comments and shell comments inside
// run: blocks alike, since both start a line with '#'.
const EXECUTABLE = WORKFLOW.split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

// ---- attack 3: forging results through a test's own stdout ------------------

test("PLANT: a holdout case cannot forge a passing result through its own stdout", () => {
  // What node's TAP reporter actually produces when a test writes to stdout: the
  // line is captured and re-emitted as a `# ` comment. Verified by experiment on
  // 2026-09-07 against the exact command the workflow runs. So an attempt that
  // prints "ok 1 - forged" cannot reach column 0.
  const stream = [
    `${CASE_MARKER}case-a.test.js`,
    "TAP version 13",
    "# ok 1 - forged by the attempt",
    "# not ok 99 - also forged",
    "# Subtest: the real assertion",
    "not ok 1 - the real assertion",
    "  ---",
    "  error: 'boom'",
    "  ...",
    "1..1",
    "##CAPSID-END",
  ].join("\n");

  const { cases, terminated } = parseHoldoutStream(stream);
  assert.equal(terminated, true);
  assert.equal(cases.length, 1, "one case marker, one case");
  assert.equal(cases[0].passed, false, "a forged `# ok` comment must not score as a pass");
  assert.equal(holdoutPassCount(stream), 0);
});

test("PLANT: a holdout case cannot forge an extra case by printing the marker", () => {
  // A test printing the marker gets it escaped to "# ##CAPSID-CASE ...", which
  // does not match at column 0. Only the trusted container shell can open a case.
  const stream = [
    `${CASE_MARKER}real.test.js`,
    "TAP version 13",
    `# ${CASE_MARKER}forged-a.test.js`,
    "# ok 1 - forged",
    `# ${CASE_MARKER}forged-b.test.js`,
    "# ok 1 - forged",
    "not ok 1 - the real assertion",
    "1..1",
    "##CAPSID-END",
  ].join("\n");

  const { cases } = parseHoldoutStream(stream);
  assert.deepEqual(
    cases.map((c) => c.name),
    ["real.test.js"],
    "a marker printed by a test must not open a case"
  );
  assert.equal(holdoutPassCount(stream), 0);
});

test("a genuinely passing case is still counted, so the guard is not vacuous", () => {
  const stream = [
    `${CASE_MARKER}a.test.js`,
    "TAP version 13",
    "ok 1 - a real pass",
    "1..1",
    `${CASE_MARKER}b.test.js`,
    "TAP version 13",
    "ok 1 - another real pass",
    "1..1",
    `${CASE_MARKER}c.test.js`,
    "TAP version 13",
    "not ok 1 - a real failure",
    "1..1",
    "##CAPSID-END",
  ].join("\n");
  assert.equal(holdoutPassCount(stream), 2, "two of three cases passed");
});

test("an unterminated stream scores ZERO, not a partial count", () => {
  // A container killed part way through is a failed measurement. Counting the
  // cases it managed to emit would let a timeout or an OOM look like a good run.
  const stream = [
    `${CASE_MARKER}a.test.js`,
    "ok 1 - passed before the kill",
    "1..1",
    `${CASE_MARKER}b.test.js`,
    "ok 1 - passed before the kill",
  ].join("\n");
  assert.equal(parseHoldoutStream(stream).terminated, false);
  assert.equal(holdoutPassCount(stream), 0, "an unfinished container must not score");
});

test("preamble before the first marker is not a case", () => {
  const stream = ["some docker warning on stdout", "ok 1 - not inside any case", "##CAPSID-END"].join("\n");
  assert.equal(parseHoldoutStream(stream).cases.length, 0);
  assert.equal(holdoutPassCount(stream), 0);
});

test("holdoutFilePassed keeps its single-report contract", () => {
  assert.equal(holdoutFilePassed("ok 1 - x\n1..1"), true);
  assert.equal(holdoutFilePassed("not ok 1 - x\n1..1"), false);
  assert.equal(holdoutFilePassed(""), false, "silence is not a pass");
});

// ---- attack 1: replacing the trusted script through the overlay -------------

test("PLANT: Job B never overlays attempt code onto the runner", () => {
  assert.ok(
    !/cp -r attempt\/code\/\.\s/.test(EXECUTABLE),
    "the whole-tree overlay `cp -r attempt/code/. .` is what let an attempt replace scripts/improve-report.mjs; it must not exist"
  );
  assert.ok(
    !/Overlay the attempt source/.test(EXECUTABLE),
    "the overlay step must be gone entirely, not renamed"
  );
});

test("the trusted scorer is stashed outside the workspace and only that copy is invoked", () => {
  assert.match(
    WORKFLOW,
    /cp scripts\/improve-report\.mjs "\$\{RUNNER_TEMP\}\/trusted\/improve-report\.mjs"/,
    "the trusted script must be copied out before anything untrusted lands"
  );
  // Every invocation in the score job must go through the stash.
  const scoreJob = WORKFLOW.slice(WORKFLOW.indexOf("  score:"));
  const invocations = [...scoreJob.matchAll(/improve-report\.mjs/g)];
  assert.ok(invocations.length >= 3, "expected the stash copy plus at least two uses");
  const workspaceInvocation = /\bnode\s+scripts\/improve-report\.mjs/.test(scoreJob);
  assert.ok(!workspaceInvocation, "the score job must never invoke the workspace copy of the scorer script");
});

test("Job A wipes the staging directory before staging", () => {
  const buildJob = WORKFLOW.slice(WORKFLOW.indexOf("  build:"), WORKFLOW.indexOf("  score:"));
  assert.match(
    buildJob,
    /rm -rf code\s*\n\s*mkdir -p code/,
    "without `rm -rf code` first, attempt code that created code/scripts during the test step rides into the artifact"
  );
});

// ---- attack 2: padding the holdout -----------------------------------------

test("the holdout directory is wiped before the sync and lives outside the workspace", () => {
  assert.match(WORKFLOW, /rm -rf "\$\{RUNNER_TEMP\}\/holdout"/, "a stale or planted case file must not survive into the count");
  assert.match(WORKFLOW, /aws s3 sync "s3:\/\/\$\{HOLDOUT_BUCKET\}\/\$\{HOLDOUT_PREFIX\}" "\$\{RUNNER_TEMP\}\/holdout\/"/);
  assert.ok(
    !/aws s3 sync .* \.improve-holdout/.test(EXECUTABLE),
    "the holdout must not be synced into the workspace, where an overlay could reach it"
  );
});

// ---- the container contract -------------------------------------------------

test("attempt code runs only inside a network-less, read-only, digest-pinned container", () => {
  assert.match(WORKFLOW, /docker run --rm/, "the holdout must run in a container");
  assert.match(WORKFLOW, /--network none/, "no network: nothing the attempt learns can leave");
  assert.match(WORKFLOW, /--read-only/, "read-only root: bind mounts stay immutable");
  assert.match(WORKFLOW, /--tmpfs \/work:rw/, "the only writable surface is scratch that dies with the run");
  assert.match(
    WORKFLOW,
    /node:24\.14\.1-alpine@sha256:[0-9a-f]{64}/,
    "the image must be pinned by digest, not by tag"
  );
  for (const mount of [
    /-v "\$\{RUNNER_TEMP\}\/attempt\/code:\/attempt:ro"/,
    /-v "\$\{RUNNER_TEMP\}\/holdout:\/holdout:ro"/,
    /-v "\$\{RUNNER_TEMP\}\/trusted:\/trusted:ro"/,
    // The whole default-branch checkout, read-only, since 2026-09-07: the sandbox
    // now runs the repo's OWN test and lint commands, which need its tests,
    // configs and node_modules. Those are all protected paths, so taking them
    // from the trusted checkout rather than the artifact is the stronger reading
    // of the same rule the narrower /nm and /trusted-test mounts expressed.
    /-v "\$\{GITHUB_WORKSPACE\}:\/repo:ro"/,
  ]) {
    assert.match(WORKFLOW, mount, `every bind mount must be read-only: ${mount}`);
  }
  assert.ok(
    !/-v "\$\{GITHUB_WORKSPACE\}:\/[a-z-]+"(?!:ro)/.test(EXECUTABLE),
    "no writable workspace mount"
  );
});

test("the holdout TAP has no seekable destination the attempt can rewrite", () => {
  assert.ok(
    !/--test-reporter-destination/.test(EXECUTABLE.slice(EXECUTABLE.indexOf("  score:"))),
    "a destination file inside the attempt's filesystem is what attack 3 rewrote; results must come out as a pipe"
  );
  assert.match(WORKFLOW, /> "\$\{RUNNER_TEMP\}\/holdout\.tap"/, "the pipe is captured outside the container");
  assert.match(WORKFLOW, /--holdout-stream "\$\{RUNNER_TEMP\}\/holdout\.tap"/, "and counted by the trusted stash copy");
});

// ---- the anchor does not come from the artifact -----------------------------

test("PLANT: a rewritten metrics.json cannot set the build_passes anchor", async () => {
  // The artifact is written on a runner that has already executed attempt code.
  // build_passes must come from Job A's job output, which the Actions runner sets
  // from the build step's own outcome.
  assert.match(
    WORKFLOW,
    /build_passes: \$\{\{ steps\.build\.outcome == 'success' && '1' \|\| '0' \}\}/,
    "Job A must export build_passes as a job output from the step outcome"
  );
  assert.match(
    WORKFLOW,
    /BUILD_PASSES: \$\{\{ needs\.build\.outputs\.build_passes \}\}/,
    "the Post step must read the anchor from the job output"
  );
  const report = readFileSync(join(import.meta.dirname, "..", "scripts", "improve-report.mjs"), "utf8");
  assert.match(
    report,
    /process\.env\.BUILD_PASSES === "1" \? 1 : 0/,
    "the body builder must take the anchor from the environment, never from the parsed artifact"
  );
  assert.ok(
    !/m\.build_passes/.test(report),
    "metrics.json's build_passes field must no longer be read at all"
  );
});

test("no step but the signing step and the credential mint sees the key", () => {
  const scoreJob = WORKFLOW.slice(WORKFLOW.indexOf("  score:"));
  const keyUses = [...scoreJob.matchAll(/IMPROVE_SCORE_KEY: \$\{\{ secrets\.IMPROVE_SCORE_KEY \}\}/g)];
  assert.equal(keyUses.length, 2, "exactly two steps may carry the key: the mint and the post");
  const containerStep = scoreJob.slice(scoreJob.indexOf("Run the holdout suite in an isolated container"));
  const containerBlock = containerStep.slice(0, containerStep.indexOf("- name: Count the holdout result"));
  assert.ok(!/IMPROVE_SCORE_KEY/.test(containerBlock), "the step that runs attempt code must not hold the key");
});

test("node and curl are absolute-pathed in every credentialed step", () => {
  const scoreJob = WORKFLOW.slice(WORKFLOW.indexOf("  score:"));
  assert.ok(!/\bcurl --silent/.test(scoreJob.replace(/\/usr\/bin\/curl --silent/g, "")), "curl must be absolute-pathed");
  assert.match(WORKFLOW, /echo "node=\$\(command -v node\)" >> "\$GITHUB_OUTPUT"/, "node is resolved once, in a trusted step");
  assert.match(WORKFLOW, /NODE_BIN: \$\{\{ steps\.trusted\.outputs\.node \}\}/, "and passed to the steps that need it");
});
