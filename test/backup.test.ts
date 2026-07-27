import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TABLES } from "../src/backup.ts";

// FTS5 derives documents_fts from documents and the sync triggers rebuild it on
// import, so the virtual table and its shadow tables are never exported.
const DERIVED = /^(documents_fts|sqlite_)/;

function tablesInMigrations(): string[] {
  const dir = join(import.meta.dirname, "..", "migrations");
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    // CREATE VIRTUAL TABLE does not match, which is what we want.
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/gi)) {
      if (!DERIVED.test(m[1])) names.add(m[1]);
    }
  }
  return [...names].sort();
}

test("the migrations parse to a non-empty table list", () => {
  // Guards the regex itself: a parser that silently matches nothing would make
  // every assertion below vacuously pass.
  assert.ok(tablesInMigrations().length >= 5);
});

test("every table the migrations create is backed up", () => {
  const missing = tablesInMigrations().filter((t) => !TABLES.includes(t as (typeof TABLES)[number]));
  assert.deepEqual(missing, [], `migrations create tables that src/backup.ts does not export: ${missing.join(", ")}`);
});

test("every backed-up table exists in the migrations", () => {
  const inMigrations = tablesInMigrations();
  const unknown = TABLES.filter((t) => !inMigrations.includes(t));
  assert.deepEqual(unknown, [], `src/backup.ts exports tables no migration creates: ${unknown.join(", ")}`);
});

test("the FTS5 virtual table and its shadow tables are not exported", () => {
  assert.deepEqual(TABLES.filter((t) => DERIVED.test(t)), []);
});
