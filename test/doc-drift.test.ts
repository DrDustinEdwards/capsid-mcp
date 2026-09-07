import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
