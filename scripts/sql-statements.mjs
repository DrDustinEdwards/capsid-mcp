// EVERY SQL STATEMENT IN src/, EXTRACTED FROM THE SOURCE.
//
// The point is that it is a WALK rather than a list. A hand-maintained catalogue of
// queries to check the plan of is a catalogue that goes stale the first time
// somebody adds a query, and the query nobody added to the list is exactly the one
// that will table-scan a growing table at 03:00. capsid/conventions.md: where code
// hardcodes a list mirroring the state of something else, derive the list.
//
// WHAT IT CAN AND CANNOT SEE, stated rather than glossed. It reads the argument of
// every `.prepare(...)` call, which covers a plain string and a template literal.
// A template literal with a `${...}` hole is kept with the hole replaced by a
// placeholder that is valid SQL in that position where one can be guessed, and
// SKIPPED otherwise; the skipped ones are returned too, so a caller can assert how
// many were skipped and notice when that number grows. Nothing here parses
// TypeScript: this is a regex over source text, and it is honest about being one.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A `${...}` hole inside a prepared statement is almost always one of three
// things in this codebase, and each has a substitution that keeps the statement
// parseable so SQLite can plan it:
//
//   a table name        (backup.ts dumps `SELECT * FROM ${table}`)
//   a placeholder list  (`?1, ?2, ...` built from an array length)
//   a column list       (a projection built from a set of field names)
//
// Anything else is skipped rather than guessed at. A statement this cannot
// reconstruct is reported, not silently dropped: a plan check that quietly covers
// 40 of 60 statements is the "assertion that can pass by reading nothing" failure.
const HOLE = /\$\{[^}]*\}/g;

function substitute(sql) {
  if (!HOLE.test(sql)) return { ok: true, sql };
  HOLE.lastIndex = 0;
  // A hole immediately after FROM or INTO or JOIN is a table name.
  let out = sql.replace(/\b(FROM|INTO|JOIN|UPDATE)\s+\$\{[^}]*\}/gi, "$1 documents");
  // A hole inside a VALUES or IN list is a placeholder list.
  out = out.replace(/\(\s*\$\{[^}]*\}\s*\)/g, "(?1)");
  // A remaining hole in a projection position.
  out = out.replace(/SELECT\s+\$\{[^}]*\}/gi, "SELECT *");
  HOLE.lastIndex = 0;
  if (HOLE.test(out)) return { ok: false, sql };
  return { ok: true, sql: out };
}

/**
 * @param {string} srcDir
 * @returns {{ statements: { file: string; sql: string }[]; skipped: { file: string; sql: string }[] }}
 */
export function extractStatements(srcDir) {
  const statements = [];
  const skipped = [];
  for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts")).sort()) {
    const text = readFileSync(join(srcDir, name), "utf8");
    // `.prepare(` followed by a string or template literal, up to its closing
    // quote. Both quote styles and backticks, and a leading newline for the
    // multi-line form this codebase mostly uses.
    const calls = text.matchAll(/\.prepare\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g);
    for (const call of calls) {
      const raw = call[1];
      const body = raw.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'");
      const collapsed = body.replace(/\s+/g, " ").trim();
      if (collapsed.length === 0) continue;
      const substituted = substitute(collapsed);
      if (substituted.ok) statements.push({ file: name, sql: substituted.sql });
      else skipped.push({ file: name, sql: collapsed });
    }
  }
  return { statements, skipped };
}

// Only the statements SQLite can plan. A plan is meaningless for a write, and
// EXPLAIN QUERY PLAN on an INSERT reports the plan of its SELECT half or nothing
// at all, so reads are what this is about.
/** @param {{ file: string; sql: string }[]} statements */
export function readStatements(statements) {
  return statements.filter((s) => /^SELECT\b/i.test(s.sql));
}

// The tables whose plans are load-bearing, from the audit. Each grows without
// bound: documents is the corpus, document_versions is every snapshot ever taken
// (53.9MB and doubling every three weeks as of 2026-09-07), audit_log is every
// write, and the improve_* tables are every attempt.
export const HOT_TABLES = ["documents", "document_links", "document_versions", "audit_log", "improve_runs", "improve_attempts", "improve_scores", "improve_skills", "improve_jti"];
