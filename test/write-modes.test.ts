import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleBody } from "../src/write-modes.ts";

// Batch-two item 4. These cover the two things append and patch have to get
// right to be trusted with a 60KB canon document: the anchor guard must refuse
// rather than corrupt, and repeated appends must not silently mangle spacing.

const existing = { exists: true, priorBody: "# Doc\n\nFirst section.\n" };

test("replace needs both title and body", () => {
  assert.match(
    (assembleBody({ mode: "replace", exists: false, priorBody: null, body: "x" }) as { error: string }).error,
    /needs both title and body/
  );
  assert.match(
    (assembleBody({ mode: "replace", exists: false, priorBody: null, title: "T" }) as { error: string }).error,
    /needs both title and body/
  );
  assert.deepEqual(assembleBody({ mode: "replace", exists: false, priorBody: null, title: "T", body: "B" }), {
    body: "B",
  });
});

test("append and patch refuse a document that does not exist", () => {
  for (const mode of ["append", "patch"] as const) {
    const r = assembleBody({ mode, exists: false, priorBody: null, body: "x", find: "a", replace_with: "b" });
    assert.match((r as { error: string }).error, /does not exist/);
  }
});

test("append puts exactly one blank line between the old body and the addition", () => {
  const r = assembleBody({ ...existing, mode: "append", body: "Second section.\n" });
  assert.deepEqual(r, { body: "# Doc\n\nFirst section.\n\nSecond section.\n" });
});

test("append normalizes whatever trailing and leading whitespace it is handed", () => {
  // The stored body ends with several newlines and the caller also leads with
  // one. Naive concatenation gives four blank lines; repeated over a few
  // appends that quietly wrecks a markdown document.
  const r = assembleBody({
    exists: true,
    priorBody: "# Doc\n\nFirst.\n\n\n",
    mode: "append",
    body: "\n\nSecond.\n",
  });
  assert.deepEqual(r, { body: "# Doc\n\nFirst.\n\nSecond.\n" });
});

test("append is idempotent in spacing across repeated appends", () => {
  let body = "# Doc\n";
  for (const line of ["One.", "Two.", "Three."]) {
    const r = assembleBody({ exists: true, priorBody: body, mode: "append", body: line });
    body = (r as { body: string }).body;
  }
  assert.equal(body, "# Doc\n\nOne.\n\nTwo.\n\nThree.");
  assert.doesNotMatch(body, /\n{3,}/);
});

test("append rejects patch arguments", () => {
  const r = assembleBody({ ...existing, mode: "append", body: "x", find: "a", replace_with: "b" });
  assert.match((r as { error: string }).error, /belong to mode 'patch'/);
});

test("patch replaces a unique anchor", () => {
  const r = assembleBody({ ...existing, mode: "patch", find: "First section.", replace_with: "First section, revised." });
  assert.deepEqual(r, { body: "# Doc\n\nFirst section, revised.\n" });
});

test("patch REFUSES a missing anchor rather than writing anything", () => {
  // This is the whole point. The hand-run splice guarded with instr(...) > 0 for
  // the same reason: a missed anchor must not silently corrupt the body.
  const r = assembleBody({ ...existing, mode: "patch", find: "Nonexistent.", replace_with: "x" });
  assert.match((r as { error: string }).error, /anchor not found/);
  assert.ok(!("body" in r));
});

test("patch REFUSES an ambiguous anchor and says how many times it matched", () => {
  const r = assembleBody({
    exists: true,
    priorBody: "alpha\nbeta\nalpha\n",
    mode: "patch",
    find: "alpha",
    replace_with: "gamma",
  });
  assert.match((r as { error: string }).error, /occurs 2 times/);
  assert.ok(!("body" in r));
});

test("patch names CRLF as the usual cause of a missed anchor", () => {
  // CRLF silently defeated two plants on 2026-08-11. A caller hitting this
  // should be told the likely cause, not just that it failed.
  const r = assembleBody({
    exists: true,
    priorBody: "line one\r\nline two\r\n",
    mode: "patch",
    find: "line one\nline two",
    replace_with: "x",
  });
  assert.match((r as { error: string }).error, /CRLF/);
});

test("patch refuses an empty anchor", () => {
  const r = assembleBody({ ...existing, mode: "patch", find: "", replace_with: "x" });
  assert.match((r as { error: string }).error, /non-empty find/);
});

test("patch rejects body", () => {
  const r = assembleBody({ ...existing, mode: "patch", find: "a", replace_with: "b", body: "c" });
  assert.match((r as { error: string }).error, /not body/);
});

test("patch replaces only the single occurrence, even when replace_with contains the anchor", () => {
  // A naive String.replace with a global flag, or a caller looping, would run
  // away here. Confirms exactly one substitution.
  const r = assembleBody({
    exists: true,
    priorBody: "keep A end",
    mode: "patch",
    find: "A",
    replace_with: "A and more A",
  });
  assert.deepEqual(r, { body: "keep A and more A end" });
});

test("patch treats find as a literal, not a regex", () => {
  // "$&" and "." and "*" are all regex-significant. find must match bytes.
  const r = assembleBody({
    exists: true,
    priorBody: "cost is $5.00 (approx)",
    mode: "patch",
    find: "$5.00 (approx)",
    replace_with: "$6.00 (exact)",
  });
  assert.deepEqual(r, { body: "cost is $6.00 (exact)" });
});
