import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// GROUP 4 (deploy pipeline), the CONFIG and SOURCE sites. The behavioural pieces
// (/health schema_version and backup age, the backup stamp) are tested against the
// real handlers in health.test.ts and backup.test.ts. What is left is wiring that
// lives in a workflow, a README and the cron entry point, none of which a node test
// can execute: a workflow does not run here, and index.ts pulls cloudflare:workers.
// The convention (capsid/conventions.md) is that the sites of a configuration
// change include the tests that assert its contents, so a later edit that quietly
// drops one of these goes red.

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("the deploy job refuses to ship against an unapplied migration", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /wrangler d1 migrations list capsid --remote/, "the migration-drift guard is gone");
  assert.match(ci, /No migrations to apply/, "the guard no longer keys on wrangler's confirmation string");
  // The guard must sit in the deploy job before the deploy step, or it shipped
  // first and guarded nothing.
  const listAt = ci.indexOf("migrations list capsid");
  const deployAt = ci.indexOf("npm run deploy");
  assert.ok(listAt > 0 && deployAt > 0 && listAt < deployAt, "the migration check runs after the deploy");
});

test("the scheduled live gate asserts the live sha equals master head", () => {
  const ci = read(".github/workflows/ci.yml");
  // EXPECT_SHA is now set on a schedule run too, so the six-hourly gate catches
  // drift between master and the deployed sha instead of asserting nothing.
  const expectLine = ci.split("\n").find((l) => l.includes("EXPECT_SHA:")) ?? "";
  assert.match(expectLine, /github\.event_name == 'schedule'/, "the scheduled run no longer asserts the deployed sha");
  assert.match(expectLine, /github\.sha/);
});

test("both improve crons rethrow after logging, like the backup cron", () => {
  const idx = read("src/index.ts");
  // BACKUP_CRON_THREW already rethrew; it is the known-true case that proves this
  // matcher is not vacuously passing on a block with no rethrow.
  for (const marker of ["BACKUP_CRON_THREW", "IMPROVE_OPEN_THREW", "IMPROVE_TICK_THREW"]) {
    const from = idx.indexOf(marker);
    assert.ok(from > 0, `${marker} is missing`);
    // From the log marker to the end of its catch arrow (the first `})` after it).
    const segment = idx.slice(from, from + idx.slice(from).indexOf("})"));
    assert.match(segment, /throw err/, `${marker} logs but does not rethrow, so a failed invocation reports clean`);
  }
});

test("README documents wrangler rollback as the code-recovery path", () => {
  const readme = read("README.md");
  assert.match(readme, /^## Rollback$/m, "the Rollback section is gone");
  assert.match(readme, /wrangler rollback/, "the rollback command is undocumented");
  assert.match(readme, /wrangler deployments list/, "the version-listing step is missing");
});

// ---- rollback on a failed gate (residual 7) ---------------------------------

test("the live job rolls back when a gate fails on a run that deployed", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /wrangler@[\d.]+ rollback/, "the live job has no rollback step");
  // GUARDED TO THIS RUN'S OWN DEPLOY. On a scheduled run the deploy job is
  // skipped and a red gate usually means the live sha is BEHIND master; rolling
  // back there would move production further from master, not closer.
  const step = ci.slice(ci.indexOf("Roll back"), ci.indexOf("Reap this run's probe client"));
  assert.match(step, /failure\(\)/, "the rollback step is not conditioned on a failure");
  assert.match(step, /needs\.deploy\.result == 'success'/, "the rollback runs on runs that did not deploy");
  // BOTH SHAS. A rollback that does not say what it left running is a rollback
  // nobody can check afterwards.
  assert.match(step, /ROLLBACK_FROM|before/i, "the rollback does not report the sha it rolled back from");
  assert.match(step, /ROLLBACK_TO|after/i, "the rollback does not report the sha now live");
});

test("the rollback pins the same wrangler version the deploy uses", () => {
  const ci = read(".github/workflows/ci.yml");
  const pkg = JSON.parse(read("package.json")) as { devDependencies?: Record<string, string> };
  const pinned = pkg.devDependencies?.wrangler;
  assert.ok(pinned, "wrangler is no longer a pinned devDependency");
  // The live job runs without npm ci on purpose, so its wrangler comes from npx
  // and would otherwise float to whatever latest is on the day production breaks.
  assert.match(ci, new RegExp(`wrangler@${pinned.replace(/\./g, "\.")} rollback`), `the rollback does not pin wrangler ${pinned}`);
});
