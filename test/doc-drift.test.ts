import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TABLES } from "../src/backup.ts";
import { AUTHORITATIVE } from "../src/counts.ts";

// GROUP 5 (docs). The repo's own README and CLAUDE.md carried counts the code had
// moved past: five backup tables when there are nine, 26 tools when there are 30.
// The Capsid count linter guards the store's documents; nothing guarded these two
// repo files, which is exactly how they drifted. These guards tie each stale-prone
// number to its source of truth (TABLES, counts.ts) so the next drift fails here.

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("the README restore runbook names every backed-up table", () => {
  const readme = read("README.md");
  const restore = readme.slice(readme.indexOf("## Restore"), readme.indexOf("## Rollback"));
  for (const table of TABLES) {
    assert.match(restore, new RegExp(`\\b${table}\\b`), `the restore runbook never names ${table}`);
  }
  // The stale "five" framing is gone: the count moved to nine when 0003 added the
  // improve tables, and a restore that applies only 0001/0002 loses four of them.
  assert.doesNotMatch(restore, /\bfive real tables\b/i, "the runbook still says five real tables");
  assert.doesNotMatch(restore, /The five tables are\b/i, "the runbook still enumerates only five tables");
});

test("the README restore runbook applies every migration, not just 0001 and 0002", () => {
  const readme = read("README.md");
  assert.match(readme, /0003_improve\.sql/, "the runbook does not apply migration 0003");
});

test("CLAUDE.md states the authoritative tool count, not a stale one", () => {
  const claude = read("CLAUDE.md");
  assert.match(claude, new RegExp(`\\b${AUTHORITATIVE.capsid.tools} tools\\b`), "CLAUDE.md does not state the current tool count");
  assert.doesNotMatch(claude, /\b26 tools\b/, "CLAUDE.md still claims 26 tools");
});

test("CLAUDE.md commands list includes check:test", () => {
  const claude = read("CLAUDE.md");
  assert.match(claude, /check:test/, "CLAUDE.md commands omit check:test, so a session skips the test typecheck the way this session did");
});

test("CLAUDE.md no longer prescribes the withdrawn end-of-session episodic", () => {
  const claude = read("CLAUDE.md");
  // The episodic ritual was withdrawn portfolio-wide 2026-08-21; the session
  // ritual here must not still instruct writing one.
  assert.doesNotMatch(claude, /write a `session-YYYY-MM-DD\.md` episodic/i, "the episodic ritual is still prescribed");
});

// ---- the dump's real shape, and every migration (residual 14) ----------------

test("the restore runbook states the table count TABLES actually has", () => {
  const readme = read("README.md");
  const restore = readme.slice(readme.indexOf("## Restore"), readme.indexOf("## Rollback"));
  // The count is spelled out in prose in three places and drifted twice already:
  // "five real tables" when there were nine, then "the nine real tables" beside a
  // sentence enumerating ten. Derived from TABLES, so the next addition fails here
  // rather than being found during a restore.
  const words = ["five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen"];
  const correct = words[TABLES.length - 5];
  for (const [i, word] of words.entries()) {
    if (i === TABLES.length - 5) continue;
    assert.doesNotMatch(
      restore,
      new RegExp(`\\b${word} (real )?tables?\\b`, "i"),
      `the runbook says "${word} tables" and there are ${TABLES.length}`
    );
    assert.doesNotMatch(restore, new RegExp(`\\b${word} exports\\b`, "i"), `the runbook says "${word} exports"`);
  }
  assert.match(restore, new RegExp(`\\b${correct} `, "i"), `the runbook never states the count as ${correct}`);
});

test("the restore runbook applies EVERY migration, derived from the directory", () => {
  const readme = read("README.md");
  const migrations = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(migrations.length >= 4, "the migration scan found almost nothing");
  for (const file of migrations) {
    assert.ok(readme.includes(file), `the runbook never names ${file}, so a restore that follows it stops short`);
  }
});

test("the restore runbook names the two dump sidecars", () => {
  // The dump has carried the KV pins and the holdout manifests since residual 4.
  // A restore that rebuilds D1 and stops leaves the improve loop with no mode, no
  // anchor pins and no manifests, which is a loop that refuses every run.
  const readme = read("README.md");
  const restore = readme.slice(readme.indexOf("## Restore"), readme.indexOf("## Rollback"));
  assert.match(restore, /_kv\.json/, "the runbook does not mention the KV pins sidecar");
  assert.match(restore, /_holdout-manifests\.json/, "the runbook does not mention the holdout manifests sidecar");
});
