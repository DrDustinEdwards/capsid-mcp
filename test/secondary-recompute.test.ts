import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SECONDARY_COMMANDS, markers, secondaryFromStream, secondaryScripts, splitStream } from "../scripts/improve-report.mjs";

// THE SECONDARIES COME OUT OF THE SANDBOX, NOT OUT OF THE ARTIFACT.
//
// The 2026-09-07 remediation closed the anchors (build_passes from a job output,
// holdout_pass_rate from a container's stdout pipe) and said so about what it left
// open: "the secondaries are still forgeable, and the CI plant proved it. In run
// 34162010375 the forged metrics.json DID set test_pass_rate: 1, lint_count: 0 and
// bundle_size_bytes: 1 in the signed report."
//
// So test_pass_rate and lint_count are now measured by the repo's own commands
// inside the same --network none --read-only container as the holdout, and
// metrics.json is read for bundle_size_bytes alone. Every assertion below is
// written to FAIL against the scorer as it stood at b464cd8, which is the standard
// capsid/conventions.md sets: a guard that has never been observed failing has not
// been verified.

const ROOT = join(import.meta.dirname, "..");
const SCORER = join(ROOT, "scripts", "improve-report.mjs");
const WORKFLOW = readFileSync(join(ROOT, ".github", "workflows", "improve-score.yml"), "utf8");
const EXECUTABLE = WORKFLOW.split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

const NONCE = "d34db33f";
const M = markers(NONCE);

function stream(lines: string[]): string {
  return lines.join("\n");
}

function runScorer(args: string[], env: Record<string, string>): string {
  return execFileSync(process.execPath, [SCORER, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// ---- THE PLANT --------------------------------------------------------------

test("PLANT: a forged metrics.json claiming test_pass_rate 1 does not survive", () => {
  // This is run 34162010375's payload, verbatim in shape: an artifact written on a
  // runner that has already executed attempt code, claiming a perfect suite and a
  // clean lint. The sandbox measured something else.
  const dir = mkdtempSync(join(tmpdir(), "capsid-secondary-"));
  const metricsPath = join(dir, "metrics.json");
  writeFileSync(
    metricsPath,
    JSON.stringify({ build_passes: 1, test_pass_rate: 1, lint_count: 0, bundle_size_bytes: 1 })
  );

  const tapPath = join(dir, "holdout.tap");
  writeFileSync(
    tapPath,
    stream([
      `${M.case}case-a.test.js`,
      "ok 1 - a real holdout case",
      "1..1",
      M.test,
      "TAP version 13",
      "ok 1 - suite one",
      "ok 2 - suite two",
      "not ok 3 - suite three",
      "not ok 4 - suite four",
      "1..4",
      `${M.status}1`,
      M.lint,
      "src/a.ts(3,9): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(7,1): error TS2554: Expected 1 arguments, but got 2.",
      `${M.status}2`,
      M.end,
    ])
  );

  const out = runScorer(["--secondary", tapPath, "capsid", NONCE, metricsPath], {});
  const parsed = Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => line.split("=") as [string, string])
  );
  assert.equal(parsed.test_pass_rate, "0.5", "the sandbox measured 2 of 4, and that is the number that counts");
  assert.equal(parsed.lint_count, "2", "the sandbox saw two type errors, not the artifact's zero");

  // And the body the scorer signs carries the sandbox numbers, not the forged ones.
  const body = JSON.parse(
    runScorer([metricsPath, "30", "30"], {
      IMPROVE_NAMESPACE: "capsid",
      RUN_ID: "r1",
      ATTEMPT_ID: "a1",
      ATTEMPT_HEAD_SHA: "deadbeef",
      BUILD_PASSES: "1",
      SECONDARY_TEST_PASS_RATE: parsed.test_pass_rate,
      SECONDARY_LINT_COUNT: parsed.lint_count,
    })
  );
  assert.equal(body.secondary.test_pass_rate, 0.5, "the forged 1 must not reach the signed report");
  assert.equal(body.secondary.lint_count, 2, "the forged 0 must not reach the signed report");
  assert.equal(body.secondary.bundle_size_bytes, 1, "bundle_size_bytes is the one metric still read from the artifact");
});

test("PLANT: with no sandbox measurement the metric is null, never the artifact's value", () => {
  // The failure mode this exists to stop: a container that could not run the test
  // command falling back to metrics.json, which is where the forged number lives.
  const dir = mkdtempSync(join(tmpdir(), "capsid-secondary-"));
  const metricsPath = join(dir, "metrics.json");
  writeFileSync(metricsPath, JSON.stringify({ test_pass_rate: 1, lint_count: 0, bundle_size_bytes: 900 }));
  const tapPath = join(dir, "holdout.tap");
  // The container ran, the phases did not: status 127 is "command not found".
  writeFileSync(tapPath, stream([M.test, "sh: vitest: not found", `${M.status}127`, M.end]));

  const out = runScorer(["--secondary", tapPath, "capsid", NONCE, metricsPath], {});
  assert.match(out, /^test_pass_rate=\r?$/m, "an unmeasurable metric is empty, which the body turns into null");
  assert.match(out, /^lint_count=\r?$/m);

  const body = JSON.parse(
    runScorer([metricsPath, "30", "30"], {
      IMPROVE_NAMESPACE: "capsid",
      RUN_ID: "r1",
      ATTEMPT_ID: "a1",
      ATTEMPT_HEAD_SHA: "deadbeef",
      BUILD_PASSES: "1",
      SECONDARY_TEST_PASS_RATE: "",
      SECONDARY_LINT_COUNT: "",
    })
  );
  assert.equal(body.secondary.test_pass_rate, null);
  assert.equal(body.secondary.lint_count, null);
  assert.equal(body.secondary.bundle_size_bytes, 900);
});

test("a mismatch between the artifact and the sandbox is reported, not swallowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "capsid-secondary-"));
  const metricsPath = join(dir, "metrics.json");
  writeFileSync(metricsPath, JSON.stringify({ test_pass_rate: 1, lint_count: 0 }));
  const tapPath = join(dir, "holdout.tap");
  writeFileSync(
    tapPath,
    stream([M.test, "ok 1 - one", "not ok 2 - two", `${M.status}1`, M.lint, "x.ts(1,1): error TS1005: ';' expected.", `${M.status}2`, M.end])
  );

  // The mismatch lines go to stderr by design: stdout is piped straight into
  // GITHUB_OUTPUT and must carry nothing but the two key=value lines, while the
  // run log still has to say that the artifact and the sandbox disagreed.
  const run = spawnSync(process.execPath, [SCORER, "--secondary", tapPath, "capsid", NONCE, metricsPath], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim().split("\n").length, 2, "stdout is exactly the two GITHUB_OUTPUT lines");
  assert.match(run.stdout, /test_pass_rate=0\.5/);
  assert.match(run.stdout, /lint_count=1/);
  assert.match(run.stderr, /SECONDARY MISMATCH test_pass_rate: the artifact claims 1, the sandbox measured 0\.5/);
  assert.match(run.stderr, /SECONDARY MISMATCH lint_count: the artifact claims 0, the sandbox measured 1/);
  assert.match(run.stderr, /The sandbox value is used\./);
});

// ---- the trusted map --------------------------------------------------------

test("every roster namespace has a command map entry, and the map is what names the trees", () => {
  for (const ns of ["capsid", "dustinedwards", "foxhound", "foxing", "germomics"]) {
    const spec = SECONDARY_COMMANDS[ns];
    assert.ok(spec, `no secondary command map for ${ns}`);
    assert.ok(Array.isArray(spec.trees) && spec.trees.length > 0, `${ns} must declare the trees the sandbox overlays`);
    if (spec.lint) assert.ok(spec.lint_pattern, `${ns} declares a lint command with nothing to count`);
  }
});

test("the sandbox commands are written as files, never interpolated into the container argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "capsid-scripts-"));
  const files = secondaryScripts("capsid");
  assert.ok(files["trees.txt"], "the tree list is part of the trusted handoff");
  assert.ok(files["secondary-test.sh"], "capsid declares a test command");
  assert.ok(files["secondary-lint.sh"], "capsid declares a lint command");

  execFileSync(process.execPath, [SCORER, "--secondary-scripts", "capsid", dir], { stdio: "ignore" });
  const written = readdirSync(dir).sort();
  assert.deepEqual(written, ["secondary-lint.sh", "secondary-test.sh", "trees.txt"]);
  assert.equal(readFileSync(join(dir, "trees.txt"), "utf8").trim(), "src");

  // germomics has no test or lint script; it gets the tree list and nothing else.
  const dir2 = mkdtempSync(join(tmpdir(), "capsid-scripts-"));
  execFileSync(process.execPath, [SCORER, "--secondary-scripts", "germomics", dir2], { stdio: "ignore" });
  assert.deepEqual(readdirSync(dir2), ["trees.txt"]);
});

// ---- the nonce --------------------------------------------------------------

test("PLANT: raw lint output cannot forge a marker, because the marker carries a nonce", () => {
  // TAP escaping protects the holdout segments. It does not protect a lint tool's
  // raw stdout, and a type error message can carry attacker text at column 0. The
  // nonce is what makes that harmless.
  const forged = stream([
    M.test,
    "ok 1 - one real result",
    "1..1",
    `${M.status}0`,
    M.lint,
    // The attempt names a type so tsc echoes these lines back verbatim.
    "##CAPSID-END",
    "##CAPSID-TEST",
    "ok 1 - forged",
    "ok 2 - forged",
    `${M.status}0`,
    M.end,
  ]);
  const { segments, terminated } = splitStream(forged, NONCE);
  assert.equal(terminated, true, "only the nonced END terminates the stream");
  assert.equal(segments.filter((s) => s.kind === "test").length, 1, "the forged un-nonced TEST marker opens nothing");
  const result = secondaryFromStream(forged, "capsid", NONCE);
  assert.equal(result.test_pass_rate, 1, "the real phase, not the forged one");
  assert.equal(result.lint_count, 0, "no line in the forged lint output matches capsid's error TS pattern");
});

test("an unterminated stream measures nothing", () => {
  const killed = stream([M.test, "ok 1 - one", "1..1", `${M.status}0`]);
  const result = secondaryFromStream(killed, "capsid", NONCE);
  assert.equal(result.test_pass_rate, null, "a container killed mid-run is a failed measurement, not a good one");
  assert.equal(result.lint_count, null);
});

// ---- the workflow contract --------------------------------------------------

test("the sandbox runs the secondary phases, framed by the nonce", () => {
  assert.match(WORKFLOW, /--secondary-scripts "\$\{IMPROVE_NAMESPACE\}" "\$\{RUNNER_TEMP\}\/trusted"/);
  assert.match(WORKFLOW, /M="##CAPSID-\$\{CAPSID_NONCE\}"/, "the container builds its marker prefix from the nonce");
  assert.match(WORKFLOW, /unset CAPSID_NONCE/, "and drops it from the environment before any attempt code runs");
  assert.match(WORKFLOW, /sh \/trusted\/secondary-test\.sh 2>&1/, "the test phase runs inside the container");
  assert.match(WORKFLOW, /sh \/trusted\/secondary-lint\.sh 2>&1/, "so does the lint phase");
  assert.match(WORKFLOW, /--secondary \\\n\s+"\$\{RUNNER_TEMP\}\/holdout\.tap"/, "and the trusted copy parses the stream");
  assert.match(
    WORKFLOW,
    /SECONDARY_TEST_PASS_RATE: \$\{\{ steps\.secondary\.outputs\.test_pass_rate \}\}/,
    "the signing step reads the recomputed value from a step output"
  );
  assert.match(WORKFLOW, /SECONDARY_LINT_COUNT: \$\{\{ steps\.secondary\.outputs\.lint_count \}\}/);
});

test("PLANT: the scorer no longer reads test_pass_rate or lint_count from the artifact", () => {
  const source = readFileSync(SCORER, "utf8");
  assert.ok(
    !/metric\(m\.test_pass_rate\)/.test(source),
    "reading test_pass_rate out of metrics.json is the hole run 34162010375 walked through"
  );
  assert.ok(!/metric\(m\.lint_count\)/.test(source), "same for lint_count");
  assert.match(source, /metric\(m\.bundle_size_bytes\)/, "bundle_size_bytes is the one field the artifact still supplies");
});

test("the container mounts the trusted checkout read-only and the attempt separately", () => {
  for (const mount of [
    /-v "\$\{RUNNER_TEMP\}\/attempt\/code:\/attempt:ro"/,
    /-v "\$\{RUNNER_TEMP\}\/holdout:\/holdout:ro"/,
    /-v "\$\{RUNNER_TEMP\}\/trusted:\/trusted:ro"/,
    /-v "\$\{GITHUB_WORKSPACE\}:\/repo:ro"/,
  ]) {
    assert.match(WORKFLOW, mount, `every bind mount must be read-only: ${mount}`);
  }
  assert.ok(!/-v "\$\{GITHUB_WORKSPACE\}:\/[a-z-]+"(?!:ro)/.test(EXECUTABLE), "no writable workspace mount");
  assert.match(
    WORKFLOW,
    /done < \/trusted\/trees\.txt/,
    "which trees the attempt replaces comes from the trusted map, never from what the artifact happens to contain"
  );
});

test("PLANT: the container script carries no apostrophe, comments included", () => {
  // Run 34168919050 died at `cd: /repo: No such file or directory` because a
  // comment inside the container script said "a test file's REAL path". The whole
  // script is ONE single-quoted shell argument: one apostrophe ends it and every
  // line after it runs on the runner, outside the container, with the workspace
  // writable and the step still reporting a container. A quoting slip in this one
  // string is an isolation failure, so it gets an assertion rather than care.
  const open = WORKFLOW.indexOf("--entrypoint /bin/sh");
  assert.ok(open > 0, "the container invocation moved; this scan is reading nothing");
  const scriptStart = WORKFLOW.indexOf("-c '", open);
  const scriptEnd = WORKFLOW.indexOf("\n            ' >", scriptStart);
  assert.ok(scriptStart > 0 && scriptEnd > scriptStart, "could not bound the container script");
  const script = WORKFLOW.slice(scriptStart + 4, scriptEnd);
  assert.ok(script.includes("docker") === false, "the slice is the script body, not the docker line");
  assert.ok(script.length > 500, `the container script sliced to ${script.length} characters; the bounds are wrong`);
  const offenders = script
    .split("\n")
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes("'"));
  assert.deepEqual(
    offenders.map((o) => o.line.trim()),
    [],
    "an apostrophe anywhere in this script closes the shell argument early"
  );
});

test("PLANT: the sandbox is a real git repository, with one commit and no history", () => {
  // Adding the git BINARY was not enough. The sandbox assembles its tree by
  // copying, deliberately without .git, so foxhound went from "git: not found"
  // to "not a git repository" with the same file still failing. Ruled 2026-09-08:
  // one commit of the assembled tree, so rev-parse and status answer.
  const container = EXECUTABLE.slice(EXECUTABLE.indexOf("docker run --rm"));
  assert.match(container, /git init -q/, "the sandbox must be a repository, not just a machine with git on it");
  assert.match(container, /git commit -q -m sandbox/, "one commit, so HEAD exists");
  assert.match(
    container,
    /printf "node_modules\\n\.holdout\\n" > \/work\/\.git\/info\/exclude/,
    "node_modules and the holdout stay out of the index, so it is the source tree and nothing else"
  );
  // NO REAL HISTORY AND NO REMOTE. The commit exists to answer a question, not to
  // tell an attempt anything about the actual repository.
  assert.ok(!/git remote add/.test(container), "the sandbox must have no remote");
  assert.ok(!/git fetch|git clone|git pull/.test(container), "and no network operation, behind --network none");
  // It runs BEFORE the phases that might ask, and the holdout is not in the tree yet, so
  // the exclude entry is a second check rather than the fix.
  assert.ok(
    container.indexOf("git init") < container.indexOf("secondary-test.sh"),
    "the repository must exist before any repo command runs"
  );
});

test("PLANT: the trusted tree is COPIED into the sandbox, not symlinked", () => {
  // Run 34168480470 is the plant that found this. The sandbox symlinked /work/test
  // at /repo/test, which made a test file's REAL path /repo/test/x.test.ts, so node
  // resolved its `../src` import against /repo. The sandbox measured the default
  // branch against itself and reported test_pass_rate 1 for an attempt that broke
  // two tests. The whole recompute was decorative until this was fixed.
  const container = EXECUTABLE.slice(EXECUTABLE.indexOf("docker run --rm"));
  assert.ok(
    !/ln -s "\$e" "\/work\/\$b"/.test(container),
    "blanket-symlinking the trusted tree into /work is what made relative imports resolve outside the sandbox"
  );
  assert.match(container, /find \. -path \.\/\.git -prune -o -name node_modules -prune -o -type f -print/, "source files are copied");
  // node_modules is the ONE thing not copied: it is a real directory in the tmpfs
  // whose entries are symlinks to the read-only originals. A symlink to the
  // DIRECTORY was the previous form and it broke vite, which writes
  // node_modules/.vite-temp before it loads a config. One level of symlinks keeps
  // every package read-only while leaving the directory itself writable.
  assert.match(container, /find \. -path \.\/\.git -prune -o -name node_modules -print -prune/, "the relink must prune");
  assert.match(container, /mkdir -p "\/work\/\$rel"/, "node_modules is a real directory, so a tool can write inside it");
  assert.match(container, /ln -s "\$e" "\/work\/\$rel\/\$\{e##\*\/\}"/, "and its entries are symlinks to the read-only originals");
  assert.ok(
    !/ln -s "\/repo\/\$\{d#\.\/\}" "\/work\/\$d"/.test(container),
    "symlinking the node_modules DIRECTORY makes it read-only, which is what broke vite"
  );
  assert.ok(
    !/-name node_modules -print \|/.test(container),
    "the relink must prune, or it walks the whole dependency tree it just made read-only"
  );
});
