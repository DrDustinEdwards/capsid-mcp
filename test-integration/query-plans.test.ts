import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// EXPLAIN QUERY PLAN OVER EVERY READ IN src/, AGAINST THE REAL SCHEMA.
//
// The statements are WALKED out of the source (scripts/sql-statements.mjs) rather
// than listed here, so a query added tomorrow is covered tomorrow. A hand-kept list
// of queries-to-check is a list that goes stale the first time somebody adds one,
// and the query nobody added is the one that scans a growing table at 03:00.
//
// WHAT COUNTS AS A FINDING, and this distinction is the whole test. SQLite writes
// "SCAN" for two different things: walking a TABLE with no usable index, and
// walking an INDEX in order. Only the first is a defect. So the rule is a bare
// `SCAN <table>` with no ` USING INDEX` and no ` VIRTUAL TABLE`, on one of the
// tables that grows without bound.
//
// Measured at b464cd8: 17 SCAN lines over 62 reads, six of them bare scans of
// document_versions, audit_log, improve_runs and improve_skills. document_versions
// and audit_log carried NO INDEX AT ALL, and `lastActor` (every read, and once per
// row of every brief) was a full scan of the largest append-only table in the
// store. migrations/0005_query_plan_indexes.sql is the fix; this is the guard.

const HOT_TABLES = [
  "documents",
  "document_links",
  "document_versions",
  "audit_log",
  "improve_runs",
  "improve_attempts",
  "improve_scores",
  "improve_skills",
  "improve_jti",
];

// The one read that is SUPPOSED to walk a whole table: the nightly dump. Named
// with its reason rather than filtered by a pattern, so a second exception has to
// be argued for in this file rather than slipped past a regex.
const WHOLE_TABLE_BY_DESIGN = [
  { file: "backup.ts", sql: /^SELECT \* FROM /i, why: "the nightly dump reads every row of a table on purpose" },
];

function arity(sql: string): number {
  const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (numbered.length > 0) return Math.max(...numbered);
  return (sql.match(/\?/g) ?? []).length;
}

// A bare table scan: "SCAN <name>" with nothing after it. "SCAN x USING INDEX y"
// is an index scan and "SCAN documents_fts VIRTUAL TABLE INDEX 0:M2" is how FTS
// reports a MATCH; neither is a defect.
function bareScan(detail: string): string | null {
  const match = /^SCAN ([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(detail.trim());
  return match ? match[1] : null;
}

async function planOf(sql: string): Promise<{ details: string[] } | { error: string }> {
  try {
    const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...new Array(arity(sql)).fill("x"))
      .all<{ detail: string }>();
    return { details: result.results.map((r) => r.detail) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const reads = () => env.TEST_SQL_STATEMENTS.filter((s) => /^SELECT\b/i.test(s.sql));

describe("query plans", () => {
  it("the walk found the statements at all, so nothing below can pass by reading nothing", () => {
    const all = env.TEST_SQL_STATEMENTS;
    expect(all.length, "no prepared statements were extracted from src/; the walk is broken").toBeGreaterThan(80);
    expect(reads().length, "no SELECTs among them").toBeGreaterThan(50);
    // A statement the walk could not reconstruct is REPORTED rather than dropped.
    // A plan check that quietly covers 40 of 60 statements is the "assertion that
    // can pass by reading nothing" failure capsid/conventions.md names.
    expect(
      env.TEST_SQL_SKIPPED.length,
      `${env.TEST_SQL_SKIPPED.length} statements could not be reconstructed: ${env.TEST_SQL_SKIPPED.map((s) => `${s.file}: ${s.sql.slice(0, 70)}`).join(" | ")}`
    ).toBeLessThanOrEqual(1);
  });

  it("every read PLANS at all, so a statement the schema rejects is a build failure", async () => {
    const broken: string[] = [];
    for (const statement of reads()) {
      const plan = await planOf(statement.sql);
      if ("error" in plan) broken.push(`${statement.file}: ${plan.error} :: ${statement.sql.slice(0, 90)}`);
      else if (plan.details.length === 0) broken.push(`${statement.file}: empty plan :: ${statement.sql.slice(0, 90)}`);
    }
    expect(broken, broken.join("\n")).toEqual([]);
  });

  it("PLANT: no read bare-scans a table that grows without bound", async () => {
    const findings: string[] = [];
    for (const statement of reads()) {
      const exempt = WHOLE_TABLE_BY_DESIGN.some((e) => e.file === statement.file && e.sql.test(statement.sql));
      if (exempt) continue;
      const plan = await planOf(statement.sql);
      if ("error" in plan) continue; // the previous test owns that failure
      for (const detail of plan.details) {
        const table = bareScan(detail);
        if (table && HOT_TABLES.includes(table)) {
          findings.push(`${statement.file} :: ${detail} :: ${statement.sql.slice(0, 120)}`);
        }
      }
    }
    expect(findings, `bare table scans on growing tables:\n${findings.join("\n")}`).toEqual([]);
  });

  it("PLANT: the two hottest reads use the indexes 0005 added, by name", async () => {
    // Named rather than inferred. The point of `id DESC` inside these indexes is
    // that the LIMIT 1 stops at the first entry instead of sorting what it found,
    // and a plan that says SEARCH but then TEMP B-TREE FOR ORDER BY has lost that.
    const lastActor = await planOf(
      "SELECT actor FROM audit_log WHERE namespace = ?1 AND path = ?2 ORDER BY id DESC LIMIT 1"
    );
    expect("details" in lastActor).toBe(true);
    const actorPlan = ("details" in lastActor ? lastActor.details : []).join(" | ");
    expect(actorPlan).toContain("audit_log_doc");
    expect(actorPlan).not.toContain("TEMP B-TREE");

    const prune = await planOf("SELECT COUNT(*) AS n FROM document_versions WHERE snapshot_at < datetime('now', ?1)");
    const prunePlan = ("details" in prune ? prune.details : []).join(" | ");
    expect(prunePlan).toContain("document_versions_snapshot");
  });

  it("PLANT: the prune DELETEs share the predicate their index was built for", async () => {
    // A DELETE has no query plan worth reading, so this asserts the shape instead:
    // the COUNT and the DELETE must filter on the same column, or the index covers
    // the cheap half of the prune and not the expensive one.
    const writes = env.TEST_SQL_STATEMENTS.filter((s) => /^DELETE FROM (audit_log|document_versions)\b/i.test(s.sql));
    expect(writes.length, "the prune DELETEs are not where this test looked").toBeGreaterThanOrEqual(2);
    for (const statement of writes) {
      expect(statement.sql, `${statement.sql} does not filter on the column its index covers`).toMatch(
        /WHERE (at|snapshot_at) < datetime/i
      );
    }
  });

  it("the indexes 0005 declares all exist in the real schema", async () => {
    const expected = [
      "audit_log_doc",
      "audit_log_at",
      "document_versions_doc",
      "document_versions_snapshot",
      "improve_runs_started",
      "improve_skills_ts",
    ];
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>();
    const present = rows.results.map((r) => r.name);
    for (const name of expected) {
      expect(present, `${name} is declared in migrations/0005 and absent from the applied schema`).toContain(name);
    }
  });
});
