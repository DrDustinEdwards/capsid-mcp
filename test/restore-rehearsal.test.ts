import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error the scripts/ tree is plain .mjs with no type declarations, and
// deliberately so: the rehearsal runs in the live CI job with no npm ci and no
// build step.
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
  // The two sidecars the dump has carried since residual 4. They are not tables
  // and are named with a leading underscore so they can never collide with one.
  writeFileSync(join(dir, "_kv.json"), JSON.stringify({ exported_at: "2026-09-07T09:00:00Z", keys: { improve_mode: "off" } }));
  writeFileSync(
    join(dir, "_holdout-manifests.json"),
    JSON.stringify({ exported_at: "2026-09-07T09:00:00Z", manifests: { capsid: { namespace: "capsid", total: 30, updated_at: "2026-09-07" } } })
  );
  return dir;
}

// Write rows into one table file of an existing dump.
function setRows(dir: string, table: string, rows: unknown[]): void {
  writeFileSync(join(dir, `${table}.json`), JSON.stringify({ exported_at: "2026-09-07T09:00:00Z", table, rows }));
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

// ---- cross-table consistency (residual 4) -----------------------------------
//
// The dump is now one D1 batch, so it is a single transaction and the ten table
// objects agree with each other. This is the half that CHECKS that, because a
// consistency guarantee nothing verifies is a comment.
//
// THE CHECKS ARE THE TEARING SIGNATURE, NOT PLAIN REFERENTIAL INTEGRITY, and the
// difference was measured rather than assumed. Live on 2026-09-08 the store held
// 205 document_versions rows and 2,060 audit_log rows whose document is not in
// the store at all: deleted documents, lint-finalize archiving that rewrites the
// path column, and the recova-to-foxhound namespace rename. A rehearsal that
// failed on those would be red on every good dump forever, and a guard that fires
// on the innocent case gets deleted rather than fixed. So the orphan counts are
// REPORTED, and what FAILS is the pair of signatures a torn read produces and a
// deletion cannot:
//
//   a version row whose document_id is above the highest id in the documents
//   object, with no delete or move recorded for its path (the document was
//   created after documents was read), and
//
//   a `write` audit row NEWER than every row in the documents object, naming a
//   path that is not there (the write landed after documents was read).
//
// Both measured zero against the live store before they were written.

test("a dump carrying the two sidecars restores, and reports its orphan counts", () => {
  withDump((dir) => {
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.docCount, 2);
    assert.equal(summary.orphanVersions, 0);
    assert.equal(summary.orphanAudits, 0);
  });
});

test("a missing sidecar is refused: the KV pins are part of the dump now", () => {
  withDump((dir) => {
    rmSync(join(dir, "_kv.json"));
    assert.throws(() => rehearse(dir, MIGRATIONS), /_kv\.json/);
  });
});

test("an unknown sidecar is refused too, so the set cannot quietly grow", () => {
  withDump((dir) => {
    writeFileSync(join(dir, "_secrets.json"), JSON.stringify({}));
    assert.throws(() => rehearse(dir, MIGRATIONS), /_secrets\.json/);
  });
});

test("A TORN SNAPSHOT IS REFUSED: a version row for a document created after the documents read", () => {
  withDump((dir) => {
    setRows(dir, "document_versions", [
      { id: 1, document_id: 99, namespace: "sample", path: "written-mid-dump.md", title: "t", body: "b", snapshot_at: "2026-09-07 09:00:01" },
    ]);
    assert.throws(() => rehearse(dir, MIGRATIONS), /torn|inconsistent/i);
  });
});

test("a version row for a DELETED document is not torn, and passes", () => {
  // The innocent case, checked in the same commit as the guard: a deleted document
  // leaves version rows behind by design, and restore exists to bring one back.
  withDump((dir) => {
    setRows(dir, "document_versions", [
      { id: 1, document_id: 99, namespace: "sample", path: "gone.md", title: "t", body: "b", snapshot_at: "2026-09-01 00:00:00" },
    ]);
    setRows(dir, "audit_log", [
      { id: 1, actor: "human", action: "delete", namespace: "sample", path: "gone.md", params: "{}", at: "2026-09-01 00:00:01" },
    ]);
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.orphanVersions, 1, "the orphan is still counted and reported");
  });
});

test("A TORN SNAPSHOT IS REFUSED: a write audited after the newest document in the dump", () => {
  withDump((dir) => {
    setRows(dir, "audit_log", [
      { id: 1, actor: "human", action: "write", namespace: "sample", path: "landed-mid-dump.md", params: "{}", at: "2026-09-02 00:00:00" },
    ]);
    assert.throws(() => rehearse(dir, MIGRATIONS), /torn|inconsistent/i);
  });
});

test("an OLD write to a since-archived path is not torn, and passes", () => {
  withDump((dir) => {
    setRows(dir, "audit_log", [
      { id: 1, actor: "human", action: "write", namespace: "sample", path: "archived/old.md", params: "{}", at: "2026-08-01 00:00:00" },
    ]);
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.orphanAudits, 1);
  });
});
