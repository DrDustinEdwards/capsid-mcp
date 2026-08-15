import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

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

// THE GUARD SCANS EVERY FILE UNDER src/, not just server.ts. Widened 2026-08-13.
//
// Scanning one file made the guard's scope an assumption about where the next
// offender would be written, and the whole reason this test exists is that the same
// defect arrived three times in places nobody predicted. A path mutation in
// backup.ts, or in a new module, was invisible to it. Nothing stops a helper in
// links.ts from renaming a document.
const SRC_DIR = join(import.meta.dirname, "..", "src");

function sourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), "utf8") }));
}

const SOURCES = sourceFiles();
const SERVER = SOURCES.find((f) => f.name === "server.ts")!.text;

const HELPER_START = "// PATH_MUTATION_HELPER_START";
const HELPER_END = "// PATH_MUTATION_HELPER_END";

function helperRange(): { start: number; end: number } {
  const start = SERVER.indexOf(HELPER_START);
  const end = SERVER.indexOf(HELPER_END);
  assert.ok(start !== -1, `${HELPER_START} marker is missing from src/server.ts`);
  assert.ok(end !== -1, `${HELPER_END} marker is missing from src/server.ts`);
  assert.ok(end > start, "helper end marker precedes its start marker");
  return { start, end };
}

// Every SQL fragment that renames a document or removes a documents row.
// Deliberately broad: it matches the shapes a future author is likely to write, not
// just the ones that exist today.
//
// The UPDATE pattern no longer requires path to be the FIRST assignment in the SET
// clause, which is the hole this widening closes. It only matched
// `UPDATE documents SET path =`, so the identical bug written as
// `UPDATE documents SET updated_at = datetime('now'), path = ?3` walked straight
// past it. There is nothing unusual about that ordering; it is what an author
// copying the surrounding style would naturally write.
//
// It matches the SET clause ONLY, stopping at WHERE, because `path` appears in the
// WHERE clause of almost every statement in this file and matching there would flag
// `UPDATE documents SET status = ?1 WHERE namespace = ?2 AND path = ?3`, which
// mutates no path at all. A guard that fires on innocent statements gets deleted.
const SET_CLAUSE = /UPDATE\s+documents\b([\s\S]{0,400}?)(?:\bWHERE\b|`|;)/gi;

function pathMutationHits(text: string): number[] {
  const hits: number[] = [];
  SET_CLAUSE.lastIndex = 0;
  for (let m = SET_CLAUSE.exec(text); m !== null; m = SET_CLAUSE.exec(text)) {
    if (/\bpath\s*=/i.test(m[1])) hits.push(m.index);
  }
  return hits;
}

function deleteHits(text: string): number[] {
  const hits: number[] = [];
  const re = /DELETE\s+FROM\s+documents\b/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) hits.push(m.index);
  return hits;
}

const MUTATION_PATTERNS: Array<{ label: string; find: (text: string) => number[] }> = [
  { label: "UPDATE documents SET ... path =", find: pathMutationHits },
  { label: "DELETE FROM documents", find: deleteHits },
];

test("pathMutation markers are present and well ordered", () => {
  const { start, end } = helperRange();
  assert.ok(end - start > 200, "helper body is implausibly small; markers may have drifted");
});

test("the scan reads a plausible number of source files", () => {
  // An assertion that can pass by reading nothing is not an assertion. If the
  // directory walk broke, every offender check below would pass over an empty list.
  assert.ok(SOURCES.length >= 10, `expected to scan the src/ modules, found ${SOURCES.length}`);
  assert.ok(SOURCES.some((f) => f.name === "server.ts"));
});

test("every documents.path mutation in src/ lives inside pathMutation()", () => {
  const { start, end } = helperRange();
  const offenders: string[] = [];

  for (const { name, text } of SOURCES) {
    for (const { label, find } of MUTATION_PATTERNS) {
      for (const index of find(text)) {
        const inHelper = name === "server.ts" && index > start && index < end;
        if (!inHelper) {
          const line = text.slice(0, index).split("\n").length;
          offenders.push(`${label} at src/${name}:${line}`);
        }
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
  const body = SERVER.slice(start, end);
  // Guards the guard: if the helper stopped containing these, the test above would
  // pass vacuously over a file that no longer mutates anything here.
  for (const { label, find } of MUTATION_PATTERNS) {
    assert.ok(find(body).length > 0, `pathMutation() no longer contains: ${label}`);
  }
});

test("the widened UPDATE pattern catches a later path assignment", () => {
  // The exact shape the old pattern missed. This is the plant, kept as a test
  // rather than run by hand, because the hole was in the matcher and a matcher is
  // cheap to check directly.
  const later = 'db.prepare("UPDATE documents SET updated_at = datetime(\'now\'), path = ?3 WHERE namespace = ?1")';
  assert.equal(pathMutationHits(later).length, 1, "a path assignment after another SET column is not being caught");
  const pathFirst = 'db.prepare("UPDATE documents SET path = ?3 WHERE namespace = ?1")';
  assert.equal(pathMutationHits(pathFirst).length, 1);
});

test("the UPDATE pattern does not fire on path in a WHERE clause", () => {
  // The false positive that would make this guard unusable. `path` is in the WHERE
  // clause of nearly every statement in server.ts.
  const innocent = 'db.prepare("UPDATE documents SET status = ?1 WHERE namespace = ?2 AND path = ?3")';
  assert.deepEqual(pathMutationHits(innocent), []);
});

test("all three known callers route through the helper", () => {
  for (const caller of ["pathMutation(db, namespace, path, null)", "pathMutation(db, namespace, path, new_path)", "pathMutation(db, namespace, path, `archive/${path}`)"]) {
    assert.ok(SERVER.includes(caller), `expected a pathMutation call site: ${caller}`);
  }
});

test("document_links still has no foreign key, which is why the helper exists", () => {
  const migration = readFileSync(join(import.meta.dirname, "..", "migrations", "0002_document_links.sql"), "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS document_links/i.test(migration));
  assert.ok(
    !/REFERENCES\s+documents/i.test(migration),
    "document_links gained a foreign key: revisit whether pathMutation is still the only guard"
  );
});
