import type { Env } from "./env";
import { BACKUP_LAST_OK_KEY } from "./health";
import { REPORT_PREFIX } from "./headers";
import { anchorKey, bestKey, BUDGET_KEY, META_LAST_KEY, MODE_KEY, pausedKey, ROSTER } from "./improve-schema";
import { readHoldoutManifests } from "./improve-scorer";
import { probeFts } from "./store-probe";

const JSON_PREFIX = "backups/json/";
const MARKDOWN_PREFIX = "backups/markdown/";
const PUT_CONCURRENCY = 20;

// KV lease is best-effort (no CAS). Export before prune. Dump TTL 90 days by age.
const LEASE_KEY = "backup:lease";
const LEASE_TTL_SECONDS = 900;

const JSON_RETENTION_DAYS = 90;
// A floor under the age rule. If the cron stops for months every dump ages out,
// so the newest N survive regardless of age.
const JSON_MIN_KEPT = 14;
// Retention for the history tables. Both are covered by the dump shelf life above.
const VERSION_RETENTION_DAYS = 90;
const AUDIT_RETENTION_DAYS = 180;

// CSP and COOP violation reports. 30 days, ruled 2026-08-13. Nothing else prunes
// this prefix, and it is written by a public unauthenticated path.
const REPORT_RETENTION_DAYS = 30;

// Both prefixes carry an ISO date at a fixed offset, so the age test is a string
// comparison. A key with no parseable day is never pruned.
function isOlderThan(key: string, prefix: string, cutoffDay: string): boolean {
  const day = key.slice(prefix.length, prefix.length + 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < cutoffDay;
}

// Retention operates on the dump, never on the object (audit 2, F33 light). A dump
// is a key PREFIX holding one object per table, so keys are grouped by run id (the
// segment after backups/json/), the newest JSON_MIN_KEPT RUNS are the floor, and an
// aged-out run is deleted whole. Counting objects would cut the floor to 2.8 dumps.
//
// A run id begins with its own ISO day, which is why the age test below passes an
// empty prefix. A flat key written before this change has no slash and is its own
// single-object run, so it ages out on the same rule.
function runIdOf(key: string): string {
  const rest = key.slice(JSON_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function cutoffDay(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

// Every real table in the schema. test/backup.test.ts derives this list from
// migrations/ and fails in both directions. Excluded: documents_fts and its
// documents_fts_* shadow tables, which the sync triggers rebuild from documents,
// and sqlite_sequence, which SQLite maintains for AUTOINCREMENT.
export const TABLES = [
  "documents",
  "namespaces",
  "document_versions",
  "audit_log",
  "document_links",
  // The improve loop's four tables, added by migrations/0003_improve.sql. Nothing
  // prunes them, so a dump is the only copy of the lineage outside D1.
  "improve_scores",
  "improve_attempts",
  "improve_runs",
  "improve_skills",
  // The work queue (migrations/0006). Nothing prunes it either: a done job is the
  // record of who asked for what and what came back, and the mirrored document
  // carries only the body.
  "jobs",
  // The scoped credentials (migrations/0008). Nothing prunes it: a revoked agent
  // keeps its row so the audit trail it wrote still resolves to what it was allowed
  // to do. What the dump carries is the sha256 VERIFIER, never a key, exactly as
  // OPERATOR_KEY_HASH carries one; losing this table would orphan every minted
  // credential in the portfolio with no way to tell which was which.
  "agents",
  // The replay cache (migrations/0004). Pruned below rather than retained: a jti
  // is only meaningful inside the 30-minute signature window.
  "improve_jti",
] as const;

export interface BackupSummary {
  ran: true;
  json_prefix: string;
  json_keys: string[];
  documents: number;
  markdown_written: number;
  markdown_pruned: number;
  json_backups_kept: number;
  json_backups_pruned: number;
  reports_pruned: number;
  versions_pruned: number;
  audit_pruned: number;
  // Null on a healthy run. Otherwise the named reason NOTHING was deleted. Read it
  // before believing a zero in any of the *_pruned counters.
  prune_refused: string | null;
  preflight: { documents: number; fts: string };
}

// A run that did not run. Named rather than thrown so the caller can tell a held
// lease from a failure.
export interface BackupSkipped {
  ran: false;
  skipped: string;
}

export type BackupResult = BackupSummary | BackupSkipped;

// R2's bulk delete takes at most 1000 keys per call and REFUSES the 1001st rather
// than truncating. All three prunes used to hand it an unbounded array, so a large
// shed threw after the dumps were written and before backup:last-ok was stamped.
// Residual 5, closed 2026-09-08.
const R2_DELETE_MAX = 1000;

// One chunker for all three prunes, so a fourth delete site cannot be written
// unchunked beside three that are. Returns the count so callers count in one place.
async function deleteInChunks(bucket: R2Bucket, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX) {
    await bucket.delete(keys.slice(i, i + R2_DELETE_MAX));
  }
  return keys.length;
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function runBackup(env: Env): Promise<BackupResult> {
  const held = await env.APP_KV.get(LEASE_KEY);
  if (held !== null) {
    console.error(`BACKUP_LEASE_HELD another run holds ${LEASE_KEY} (started ${held}); this run pruned nothing`);
    return { ran: false, skipped: "lease-held" };
  }
  const now = new Date().toISOString();
  await env.APP_KV.put(LEASE_KEY, now, { expirationTtl: LEASE_TTL_SECONDS });
  try {
    return await exportAndPrune(env, now);
  } finally {
    // Release on the way out, success or throw, so the TTL only has to cover an
    // isolate that died mid-run.
    await env.APP_KV.delete(LEASE_KEY);
  }
}

// THE KV PINS, BY ALLOWLIST AND NEVER BY PREFIX SWEEP.
//
// APP_KV also holds the GitHub installation-token cache, and a dump leaves the
// account, so a prefix sweep here would mirror a live credential the first time
// someone added a key under a prefix nobody re-read. Every key below is a control
// value a human set and none is a secret.
//
// backup:lease is absent: it is this run's own bookkeeping.
function kvPinKeys(): string[] {
  const keys = [MODE_KEY, BUDGET_KEY, META_LAST_KEY, BACKUP_LAST_OK_KEY];
  for (const namespace of ROSTER) keys.push(bestKey(namespace), pausedKey(namespace), anchorKey(namespace));
  return keys;
}

async function readKvPins(env: Env): Promise<Record<string, string | null>> {
  const pins: Record<string, string | null> = {};
  for (const key of kvPinKeys()) {
    try {
      pins[key] = await env.APP_KV.get(key);
    } catch {
      // An unreadable key is a null beside the others. The D1 dump is the half that
      // must not be lost to a KV hiccup.
      pins[key] = null;
    }
  }
  return pins;
}

async function exportAndPrune(env: Env, now: string): Promise<BackupSummary> {
  // ONE BATCH, ONE SNAPSHOT (residual 4, closed 2026-09-08).
  //
  // D1's batch is ONE TRANSACTION executed in order, so the ten reads agree with
  // each other and `exported_at` describes one instant. Sequential reads were ten
  // instants: a write landing between the documents read and the document_versions
  // read put a version row in the dump whose document was not in it, and nothing
  // downstream could tell. The restore rehearsal checks for that signature.
  //
  // The cost is peak isolate memory: all row sets are live at once. Measured live
  // 2026-08-17, document_versions 25.8MB and documents 5.4MB on a 38.5MB database
  // against a 128MB isolate. Each result set is stringified, written, and dropped
  // before the next is touched, so at most one serialized copy is alive on top of
  // the row sets. If this ever pushes an isolate over, move document_versions and
  // audit_log to their own cadence rather than back to a dump that tears.
  const jsonPrefix = `${JSON_PREFIX}${now.replace(/[:.]/g, "-")}/`;
  const jsonKeys: string[] = [];
  const snapshot = await env.DB.batch(TABLES.map((table) => env.DB.prepare(`SELECT * FROM ${table}`)));
  let docs: Array<{ namespace: string; path: string; body: string | null }> = [];
  const rowsPerTable: Array<unknown[] | null> = TABLES.map((_, i) => (snapshot[i]?.results ?? []) as unknown[]);
  for (let i = 0; i < TABLES.length; i++) {
    const table = TABLES[i];
    const results = rowsPerTable[i] ?? [];
    if (table === "documents") docs = results as typeof docs;
    const key = `${jsonPrefix}${table}.json`;
    await env.MEDIA.put(key, JSON.stringify({ exported_at: now, table, rows: results }), {
      httpMetadata: { contentType: "application/json" },
    });
    jsonKeys.push(key);
    // documents is retained: the preflight and the markdown mirror both read it.
    if (table !== "documents") rowsPerTable[i] = null;
  }

  // THE TWO SIDECARS. Underscore-prefixed so they cannot collide with a table name
  // and the restore rehearsal can tell a sidecar from a table file without a
  // hardcoded exception list.
  //
  // Neither is in D1. A restore without them leaves the improve loop with no mode,
  // anchor pins, pause reasons, best commits or holdout manifests, so every
  // namespace scores as "no manifest" and every run refuses.
  await env.MEDIA.put(`${jsonPrefix}_kv.json`, JSON.stringify({ exported_at: now, keys: await readKvPins(env) }), {
    httpMetadata: { contentType: "application/json" },
  });
  jsonKeys.push(`${jsonPrefix}_kv.json`);
  await env.MEDIA.put(
    `${jsonPrefix}_holdout-manifests.json`,
    JSON.stringify({ exported_at: now, manifests: await readHoldoutManifests(env) }),
    { httpMetadata: { contentType: "application/json" } }
  );
  jsonKeys.push(`${jsonPrefix}_holdout-manifests.json`);

  // PREFLIGHT BEFORE ANYTHING DESTRUCTIVE (audit 2, F16).
  //
  // The dangerous case is a SELECT that SUCCEEDS AND RETURNS NOTHING. An empty
  // documents table, or a DB binding resolved by name to an empty or rebound
  // database, makes currentKeys empty, which marks every object under
  // backups/markdown/ stale and deletes the mirror in one call.
  //
  // Two probes: a count floor above zero, and the same pinned FTS probe /health
  // uses, which catches a binding pointed at a different database that has rows.
  //
  // A failure refuses everything past this point as a unit: the markdown WRITE, the
  // three R2 prunes and the two D1 deletes. A run that cannot trust its read of
  // documents cannot trust content derived from it, and the D1 deletes target the
  // same suspect database. The JSON dumps above are kept: an export deletes nothing
  // and an empty dump is the evidence of the day the store looked empty.
  const fts = await probeFts(env.DB);
  const pruneRefused = docs.length === 0 ? "documents-empty" : fts === "ok" ? null : `fts-probe-failed: ${fts}`;
  if (pruneRefused !== null) {
    console.error(
      `BACKUP_PREFLIGHT_REFUSED reason=${pruneRefused} documents=${docs.length} fts=${fts} ` +
        `dumps_written=${jsonKeys.length} prefix=${jsonPrefix}; nothing was written to or deleted from the mirror`
    );
    return {
      ran: true,
      json_prefix: jsonPrefix,
      json_keys: jsonKeys,
      documents: docs.length,
      markdown_written: 0,
      markdown_pruned: 0,
      json_backups_kept: 0,
      json_backups_pruned: 0,
      reports_pruned: 0,
      versions_pruned: 0,
      audit_pruned: 0,
      prune_refused: pruneRefused,
      preflight: { documents: docs.length, fts },
    };
  }

  const currentKeys = new Set<string>();
  for (let i = 0; i < docs.length; i += PUT_CONCURRENCY) {
    await Promise.all(
      docs.slice(i, i + PUT_CONCURRENCY).map((doc) => {
        const key = `${MARKDOWN_PREFIX}${doc.namespace}/${doc.path}`;
        currentKeys.add(key);
        return env.MEDIA.put(key, doc.body ?? "", { httpMetadata: { contentType: "text/markdown" } });
      })
    );
  }

  const existingMarkdown = await listAllKeys(env.MEDIA, MARKDOWN_PREFIX);
  const staleMarkdown = existingMarkdown.filter((key) => !currentKeys.has(key));
  if (staleMarkdown.length > 0) await deleteInChunks(env.MEDIA, staleMarkdown);

  // Group objects into runs, newest run first, so the floor is runs and not objects.
  const runs = new Map<string, string[]>();
  for (const key of await listAllKeys(env.MEDIA, JSON_PREFIX)) {
    const id = runIdOf(key);
    const existing = runs.get(id);
    if (existing) existing.push(key);
    else runs.set(id, [key]);
  }
  const runIds = [...runs.keys()].sort().reverse();
  const dumpCutoff = cutoffDay(new Date(now), JSON_RETENTION_DAYS);
  const staleRunIds = runIds.slice(JSON_MIN_KEPT).filter((id) => isOlderThan(id, "", dumpCutoff));
  const staleDumpKeys = staleRunIds.flatMap((id) => runs.get(id) ?? []);
  if (staleDumpKeys.length > 0) await deleteInChunks(env.MEDIA, staleDumpKeys);

  const reportCutoff = cutoffDay(new Date(now), REPORT_RETENTION_DAYS);
  const staleReports = (await listAllKeys(env.MEDIA, REPORT_PREFIX)).filter((key) =>
    isOlderThan(key, REPORT_PREFIX, reportCutoff)
  );
  if (staleReports.length > 0) await deleteInChunks(env.MEDIA, staleReports);

  // Prune history AFTER the export above, so the rows leaving D1 are in today's dump.
  //
  // COUNTED, NOT REPORTED (audit 2, F37). meta.changes is inflated by the FTS5
  // triggers, so each DELETE is preceded by a COUNT over the identical predicate.
  // Both pairs are in one batch, one transaction in order, so the count is of exactly
  // the rows the next statement removes.
  const pruned = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM document_versions WHERE snapshot_at < datetime('now', ?1)").bind(
      `-${VERSION_RETENTION_DAYS} days`
    ),
    env.DB.prepare("DELETE FROM document_versions WHERE snapshot_at < datetime('now', ?1)").bind(
      `-${VERSION_RETENTION_DAYS} days`
    ),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE at < datetime('now', ?1)").bind(
      `-${AUDIT_RETENTION_DAYS} days`
    ),
    env.DB.prepare("DELETE FROM audit_log WHERE at < datetime('now', ?1)").bind(`-${AUDIT_RETENTION_DAYS} days`),
    // The replay cache, appended LAST so the two count/delete pairs above keep the
    // positions their counters read. A jti is meaningful only inside the 30-minute
    // signature window.
    env.DB.prepare("DELETE FROM improve_jti WHERE seen_at < datetime('now', '-1 day')"),
  ]);

  // Stamp the last CLEAN success. Read by /health, which warns past a day. A
  // preflight-refused run returned above without stamping.
  await env.APP_KV.put(BACKUP_LAST_OK_KEY, now);

  return {
    ran: true,
    json_prefix: jsonPrefix,
    json_keys: jsonKeys,
    documents: docs.length,
    markdown_written: docs.length,
    markdown_pruned: staleMarkdown.length,
    json_backups_kept: runIds.length - staleRunIds.length,
    json_backups_pruned: staleRunIds.length,
    reports_pruned: staleReports.length,
    versions_pruned: pruned[0]?.results?.[0]?.n ?? 0,
    audit_pruned: pruned[2]?.results?.[0]?.n ?? 0,
    prune_refused: null,
    preflight: { documents: docs.length, fts },
  };
}
