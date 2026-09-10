// EVERY SQL STATEMENT IN src/, EXTRACTED FROM THE SOURCE.
//
// A WALK rather than a list. A hand-maintained catalogue of queries goes stale the first
// time somebody adds a query, and the query nobody added is the one that table-scans a
// growing table at 03:00. capsid/conventions.md: where code hardcodes a list mirroring
// the state of something else, derive the list.
//
// WHAT IT CAN AND CANNOT SEE. It reads the argument of every `.prepare(...)` call, which
// covers a plain string and a template literal. A template literal with a `${...}` hole
// is kept with the hole replaced by a placeholder that is valid SQL in that position
// where one can be guessed, and SKIPPED otherwise; the skipped ones are returned too, so
// a caller can assert how many were skipped. Nothing here parses TypeScript: this is a
// regex over source text.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A `${...}` hole inside a prepared statement is one of three things in this codebase,
// and each has a substitution that keeps the statement parseable so SQLite can plan it:
//
//   a table name        (backup.ts dumps `SELECT * FROM ${table}`)
//   a placeholder list  (`?1, ?2, ...` built from an array length)
//   a column list       (a projection built from a set of field names)
//
// Anything else is skipped rather than guessed at, and reported rather than dropped: a
// plan check that quietly covers 40 of 60 statements is the "assertion that can pass by
// reading nothing" failure.
const HOLE = /\$\{[^}]*\}/g;

function substitute(sql) {
  if (!HOLE.test(sql)) return { ok: true, sql };
  HOLE.lastIndex = 0;
  // A hole immediately after FROM or INTO or JOIN is a table name.
  let out = sql.replace(/\b(FROM|INTO|JOIN|UPDATE)\s+\$\{[^}]*\}/gi, "$1 documents");
  // A hole standing where the whole WHERE clause goes is an optional filter list,
  // built from however many arguments the caller supplied. Substituted with a
  // tautology so the statement plans: what the plan check is for is the table and
  // the ORDER BY, and an optional filter can only narrow the scan the plan reports.
  // Without this the statement is SKIPPED, which is how a read on a growing table
  // silently leaves the plan check.
  out = out.replace(/\$\{clause\}|\$\{where[A-Za-z]*\}/g, "WHERE 1 = 1");
  // A hole right after a `?` is a bound-parameter INDEX, computed from how many
  // arguments were pushed. Any index plans the same, so ?1 stands in.
  out = out.replace(/\?\$\{[^}]*\}/g, "?1");
  // A hole inside a VALUES or IN list is a placeholder list.
  out = out.replace(/\(\s*\$\{[^}]*\}\s*\)/g, "(?1)");
  // A remaining hole in a projection position.
  out = out.replace(/SELECT\s+\$\{[^}]*\}/gi, "SELECT *");
  HOLE.lastIndex = 0;
  if (HOLE.test(out)) return { ok: false, sql };
  return { ok: true, sql: out };
}

/**
 * RECURSIVE, because src/ has subdirectories. The 2026-09-10 split moved the tool,
 * github and improve modules under src/tools, src/github and src/improve, and a flat
 * readdirSync silently stopped seeing them: the statement count fell from over 80 to 41.
 * query-plans.test.ts has a floor assertion that caught it. Names are returned relative
 * to srcDir with forward slashes, so a top-level file keeps its basename (backup.ts,
 * which the ALLOW list keys on) and a nested one is addressable as github/client.ts.
 *
 * @param {string} root
 * @returns {string[]}
 */
function tsFilesUnder(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    const dir = rel ? join(root, rel) : root;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".ts")) out.push(next);
    }
  };
  walk("");
  return out.sort();
}

/**
 * @param {string} srcDir
 * @returns {{ statements: { file: string; sql: string }[]; skipped: { file: string; sql: string }[] }}
 */
export function extractStatements(srcDir) {
  const statements = [];
  const skipped = [];
  for (const name of tsFilesUnder(srcDir)) {
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

// Only the statements SQLite can plan. A plan is meaningless for a write, and EXPLAIN
// QUERY PLAN on an INSERT reports the plan of its SELECT half or nothing at all.
/** @param {{ file: string; sql: string }[]} statements */
export function readStatements(statements) {
  return statements.filter((s) => /^SELECT\b/i.test(s.sql));
}

// The tables whose plans are load-bearing, from the audit. Each grows without
// bound: documents is the corpus, document_versions is every snapshot ever taken
// (53.9MB and doubling every three weeks as of 2026-09-07), audit_log is every
// write, and the improve_* tables are every attempt.
export const HOT_TABLES = ["documents", "document_links", "document_versions", "audit_log", "improve_runs", "improve_attempts", "improve_scores", "improve_skills", "improve_jti", "jobs"];
