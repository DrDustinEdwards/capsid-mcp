import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// document_links stores (namespace, path) strings, not documents.id, and the
// table carries no foreign key, so the database will not keep edges in step with
// a renamed or removed document. Application code is the only thing that can.
//
// That contract was broken three separate times: delete orphaned every edge
// touching the row, move renamed the document and left its edges on the old
// path, and lint finalize archived with an inline path concatenation that was a
// move by another name. All three now route through pathMutation().
//
// These tests are a source guard rather than a behavioural one. They fail when a
// fourth site appears, which is the failure mode that actually happened, and
// which a behavioural test over the three known callers would not catch.

const SOURCE = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

const HELPER_START = "// PATH_MUTATION_HELPER_START";
const HELPER_END = "// PATH_MUTATION_HELPER_END";

function helperRange(): { start: number; end: number } {
  const start = SOURCE.indexOf(HELPER_START);
  const end = SOURCE.indexOf(HELPER_END);
  assert.ok(start !== -1, `${HELPER_START} marker is missing from src/server.ts`);
  assert.ok(end !== -1, `${HELPER_END} marker is missing from src/server.ts`);
  assert.ok(end > start, "helper end marker precedes its start marker");
  return { start, end };
}

// Every SQL fragment that renames a document or removes a documents row.
// Deliberately broad: it matches the shapes a future author is likely to write,
// not just the ones that exist today.
const MUTATION_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "UPDATE documents ... SET path", re: /UPDATE\s+documents\s+SET\s+path\s*=/gi },
  { label: "DELETE FROM documents", re: /DELETE\s+FROM\s+documents\b/gi },
];

test("pathMutation markers are present and well ordered", () => {
  const { start, end } = helperRange();
  assert.ok(end - start > 200, "helper body is implausibly small; markers may have drifted");
});

test("every documents.path mutation lives inside pathMutation()", () => {
  const { start, end } = helperRange();
  const offenders: string[] = [];

  for (const { label, re } of MUTATION_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(SOURCE); m !== null; m = re.exec(SOURCE)) {
      const inHelper = m.index > start && m.index < end;
      if (!inHelper) {
        const line = SOURCE.slice(0, m.index).split("\n").length;
        offenders.push(`${label} at src/server.ts:${line}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `documents.path is mutated outside pathMutation(). Route it through the helper so document_links moves with it:\n  ${offenders.join("\n  ")}`
  );
});

test("the helper actually contains both mutation shapes", () => {
  const { start, end } = helperRange();
  const body = SOURCE.slice(start, end);
  // Guards the guard: if the helper stopped containing these, the test above
  // would pass vacuously over a file that no longer mutates anything here.
  for (const { label, re } of MUTATION_PATTERNS) {
    re.lastIndex = 0;
    assert.ok(re.test(body), `pathMutation() no longer contains: ${label}`);
  }
});

test("all three known callers route through the helper", () => {
  for (const caller of ["pathMutation(db, namespace, path, null)", "pathMutation(db, namespace, path, new_path)", "pathMutation(db, namespace, path, `archive/${path}`)"]) {
    assert.ok(SOURCE.includes(caller), `expected a pathMutation call site: ${caller}`);
  }
});

test("document_links still has no foreign key, which is why the helper exists", () => {
  const migration = readFileSync(new URL("../migrations/0002_document_links.sql", import.meta.url), "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS document_links/i.test(migration));
  assert.ok(
    !/REFERENCES\s+documents/i.test(migration),
    "document_links gained a foreign key: revisit whether pathMutation is still the only guard"
  );
});
