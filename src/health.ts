import type { Env } from "./env";
import { probeFts } from "./store-probe";

export const BACKUP_LAST_OK_KEY = "backup:last-ok";
// Daily cron is 24h; 26h is that plus a 2h grace so one slow run does not warn.
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

export interface HealthReport {
  status: "ok" | "degraded";
  sha: string;
  dirty: boolean;
  builtAt: string | null;
  schema_version: string | null;
  store: { d1: string; fts: string };
  backup: { last_ok: string | null; age_hours: number | null; warning?: string };
}

// THE PROBE AS DATA. /health serializes this and the console header renders it, so
// the sha, the schema version and the backup age a person reads on the console are
// the same three values the live gate asserts. A second query path for them would be
// a second set of numbers to disagree.
export async function healthReport(env: Env): Promise<HealthReport> {
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

  // Informational. A store without d1_migrations is null, not a health failure.
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
  return { status: healthy ? "ok" : "degraded", ...provenance, schema_version, store: { d1, fts }, backup };
}

export async function handleHealth(env: Env): Promise<Response> {
  const report = await healthReport(env);
  return Response.json(report, { status: report.status === "ok" ? 200 : 503 });
}
