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
//
// The restore runbook moved to docs/backups.md and the rollback section to
// docs/rollback.md when the README was cut to its top-level shape. These guards
// follow the content rather than the filename: what they assert is unchanged.

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// The runbook is the Restore section of docs/backups.md, which runs to the end of
// that file. Resolved through a helper so a further move is one edit, and asserted
// non-empty so a renamed heading fails loudly instead of scanning an empty string.
function restoreRunbook(): string {
  const doc = read("docs/backups.md");
  const from = doc.indexOf("## Restore");
  assert.ok(from >= 0, "docs/backups.md no longer has a Restore section");
  const runbook = doc.slice(from);
  assert.ok(runbook.length > 1000, `the restore runbook came back nearly empty (${runbook.length} chars)`);
  return runbook;
}

test("the restore runbook names every backed-up table", () => {
  const restore = restoreRunbook();
  for (const table of TABLES) {
    assert.match(restore, new RegExp(`\\b${table}\\b`), `the restore runbook never names ${table}`);
  }
  // The stale "five" framing is gone: the count moved to nine when 0003 added the
  // improve tables, and a restore that applies only 0001/0002 loses four of them.
  assert.doesNotMatch(restore, /\bfive real tables\b/i, "the runbook still says five real tables");
  assert.doesNotMatch(restore, /The five tables are\b/i, "the runbook still enumerates only five tables");
});

test("the restore runbook applies every migration, not just 0001 and 0002", () => {
  assert.match(restoreRunbook(), /0003_improve\.sql/, "the runbook does not apply migration 0003");
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
  const restore = restoreRunbook();
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
  const restore = restoreRunbook();
  const migrations = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(migrations.length >= 4, "the migration scan found almost nothing");
  for (const file of migrations) {
    assert.ok(restore.includes(file), `the runbook never names ${file}, so a restore that follows it stops short`);
  }
});

test("the restore runbook names the two dump sidecars", () => {
  // The dump has carried the KV pins and the holdout manifests since residual 4.
  // A restore that rebuilds D1 and stops leaves the improve loop with no mode, no
  // anchor pins and no manifests, which is a loop that refuses every run.
  const restore = restoreRunbook();
  assert.match(restore, /_kv\.json/, "the runbook does not mention the KV pins sidecar");
  assert.match(restore, /_holdout-manifests\.json/, "the runbook does not mention the holdout manifests sidecar");
});

// ---- the README is an index, and an index that loses an entry reads as deleted

test("the README links every document under docs/", () => {
  // The README was cut from 460 lines to its top-level shape by moving sections
  // into docs/. The failure that move can produce is a file nobody links, which
  // reads as deleted. Derived from the directory, so a new doc fails here until
  // the README points at it.
  const readme = read("README.md");
  const docs = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).sort();
  assert.ok(docs.length >= 10, `the docs scan found only ${docs.length} files`);
  for (const name of docs) {
    assert.ok(readme.includes(`docs/${name}`), `README never links docs/${name}`);
  }
});

test("the README states the authoritative tool count", () => {
  // The count lives in src/counts.ts and the README quotes it. CLAUDE.md was
  // already guarded above; the README said 32 with nothing checking it.
  const readme = read("README.md");
  assert.match(
    readme,
    new RegExp(`\\b${AUTHORITATIVE.capsid.tools} tools\\b`),
    `README does not state the current tool count (${AUTHORITATIVE.capsid.tools})`
  );
});
