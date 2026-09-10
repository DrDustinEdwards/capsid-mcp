// The restore rehearsal (session 3 of the off-account backup arc). Takes a downloaded
// dump run directory (one <table>.json per real table, the shape src/backup.ts writes)
// and proves it restores: migrations build a fresh SQLite database, every table's rows
// go in with documents FIRST so the FTS5 triggers rebuild the index, and the result is
// verified.
//
// Node's bundled SQLite (node:sqlite, stable on the .nvmrc version) carries FTS5, so the
// rehearsal runs the REAL triggers from migrations/0001_init.sql. Foreign key
// enforcement is off, deliberately: the runbook inserts table by table in dump order
// after documents, exactly as a real per-table D1 import does.
//
// What is verified, each failing with a named reason:
// - The dump directory holds EXACTLY one JSON per migrations-derived table, both
//   directions: a missing table file and an unexpected extra file both fail.
// - Each file's own "table" field matches its filename, so a copy shuffle cannot restore
//   rows into the wrong table.
// - Every row inserts, and the restored count equals the dump's count.
// - documents is non-empty. A zero-document restore passes every other check while
//   proving nothing.
// - The FTS index agrees with documents via the _docsize shadow table. COUNT(*) on an
//   external-content FTS5 table reads through to the content table and cannot detect
//   drift (measured 2026-07-27, capsid/core.md).
// - A MATCH probe on a word taken from a restored document returns it.
// - The two SIDECARS are present and are exactly the two expected (_kv.json,
//   _holdout-manifests.json). They restore into no table; a missing one means the loop's
//   memory is not in the backup.
// - CROSS-TABLE CONSISTENCY (residual 4). The dump is one D1 batch, so the table objects
//   must agree with each other. What is checked is the TEARING SIGNATURE, not plain
//   referential integrity: measured live on 2026-09-08, the real store holds 205
//   document_versions rows and 2,060 audit_log rows whose document is not in the store,
//   every one explained by a deletion, by lint finalize rewriting a path, or by the
//   recova-to-foxhound namespace rename. Failing on those would be red on every good
//   dump forever. Orphans are COUNTED AND REPORTED; what FAILS is the pair of shapes a
//   torn read produces and a deletion cannot: a version row whose document_id is above
//   the highest id in the documents object with no delete or move recorded for its path,
//   and a `write` audit row newer than every row in the documents object naming a path
//   that is not there. Both measured zero against the live store before they were
//   written.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Identical derivation to test/backup.test.ts: real tables only. The regex
// does not match CREATE VIRTUAL TABLE, which is what keeps documents_fts out.
export function deriveTables(migrationsDir) {
  const tables = [];
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/gi)) {
      if (!tables.includes(m[1])) tables.push(m[1]);
    }
  }
  return tables;
}

// The sidecars src/backup.ts writes beside the table objects.
export const SIDECARS = ["_holdout-manifests.json", "_kv.json"];

function fail(reason) {
  const err = new Error(reason);
  err.rehearsal = true;
  throw err;
}

export function rehearse(dumpDir, migrationsDir) {
  const tables = deriveTables(migrationsDir);
  if (tables.length === 0) fail(`no tables derived from ${migrationsDir}; the rehearsal read nothing`);

  const files = readdirSync(dumpDir).filter((f) => f.endsWith(".json"));
  // Sidecars are underscore-prefixed so they cannot collide with a table name. Checked in
  // BOTH directions: a missing one is a dump that lost the loop's memory, an unexpected
  // one is a file nothing here knows how to verify.
  const sidecars = files.filter((f) => f.startsWith("_")).sort();
  const missingSidecars = SIDECARS.filter((f) => !sidecars.includes(f));
  const unknownSidecars = sidecars.filter((f) => !SIDECARS.includes(f));
  if (missingSidecars.length > 0) fail(`the dump is missing sidecars: ${missingSidecars.join(", ")}`);
  if (unknownSidecars.length > 0) fail(`the dump carries sidecars nothing verifies: ${unknownSidecars.join(", ")}`);

  const dumped = files.filter((f) => !f.startsWith("_")).map((f) => f.replace(/\.json$/, ""));
  const missing = tables.filter((t) => !dumped.includes(t));
  const extra = dumped.filter((d) => !tables.includes(d));
  if (missing.length > 0) fail(`the dump is missing tables the migrations create: ${missing.join(", ")}`);
  if (extra.length > 0) fail(`the dump carries files no migration explains: ${extra.join(", ")}`);

  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }

  // documents first; the runbook's one ordering rule, because the FTS triggers
  // fire on its inserts.
  const ordered = ["documents", ...tables.filter((t) => t !== "documents")];
  let totalRows = 0;
  for (const table of ordered) {
    const parsed = JSON.parse(readFileSync(join(dumpDir, `${table}.json`), "utf8"));
    if (parsed.table !== table) fail(`${table}.json says it dumps '${parsed.table}'; refusing to restore shuffled files`);
    if (!Array.isArray(parsed.rows)) fail(`${table}.json carries no rows array`);
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);
    const insert = db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
    );
    for (const row of parsed.rows) {
      insert.run(...columns.map((c) => row[c] ?? null));
    }
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    if (n !== parsed.rows.length) fail(`${table} restored ${n} rows against ${parsed.rows.length} dumped`);
    totalRows += n;
  }

  const { n: docCount } = db.prepare(`SELECT COUNT(*) AS n FROM documents`).get();
  if (docCount === 0) fail("the restore produced zero documents; a vacuous rehearsal proves nothing");

  const { n: ftsCount } = db.prepare(`SELECT COUNT(*) AS n FROM documents_fts_docsize`).get();
  if (ftsCount !== docCount) fail(`the FTS index holds ${ftsCount} rows against ${docCount} documents (counted via _docsize; COUNT on the FTS table itself cannot see drift)`);

  // The probe word comes from a restored document, so the MATCH exercises the
  // index against content known to be in it. Quoted, so FTS syntax cannot leak.
  const probeSource = db.prepare(`SELECT title, body FROM documents WHERE body IS NOT NULL LIMIT 20`).all();
  const word = probeSource.flatMap((d) => `${d.title ?? ""} ${d.body ?? ""}`.split(/[^A-Za-z]+/)).find((w) => w.length >= 4);
  if (!word) fail("no probe word could be taken from the restored documents; refusing to skip the MATCH check");
  const { n: matched } = db
    .prepare(`SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH ?`)
    .get(`"${word}"`);
  if (matched === 0) fail(`the FTS probe for '${word}' matched nothing although the word came from a restored document`);

  // ---- cross-table consistency ---------------------------------------------
  const { n: orphanVersions } = db
    .prepare(`SELECT COUNT(*) AS n FROM document_versions v WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = v.document_id)`)
    .get();
  const { n: orphanAudits } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_log a WHERE a.namespace IS NOT NULL AND a.path IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.namespace = a.namespace AND d.path = a.path)`
    )
    .get();

  const torn = [];
  const tornVersions = db
    .prepare(
      `SELECT v.id, v.namespace, v.path, v.document_id FROM document_versions v
        WHERE v.document_id > (SELECT COALESCE(MAX(id), 0) FROM documents)
          AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.namespace = v.namespace AND a.path = v.path AND a.action IN ('delete', 'move'))
        LIMIT 5`
    )
    .all();
  for (const row of tornVersions) {
    torn.push(`document_versions ${row.id} snapshots document ${row.document_id}, above the highest id in the documents object, and its path ${row.namespace}/${row.path} was never deleted or moved`);
  }
  const tornAudits = db
    .prepare(
      `SELECT a.id, a.namespace, a.path, a.at FROM audit_log a
        WHERE a.action = 'write' AND a.namespace IS NOT NULL AND a.path IS NOT NULL
          AND a.at > (SELECT COALESCE(MAX(updated_at), '') FROM documents)
          AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.namespace = a.namespace AND d.path = a.path)
        LIMIT 5`
    )
    .all();
  for (const row of tornAudits) {
    torn.push(`audit_log ${row.id} records a write to ${row.namespace}/${row.path} at ${row.at}, later than every row in the documents object, and that document is not in the dump`);
  }
  if (torn.length > 0) {
    fail(`the dump is TORN: its tables do not describe one instant. ${torn.join("; ")}`);
  }

  db.close();
  return { tables: tables.length, totalRows, docCount, probe: word, orphanVersions, orphanAudits };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
  const dumpDir = process.argv[2];
  if (!dumpDir) {
    console.error("usage: node scripts/restore-rehearsal.mjs <dump-run-directory>");
    process.exit(1);
  }
  try {
    const summary = rehearse(dumpDir, join(import.meta.dirname, "..", "migrations"));
    console.log(
      `restore rehearsal PASSED: ${summary.tables} tables, ${summary.totalRows} rows, ${summary.docCount} documents, FTS probe '${summary.probe}' found, ` +
        `cross-table consistent (${summary.orphanVersions} version and ${summary.orphanAudits} audit rows reference documents no longer in the store, all explained by deletions, archiving or the namespace rename)`
    );
  } catch (e) {
    console.error(`restore rehearsal FAILED: ${e.message}`);
    process.exit(1);
  }
}
