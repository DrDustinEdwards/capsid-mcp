import assert from "node:assert/strict";
import { test } from "node:test";
import { holdoutImportRefusal, holdoutImportsPath, importedNames, parseImportsManifest } from "../scripts/improve-report.mjs";

// THE HOLDOUT IMPORT MANIFEST, both directions.
//
// improve/holdout/<ns>/imports.txt lists every name the hidden suite imports out
// of the repo's own source. It exists because a bloat pass removed two exports on
// a scan that found no caller in src/ or test/, the holdout imported both, and
// master scored 28 of 30 against an anchor of min 1.0. The holdout is a consumer
// no scan running in the repo can see, which is its entire point, so the names it
// reaches for have to be written down.
//
// test/dead-exports.test.ts owns the direction where a listed name counts as a
// caller. This file owns the parser and the refusal, which is what Job B runs.

// THE SHAPE THAT BROKE IT, kept as the first fixture. The first spelling of the
// clause matcher used a lazy [\s\S]*? and crossed statement boundaries, so in a
// file whose first RELATIVE import is the third line the match began at line one
// and swallowed the node-builtin imports above it. All five roster repos reported
// names like `assert`, `from`, `import` and `test } from "node:test";` as things
// their hidden suite imports. An import clause never contains a semicolon.
const REALISTIC = [
  'import assert from "node:assert/strict";',
  'import { test } from "node:test";',
  'import { approvalTag, APPROVAL_MAX_AGE_SECONDS } from "../src/approval.ts";',
  'import { normalizeDashes } from "../src/normalize.ts";',
  'import type { Env } from "../src/env";',
  'import * as gh from "../src/github";',
  'import def, { a, b as c } from "../src/x";',
  'import "../src/side-effect.ts";',
  'import { z } from "zod";',
].join("\n");

test("PLANT: a builtin import before a relative one is not swallowed into the clause", () => {
  const names = [...importedNames(REALISTIC)].sort();
  assert.deepEqual(names, ["APPROVAL_MAX_AGE_SECONDS", "Env", "a", "approvalTag", "b", "def", "gh", "normalizeDashes"]);
  for (const junk of ["assert", "test", "from", "import"]) {
    assert.ok(!names.includes(junk), `${junk} is a keyword or a builtin binding, never a name this repo exports`);
  }
});

test("only RELATIVE imports count, because a package says nothing about this repo", () => {
  assert.deepEqual([...importedNames('import { z } from "zod";')], []);
  assert.deepEqual([...importedNames('import { readFileSync } from "node:fs";')], []);
});

test("a renamed import reports the SOURCE name, which is the export that must survive", () => {
  // `b as c` binds c locally, but deleting `b` is what breaks the case.
  assert.deepEqual([...importedNames('import { b as c } from "../src/x";')], ["b"]);
});

test("a multi-line import clause is one statement", () => {
  const text = ['import {', "  alpha,", "  beta,", '} from "../src/x";'].join("\n");
  assert.deepEqual([...importedNames(text)].sort(), ["alpha", "beta"]);
});

test("nothing that is not an identifier can reach the comparison", () => {
  // A second check after the regex. A parse artefact compared against the manifest is a
  // refusal nobody can act on.
  for (const name of importedNames(REALISTIC)) {
    assert.match(name, /^[A-Za-z_$][A-Za-z0-9_$]*$/, `${JSON.stringify(name)} is not an identifier`);
  }
});

// ---- the manifest ------------------------------------------------------------

test("the manifest is names only, and reads past comments and blank lines", () => {
  const text = ["# what this is", "", "alpha", "beta", "  gamma  ", ""].join("\n");
  assert.deepEqual(parseImportsManifest(text), ["alpha", "beta", "gamma"]);
});

test("the path convention has one spelling", () => {
  assert.equal(holdoutImportsPath("capsid"), "improve/holdout/capsid/imports.txt");
  assert.equal(holdoutImportsPath("foxing"), "improve/holdout/foxing/imports.txt");
});

// ---- the refusal, which is what Job B acts on -------------------------------

const CASE = 'import { test } from "node:test";\nimport { alpha, beta } from "../src/x.ts";';

test("PLANT: an import the manifest does not list is refused, by name", () => {
  const refusal = holdoutImportRefusal([CASE], ["alpha"], "capsid");
  assert.ok(refusal);
  assert.match(refusal!, /does not list: beta/);
  assert.match(refusal!, /improve\/holdout\/capsid\/imports\.txt/);
});

test("PLANT: no manifest at all is refused, and hands over the list to create", () => {
  const refusal = holdoutImportRefusal([CASE], null, "capsid");
  assert.ok(refusal);
  assert.match(refusal!, /no improve\/holdout\/capsid\/imports\.txt/);
  // Actionable rather than merely correct: the refusal IS the file to write.
  assert.match(refusal!, /alpha\nbeta/);
});

test("PLANT: the refusal never names a case file", () => {
  // A case filename is part of the hidden suite and this runs in a job whose log
  // is readable. Every refusal is built from IMPORT names, which are source
  // exports and already public.
  const refusals = [holdoutImportRefusal([CASE], ["alpha"], "capsid"), holdoutImportRefusal([CASE], null, "capsid")];
  for (const refusal of refusals) {
    assert.ok(refusal);
    assert.doesNotMatch(refusal!, /\.test\./, "a refusal must not carry a case filename");
  }
});

test("a complete manifest passes, so the guard is not simply always red", () => {
  assert.equal(holdoutImportRefusal([CASE], ["alpha", "beta"], "capsid"), null);
  // And a manifest listing MORE than the suite uses is fine: that is the
  // dead-export direction, where an extra name only makes an export undeletable.
  assert.equal(holdoutImportRefusal([CASE], ["alpha", "beta", "gamma"], "capsid"), null);
});
