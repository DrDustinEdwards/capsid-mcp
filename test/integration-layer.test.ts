import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// THE INTEGRATION LAYER IS WIRED, AND CI RUNS IT.
//
// A suite that exists and is never run is worse than no suite: it reads as
// coverage. capsid/conventions.md, "a guard that has never been observed failing
// has not been verified", applies to the harness as much as to a guard, so this
// file asserts from the UNIT suite that the integration suite is reachable, typed
// and in the workflow. It cannot run vitest itself, and it is not trying to.

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PKG = JSON.parse(read("package.json")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
const CI = read(".github/workflows/ci.yml");
const CONFIG = read("vitest.config.ts");

test("the integration suite has files, and they are where the config looks", () => {
  const files = readdirSync(join(ROOT, "test-integration")).filter((f) => f.endsWith(".test.ts"));
  assert.ok(files.length >= 4, `test-integration holds ${files.length} suites; expected at least four`);
  assert.match(CONFIG, /include: \["test-integration\/\*\*\/\*\.test\.ts"\]/);
  // And the unit glob does NOT reach them, or node --test would try to run a file
  // importing `cloudflare:test` and fail for a reason that has nothing to do with
  // the code under test.
  assert.equal(PKG.scripts.test, 'node --import ./test/resolve-ts.mjs --test "test/*.test.ts"');
});

test("PLANT: CI runs both suites and typechecks all three configs", () => {
  for (const step of ["npm run check", "npm run check:test", "npm run check:integration", "npm run check:scripts", "npm test", "npm run test:integration"]) {
    assert.ok(CI.includes(`run: ${step}`), `the CI checks job does not run \`${step}\``);
  }
  // Ordering matters: the deploy job is `needs: checks`, so an integration failure
  // has to be inside that job rather than in a job beside it.
  const checksJob = CI.slice(CI.indexOf("  checks:"), CI.indexOf("  deploy:"));
  assert.ok(checksJob.includes("npm run test:integration"), "the integration suite must be inside the job deploy depends on");
});

test("the migrations really are applied by the setup file, from migrations/", () => {
  const setup = read("test-integration/apply-migrations.ts");
  assert.match(setup, /applyD1Migrations\(env\.DB, env\.TEST_MIGRATIONS\)/);
  assert.match(CONFIG, /readD1Migrations\(path\.join\(import\.meta\.dirname, "migrations"\)\)/);
  // Vacuity guard: a migrations directory the config points at that holds nothing
  // would apply nothing and every integration test would run against an empty
  // database that still answered.
  const migrations = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql"));
  assert.ok(migrations.length >= 4, `migrations/ holds ${migrations.length} files`);
});

test("the integration compatibility date is not AHEAD of the deploy date", () => {
  // The pool's workerd caps at a date behind production, so the two differ on
  // purpose and the config says so. What must never happen is the reverse: a
  // suite running at a LATER date than deploys would pass on behaviour production
  // does not have.
  const integration = CONFIG.match(/INTEGRATION_COMPAT_DATE = "([\d-]+)"/)?.[1];
  assert.ok(integration, "the integration compatibility date is not declared where this test can read it");
  const bindings = read("scripts/bindings.mjs");
  const deployed = bindings.match(/COMPATIBILITY_DATE = "([\d-]+)"/)?.[1];
  assert.ok(deployed, "scripts/bindings.mjs no longer declares COMPATIBILITY_DATE where this test can read it");
  assert.ok(
    integration! <= deployed!,
    `the integration suite runs at ${integration}, ahead of the deployed ${deployed}: it would pass on behaviour production does not have`
  );
});

test("no real secret reached the integration bindings", () => {
  // capsid/conventions.md hard rule 3, applied to the one config file in this repo
  // that carries secret-shaped values at all.
  assert.match(CONFIG, /IMPROVE_SCORE_SECRET: "integration-root-secret-not-a-real-one"/);
  for (const suspicious of [/sk-ant-/, /ghp_/, /github_pat_/, /-----BEGIN/]) {
    assert.doesNotMatch(CONFIG, suspicious, `vitest.config.ts carries something matching ${suspicious}`);
  }
});
