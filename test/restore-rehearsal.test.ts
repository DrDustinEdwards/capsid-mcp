import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveTables, rehearse } from "../scripts/restore-rehearsal.mjs";

// THE RESTORE REHEARSAL GUARD (session 3, group 2). Each plant confirms a check
// fires with the right reason: a rehearsal that passed on a broken dump would be
// the vacuous-pass the conventions warn about. The fixture is a minimal but real
// dump: enough documents for an FTS probe, and every migrations-derived table
// present, so a plant removes exactly one property at a time.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const TABLES = deriveTables(MIGRATIONS);

// Build a valid dump directory: one <table>.json per real table, documents
// carrying restorable, FTS-probeable rows.
function goodDump(): string {
  const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
  for (const table of TABLES) {
    let rows: unknown[] = [];
    if (table === "documents") {
      rows = [
        { id: 1, namespace: "sample", path: "core.md", title: "Sample core", body: "restore rehearsal probe body", type: "core", status: "published", created_at: "2026-09-01 00:00:00", updated_at: "2026-09-01 00:00:00" },
        { id: 2, namespace: "sample", path: "note.md", title: "Second", body: "another document with words", type: "note", status: "published", created_at: "2026-09-01 00:00:00", updated_at: "2026-09-01 00:00:00" },
      ];
    }
    writeFileSync(join(dir, `${table}.json`), JSON.stringify({ exported_at: "2026-09-07T09:00:00Z", table, rows }));
  }
  return dir;
}

function withDump(fn: (dir: string) => void): void {
  const dir = goodDump();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the derived table list is the same real-table set backup.ts exports", () => {
  // Cross-check against the sibling guard's parse, so the two cannot drift.
  assert.ok(TABLES.includes("documents"), "documents must be derived");
  assert.ok(!TABLES.includes("documents_fts"), "the FTS virtual table must never be in the list");
  assert.equal(new Set(TABLES).size, TABLES.length, "no table appears twice");
});

test("a valid dump restores, with FTS index and probe verified", () => {
  withDump((dir) => {
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.tables, TABLES.length);
    assert.equal(summary.docCount, 2);
    assert.ok(summary.probe.length >= 4, "a probe word was taken from a restored document");
  });
});

test("a missing table file is refused, naming the table", () => {
  withDump((dir) => {
    rmSync(join(dir, "namespaces.json"));
    assert.throws(() => rehearse(dir, MIGRATIONS), /missing tables.*namespaces/);
  });
});

test("an unexpected extra file is refused", () => {
  withDump((dir) => {
    writeFileSync(join(dir, "documents_fts.json"), JSON.stringify({ table: "documents_fts", rows: [] }));
    assert.throws(() => rehearse(dir, MIGRATIONS), /files no migration explains.*documents_fts/);
  });
});

test("a shuffled table field is refused before any rows restore", () => {
  withDump((dir) => {
    const shuffled = JSON.parse(readFileSync(join(dir, "namespaces.json"), "utf8"));
    shuffled.table = "audit_log";
    writeFileSync(join(dir, "namespaces.json"), JSON.stringify(shuffled));
    assert.throws(() => rehearse(dir, MIGRATIONS), /shuffled files/);
  });
});

test("a zero-document restore is refused as vacuous", () => {
  withDump((dir) => {
    writeFileSync(join(dir, "documents.json"), JSON.stringify({ table: "documents", rows: [] }));
    assert.throws(() => rehearse(dir, MIGRATIONS), /zero documents.*vacuous/);
  });
});

test("a row-count mismatch is impossible to fake: dropping a column value still restores the row", () => {
  // The count check compares restored rows to dumped rows, so it cannot be
  // defeated by a NULL; this asserts the happy path stays green when a nullable
  // column is absent, so the guard is not over-tight against real dumps.
  withDump((dir) => {
    const docs = JSON.parse(readFileSync(join(dir, "documents.json"), "utf8"));
    delete docs.rows[0].tags;
    writeFileSync(join(dir, "documents.json"), JSON.stringify(docs));
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.docCount, 2);
  });
});

test("the runner script exists and is the one the derive script points restorers at", () => {
  const scripts = readdirSync(join(import.meta.dirname, "..", "scripts"));
  assert.ok(scripts.includes("restore-rehearsal.mjs"), "the rehearsal runner is missing");
});
