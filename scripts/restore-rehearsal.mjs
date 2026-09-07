// The restore rehearsal (session 3 of the off-account backup arc). Takes a
// downloaded dump run directory (one <table>.json per real table, the shape
// src/backup.ts writes) and proves it actually restores: migrations build a
// fresh SQLite database, every table's rows go in with documents FIRST so the
// FTS5 triggers rebuild the index, and the result is verified. A backup that
// has never been restored is a hope, not a backup; this makes the restore a
// scheduled, failing-loudly CI job instead of a procedure first exercised
// during an incident.
//
// Node's bundled SQLite (node:sqlite, stable on the .nvmrc version) carries
// FTS5, so the rehearsal runs the REAL triggers from migrations/0001_init.sql,
// not a simulation. Foreign key enforcement is off, deliberately: the restore
// runbook inserts table by table in dump order after documents, exactly as a
// real per-table D1 import does, and FK ordering is not what this rehearsal
// exists to prove.
//
// What is verified, each failing with a named reason:
// - The dump directory holds EXACTLY one JSON per migrations-derived table,
//   both directions: a missing table file and an unexpected extra file both
//   fail (the backup.test.ts discipline, applied to the artifact).
// - Each file's own "table" field matches its filename, so a copy shuffle
//   cannot restore rows into the wrong table.
// - Every row inserts, and the restored count equals the dump's count.
// - documents is non-empty. A zero-document restore passes every other check
//   while proving nothing, which is the vacuous-pass failure mode.
// - The FTS index agrees with documents via the _docsize shadow table.
//   COUNT(*) on an external-content FTS5 table reads through to the content
//   table and cannot detect drift (measured 2026-07-27, capsid/core.md).
// - A MATCH probe on a word taken from a restored document returns it.

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

function fail(reason) {
  const err = new Error(reason);
  err.rehearsal = true;
  throw err;
}

export function rehearse(dumpDir, migrationsDir) {
  const tables = deriveTables(migrationsDir);
  if (tables.length === 0) fail(`no tables derived from ${migrationsDir}; the rehearsal read nothing`);

  const dumped = readdirSync(dumpDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
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

  db.close();
  return { tables: tables.length, totalRows, docCount, probe: word };
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
      `restore rehearsal PASSED: ${summary.tables} tables, ${summary.totalRows} rows, ${summary.docCount} documents, FTS probe '${summary.probe}' found`
    );
  } catch (e) {
    console.error(`restore rehearsal FAILED: ${e.message}`);
    process.exit(1);
  }
}
