// /health, in its own module so it can be TESTED. src/routes.ts imports the Agents
// SDK, which pulls in `cloudflare:workers` and cannot load under node --test, so a
// handler defined there is unreachable from the suite (same reason rate-limit.ts
// lives apart). The health report is worth a real test: it now carries the schema
// version and the backup age, and both have branches that a source scan cannot check.
//
// /health carries deploy provenance so "the deployed worker is this commit" is a
// readable fact rather than an inference from a clean tree. The vars are stamped at
// deploy time by scripts/deploy.mjs; dirty=true means the deployed bytes are NOT a
// clean commit. It also PROBES the store, because a Worker whose DB binding is
// missing or pointed at an empty database starts perfectly and answers /health with
// a cheerful ok while every read tool errors.
//
// Two store probes, because they fail separately:
//   d1  - SELECT 1. The binding exists and the database answers.
//   fts - a MATCH that must return one PINNED document, which catches index damage.
//
// Two operational facts added in the 2026-09-07 deploy-pipeline group, both
// INFORMATIONAL. Neither degrades health: health is whether the store answers, and
// these two are whether an operator should look.
//   schema_version - the newest applied migration name, so a Worker running against
//                    an out-of-date database is visible without opening the D1 dash.
//   backup         - the age of the last successful backup. A stamp older than 26h
//                    (the daily cron plus a 2h grace) carries a warning.

import type { Env } from "./env";
import { probeFts } from "./store-probe";

export const BACKUP_LAST_OK_KEY = "backup:last-ok";
// The daily backup cron runs every 24h; 26h is that period plus a 2h grace, so a
// single late or slow run does not warn while a genuinely missed day does.
export const BACKUP_STALE_HOURS = 26;

async function backupFreshness(
  env: Env
): Promise<{ last_ok: string | null; age_hours: number | null; warning?: string }> {
  let lastOk: string | null = null;
  try {
    lastOk = await env.APP_KV.get(BACKUP_LAST_OK_KEY);
  } catch (err) {
    return {
      last_ok: null,
      age_hours: null,
      warning: `backup freshness unreadable: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`,
    };
  }
  if (!lastOk) return { last_ok: null, age_hours: null, warning: "no successful backup recorded" };
  const ageMs = Date.now() - Date.parse(lastOk);
  const ageHours = Math.round((ageMs / 3_600_000) * 10) / 10;
  const result: { last_ok: string; age_hours: number; warning?: string } = { last_ok: lastOk, age_hours: ageHours };
  if (ageMs > BACKUP_STALE_HOURS * 3_600_000) {
    result.warning = `last successful backup was ${ageHours}h ago, over the ${BACKUP_STALE_HOURS}h threshold`;
  }
  return result;
}

export async function handleHealth(env: Env): Promise<Response> {
  const provenance = {
    sha: env.BUILD_SHA ?? "unknown",
    dirty: env.BUILD_DIRTY === "true",
    builtAt: env.BUILT_AT ?? null,
  };

  let d1 = "unbound";
  let fts = "skipped";
  try {
    const one = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    d1 = one?.ok === 1 ? "ok" : `unexpected: ${JSON.stringify(one)}`;
  } catch (err) {
    d1 = `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
  }
  if (d1 === "ok") fts = await probeFts(env.DB);

  // The schema version the store is actually running against. Best-effort: a
  // missing d1_migrations table (a store not managed by wrangler migrations) is a
  // null, not a health failure.
  let schema_version: string | null = null;
  if (d1 === "ok") {
    try {
      const row = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>();
      schema_version = row?.name ?? null;
    } catch {
      schema_version = null;
    }
  }

  const backup = await backupFreshness(env);

  const healthy = d1 === "ok" && fts === "ok";
  return Response.json(
    { status: healthy ? "ok" : "degraded", ...provenance, schema_version, store: { d1, fts }, backup },
    { status: healthy ? 200 : 503 }
  );
}
