import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { handleHealth } from "../src/health.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// GROUP 4 (deploy pipeline). /health gained two operational facts: the schema
// version it is running against, and the age of the last successful backup. Both
// are informational: a stale backup or an unreadable migration name is a WARNING,
// never a reason to report degraded, because health is about whether the store
// answers, and these two are about whether the operator should look.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const NEWEST_MIGRATION = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().at(-1);

function healthEnv(parts: Record<string, unknown>) {
  return fakeEnv({
    BUILD_SHA: "abc123",
    BUILT_AT: "2026-09-07T00:00:00Z",
    ...parts,
  });
}

async function bodyOf(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json()) as Record<string, unknown>;
}

test("schema_version is the newest applied migration name", async () => {
  const env = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql", "0002_document_links.sql", "0003_improve.sql", "0004_improve_jti.sql"] }).db,
    APP_KV: fakeKv({ seed: { "backup:last-ok": new Date().toISOString() } }).kv,
  });
  const body = await bodyOf(await handleHealth(env));
  assert.equal(body.schema_version, "0004_improve_jti.sql");
  // Pinned to the real migrations directory, so a new migration that ships
  // without this assertion tracking it fails here rather than drifting silently.
  assert.equal(body.schema_version, NEWEST_MIGRATION);
});

test("a fresh backup carries an age and no warning, and does not degrade health", async () => {
  const env = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({ seed: { "backup:last-ok": new Date(Date.now() - 2 * 3600_000).toISOString() } }).kv,
  });
  const resp = await handleHealth(env);
  const body = await bodyOf(resp);
  assert.equal(resp.status, 200);
  assert.equal(body.status, "ok");
  const backup = body.backup as { age_hours: number; warning?: string };
  assert.ok(backup.age_hours >= 1.9 && backup.age_hours <= 2.1, `age_hours was ${backup.age_hours}`);
  assert.equal(backup.warning, undefined);
});

test("a backup older than 26 hours warns, but health stays ok", async () => {
  const env = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({ seed: { "backup:last-ok": new Date(Date.now() - 30 * 3600_000).toISOString() } }).kv,
  });
  const resp = await handleHealth(env);
  const body = await bodyOf(resp);
  assert.equal(resp.status, 200, "a stale backup is a warning, not a health failure");
  assert.equal(body.status, "ok");
  const backup = body.backup as { warning?: string };
  assert.match(String(backup.warning), /26h/);
});

test("a missing backup stamp warns rather than throwing", async () => {
  const env = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({}).kv,
  });
  const body = await bodyOf(await handleHealth(env));
  const backup = body.backup as { last_ok: string | null; warning?: string };
  assert.equal(backup.last_ok, null);
  assert.match(String(backup.warning), /no successful backup/i);
});

test("a degraded store still reports, and the backup read failing does not mask it", async () => {
  const env = healthEnv({
    DB: fakeD1({ ftsHit: false, migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({ failGet: true }).kv,
  });
  const resp = await handleHealth(env);
  const body = await bodyOf(resp);
  assert.equal(resp.status, 503);
  assert.equal(body.status, "degraded");
  // The KV failure is contained: backup carries a warning, it does not throw.
  assert.ok((body.backup as { warning?: string }).warning);
});
