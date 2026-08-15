import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

// THE CANARY FOR THE TEST SCRIPT ITSELF (quality audit 10.1).
//
// package.json used to enumerate every test file by hand. A sixteenth file then
// ran nowhere: it type-checked, it passed locally when invoked directly, and the
// suite reported green without it. That is the one failure a test suite cannot
// have, because every other guard in this repo is verified BY this suite.
//
// This file exists to be the sixteenth. It was added while the script still
// enumerated files, confirmed NOT to run, and then the script became a glob and
// it ran. It stays rather than being deleted, because the property it proves is
// not "the glob worked once" but "the glob is still what package.json says", and
// that can regress in one careless edit back to an explicit list.
test("package.json runs the test suite by glob, not by an enumerated list", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.test;
  assert.match(script, /test\/\*\.test\.ts/, "the test script no longer uses a glob, so a new test file can be skipped");
  // The enumeration is gone, not merely supplemented. A glob appended to a hand
  // list would run everything twice and hide the regression this guards.
  const enumerated = script.match(/test\/[a-z-]+\.test\.ts/g) ?? [];
  assert.deepEqual(
    enumerated,
    [],
    `the test script names individual files again: ${enumerated.join(", ")}. A file not on that list runs nowhere.`
  );
});

test("this file is itself proof: it runs only because the glob picked it up", () => {
  // Deliberately trivial. Its value is its existence in the run, not its
  // assertion: if the script regresses to an enumeration, this file is exactly
  // the one that would be forgotten, and its absence from the count is the
  // signal.
  assert.ok(true);
});
