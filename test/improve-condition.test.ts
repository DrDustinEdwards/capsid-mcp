import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CONDITION,
  isRunCondition,
  RUN_CONDITIONS,
  type RunCondition,
} from "../src/improve-schema.ts";
import { improveRunManual, openRuns } from "../src/improve-run.ts";
import { anchorChecksum, parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";

// improve_runs.condition, from the arc's third ruling.
//
// The column exists so an ablation is a query rather than an archaeology exercise.
// That gives it three separate obligations, and this file asserts each: the
// vocabulary is one list rather than two, the value is recorded on the row AND in
// the audit rows, and each value actually switches something off. A condition
// recorded on a run that behaved identically to `full` is a label that lies, which
// is worse than no column at all.

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0003_improve.sql"), "utf8");
const SCORES = seedScoresDoc("capsid");
const NOW = new Date("2026-09-05T08:05:00Z");

// ---- the column and the vocabulary ------------------------------------------

test("the migration declares the column, NOT NULL, defaulting to full", () => {
  assert.match(MIGRATION, /condition TEXT NOT NULL DEFAULT 'full',/);
  assert.equal(DEFAULT_CONDITION, "full");
});

test("THE VOCABULARY IN CODE MATCHES THE SET THE MIGRATION DOCUMENTS", () => {
  // A TEXT column with no CHECK constraint, validated in code: the same shape and
  // the same reasoning as DOC_STATUSES. That only holds if the two lists agree, so
  // the migration's own comment is parsed rather than trusted.
  const documented = [...MIGRATION.matchAll(/'(full|no-memory|no-transfer)'/g)].map((m) => m[1]);
  assert.ok(documented.length > 0, "the migration no longer names the condition values; this derivation is broken");
  assert.deepEqual([...new Set(documented)].sort(), [...RUN_CONDITIONS].sort());
});

test("the column carries NO CHECK constraint, deliberately", () => {
  // src/doc-meta.ts records the ruling: the vocabulary is a code-level set, so
  // adding a value needs no migration. A CHECK here would silently make that false.
  const block = /CREATE TABLE IF NOT EXISTS improve_runs \(([\s\S]*?)\n\);/.exec(MIGRATION);
  assert.ok(block, "could not bound the improve_runs table in the migration");
  assert.equal(/CHECK\s*\(/i.test(block[1]), false, "improve_runs gained a CHECK constraint");
});

test("isRunCondition admits exactly the three and nothing else", () => {
  for (const value of RUN_CONDITIONS) assert.equal(isRunCondition(value), true, `${value} was rejected`);
  for (const value of ["", "FULL", "no memory", "nomemory", "none", "full ", "no-transfers"]) {
    assert.equal(isRunCondition(value), false, `'${value}' was admitted`);
  }
});

// ---- set and logged on every run --------------------------------------------

async function harness(kvSeed: Record<string, string> = {}) {
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "s", body: SCORES, type: "reference" }],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) }],
  });
  const kv = fakeKv({
    seed: {
      improve_mode: "api",
      "improve:anchor:capsid": await anchorChecksum(parseScoresDoc("capsid", SCORES)),
      ...kvSeed,
    },
    seedToken: true,
  });
  const env = fakeEnv({ DB: d1.db, APP_KV: kv.kv, HOLDOUT: fakeR2().bucket, MEDIA: fakeR2().bucket });
  return { d1, kv, env };
}

const auditRows = (recorded: Array<{ sql: string; params: unknown[] }>) =>
  recorded
    .filter((r) => r.sql.includes("INSERT INTO audit_log"))
    .map((r) => ({ action: r.params[1] as string, params: JSON.parse(String(r.params[4] ?? r.params[3])) as Record<string, unknown> }));

test("a run opened with no condition is recorded as full", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness();
    await openRuns(env, NOW, "capsid");
    assert.equal(d1.rows.improve_runs.length, 1, "no run was opened");
    assert.equal(d1.rows.improve_runs[0].condition, "full");
  });
});

test("EVERY CONDITION IS RECORDED ON THE ROW as asked for", async () => {
  for (const condition of RUN_CONDITIONS) {
    await withFetch({}, async () => {
      const { d1, env } = await harness();
      await openRuns(env, NOW, "capsid", condition);
      assert.equal(d1.rows.improve_runs[0].condition, condition, `${condition} was not recorded`);
    });
  }
});

test("THE CONDITION IS IN THE OPENING AUDIT ROW, not only on the row it describes", async () => {
  // improve_runs is pruned by nothing, but audit_log is the one table where a
  // single query answers "what did the loop do, and under what condition".
  await withFetch({}, async () => {
    const { d1, env } = await harness();
    await openRuns(env, NOW, "capsid", "no-memory");
    const opened = auditRows(d1.recorded).find((a) => a.action === "improve-run-opened");
    assert.ok(opened, "no improve-run-opened audit row was written");
    assert.equal(opened.params.condition, "no-memory");
  });
});

test("the FINISHING audit row carries it too, so one query covers a run's whole life", () => {
  // Driven by source: reaching finalize behaviourally needs a full run, and the
  // claim under test is that the field is present on the row the finalizer writes.
  const run = sourceFile("improve-run.ts");
  const start = run.indexOf('improveAudit(env.DB, "improve-run-finished"');
  assert.ok(start !== -1, "the improve-run-finished audit row is gone");
  const block = run.slice(start, start + 400);
  assert.match(block, /condition: run\.condition,/);
});

test("the run summary document states the condition", () => {
  const run = sourceFile("improve-run.ts");
  assert.match(run, /`- condition: \$\{run\.condition\}`/);
});

// ---- each condition switches something off ----------------------------------

test("'no-memory' WITHHOLDS LINEAGE HISTORY from base selection", () => {
  // The ablation is only real if the input is actually withheld. Asserted at the
  // call site because that is where the withholding happens; a condition that
  // reached selectBase with the full history would be a label that lies.
  const run = sourceFile("improve-run.ts");
  assert.match(
    run,
    /const lineage = run\.condition === "no-memory" \? \[\] : await recentAttempts\(/,
    "'no-memory' no longer withholds lineage history"
  );
  assert.match(run, /selectBase\(best, lineage, run\.base_sha\)/);
});

test("'no-transfer' OFFERS NO cross-project skill", () => {
  const run = sourceFile("improve-run.ts");
  assert.match(
    run,
    /run\.condition !== "no-transfer" \? await candidateSkills\(/,
    "'no-transfer' no longer withholds transferred skills"
  );
});

test("EVERY CONDITION OTHER THAN full CHANGES A BEHAVIOUR", () => {
  // The guard against adding a fourth value that records a difference it does not
  // make. Every non-default condition must be named somewhere in the orchestrator
  // outside its own type declaration.
  const run = sourceFile("improve-run.ts");
  for (const condition of RUN_CONDITIONS) {
    if (condition === DEFAULT_CONDITION) continue;
    assert.ok(
      run.includes(`"${condition}"`),
      `condition '${condition}' is declared but src/improve-run.ts never branches on it, so a run recorded under it behaves identically to full`
    );
  }
});

// ---- the tool surface -------------------------------------------------------

test("AN UNRECOGNISED CONDITION IS REFUSED, not silently defaulted to full", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness();
    await assert.rejects(
      () => improveRunManual(env, NOW, { namespace: "capsid", dryRun: false, condition: "no-lineage" }),
      /unknown condition 'no-lineage'/
    );
    // And nothing was opened, so a refused condition cannot half-start a run.
    assert.deepEqual(d1.rows.improve_runs, []);
  });
});

test("the refusal names every valid condition", async () => {
  await withFetch({}, async () => {
    const { env } = await harness();
    await improveRunManual(env, NOW, { namespace: "capsid", dryRun: true, condition: "bogus" }).then(
      () => assert.fail("a bogus condition was accepted"),
      (err: Error) => {
        for (const condition of RUN_CONDITIONS) {
          assert.match(err.message, new RegExp(condition), `the refusal does not name ${condition}`);
        }
      }
    );
  });
});

test("the manual result reports the condition it ran under, including on a dry run", async () => {
  await withFetch({}, async () => {
    const { env } = await harness();
    const dry = await improveRunManual(env, NOW, { namespace: "capsid", dryRun: true, condition: "no-transfer" });
    assert.equal(dry.condition, "no-transfer");
    assert.equal(dry.dry_run, true);
    const dflt = await improveRunManual(env, NOW, { namespace: "capsid", dryRun: true });
    assert.equal(dflt.condition, DEFAULT_CONDITION);
  });
});

test("the improve_run tool exposes condition and describes what each value does", () => {
  const server = sourceFile("server.ts");
  const start = server.indexOf('"improve_run"');
  const end = server.indexOf('"improve_status"');
  const block = server.slice(start, end);
  assert.match(block, /condition: bounded\(/);
  assert.match(block, /no-memory/);
  assert.match(block, /no-transfer/);
  // The tool passes it through rather than dropping it, which a description alone
  // would not prove.
  assert.match(block, /condition\s*\}\)\);/);
});

// A type-level assertion: RunCondition is the union, not a bare string, so a typo
// in a call site is a compile error rather than a row nobody notices.
const TYPED: RunCondition = DEFAULT_CONDITION;
test("the condition is a union type, not a bare string", () => {
  assert.equal(TYPED, "full");
  const state = sourceFile("improve-state.ts");
  assert.match(state, /condition: RunCondition;/, "RunRow.condition went back to a bare string");
});
