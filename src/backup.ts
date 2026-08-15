import type { Env } from "./env";
import { REPORT_PREFIX } from "./headers";
import { probeFts } from "./store-probe";

const JSON_PREFIX = "backups/json/";
const MARKDOWN_PREFIX = "backups/markdown/";
const PUT_CONCURRENCY = 20;

// OVERLAP LOCK (audit 2, F32). The cron and a hand-run POST /ops/backup are two
// entrypoints into the same destructive routine, and nothing stopped them running
// together: two concurrent runs each compute "stale" from their own read of
// documents and then delete against a mirror the other is still writing.
//
// The lease is a KV key, and KV has no compare-and-set, so this is best-effort
// mutual exclusion rather than a lock. It closes the window that actually exists
// here (a human posting /ops/backup near 09:00 UTC, or twice in a minute) and does
// NOT close a sub-millisecond simultaneous start. Said plainly because a lock that
// is described as stronger than it is becomes the reason nobody checks.
//
// The TTL exists so a crashed run cannot wedge backups forever: the finally-release
// does not run if the isolate dies. 15 minutes because that is the ceiling on a
// scheduled invocation's wall time, so no healthy run can outlive its own lease and
// be overtaken, and because it is far under the 24 hours to the next cron, so at
// most one scheduled run is ever lost to a crash. (KV's minimum expirationTtl is 60
// seconds, so the number also has a floor it must clear.)
const LEASE_KEY = "backup:lease";
const LEASE_TTL_SECONDS = 900;

// RETENTION ARITHMETIC. Read this before changing any number below, because the
// four of them are a single claim and they did not add up until 2026-08-13.
//
// The claim, as CLAUDE.md and this file both used to state it: "pruned rows always
// exist in a retained dump". The mechanism: the export runs FIRST and the prune
// runs after it, so a row deleted today is in today's dump. That much was true.
// What was missing is how long today's dump then lives. Dumps were kept 14 at a
// time, so a version row pruned at 90 days was recoverable from R2 for 14 more
// days and after that existed nowhere: not in D1, not in any dump. The horizons
// were compared against each other (90 versus 180) when the number that actually
// matters is the dump shelf life, which was 14.
//
// So the shelf life is what changed. Dumps are now pruned BY AGE at 90 days rather
// than by count, which makes the guarantee legible: a row that leaves D1 is in the
// dump taken moments earlier, and that dump is retained for 90 more days. It holds
// for BOTH history tables regardless of their own horizons, which is why one number
// can cover a 90-day table and a 180-day one.
//
// By age, not by count, deliberately. A count is only a duration if there is
// exactly one dump per day, and there is not: /ops/backup can be called by hand any
// number of times, and each call used to consume one of the 14 slots. Three manual
// runs in a day silently cut the window by three days, which is the kind of erosion
// nobody notices until they need the dump that is gone.
const JSON_RETENTION_DAYS = 90;
// A floor under the age rule, for the case the age rule cannot cover: if the cron
// stops and nothing runs for months, every dump is eventually older than the cutoff
// and an age-only rule would delete the last copies. The newest N always survive.
const JSON_MIN_KEPT = 14;
// Retention for the history tables. Both are covered by the dump shelf life above.
const VERSION_RETENTION_DAYS = 90;
const AUDIT_RETENTION_DAYS = 180;

// CSP and COOP violation reports (item 9's soak record). 30 days, ruled 2026-08-13.
// The trials are read for a promotion decision, and a decision reads recent
// evidence: an unbounded prefix on a public unauthenticated write path is a growth
// surface, not an archive. Nothing else prunes it, which is why the cron does.
const REPORT_RETENTION_DAYS = 30;

// Both prefixes carry an ISO date at a fixed offset (backups/json/YYYY-MM-DD..., and
// reports/csp/YYYY-MM-DD/...), so an age comparison is a string comparison and needs
// no date parsing. Keys that do not carry a parseable day are never pruned.
function isOlderThan(key: string, prefix: string, cutoffDay: string): boolean {
  const day = key.slice(prefix.length, prefix.length + 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < cutoffDay;
}

// RETENTION ACROSS PER-TABLE OBJECTS (audit 2, F33 light). A dump used to be one
// key. It is now one KEY PREFIX holding one object per table, and retention still
// operates on the dump, never on the object: keys are grouped by their run id (the
// path segment right after backups/json/), the newest JSON_MIN_KEPT RUNS are the
// floor, and an aged-out run is deleted whole. Counting objects instead would have
// silently cut the floor from 14 dumps to 2.8 of them.
//
// A run id begins with its own ISO day, which is why the age test below passes an
// empty prefix. Objects written before this change are flat keys with no slash;
// each one is its own single-object run and ages out on exactly the same rule, so
// no migration is needed and no old dump is stranded.
function runIdOf(key: string): string {
  const rest = key.slice(JSON_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function cutoffDay(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

// Every real table in the schema. Kept in sync with migrations/ by
// test/backup.test.ts, which fails if a migration adds a table that is missing
// here (document_links was added by 0002 and went unbacked-up until 2026-07-27).
// Deliberately excluded: documents_fts and its documents_fts_* shadow tables,
// which FTS5 derives from documents and the sync triggers rebuild on import,
// and sqlite_sequence, which SQLite maintains for AUTOINCREMENT.
export const TABLES = [
  "documents",
  "namespaces",
  "document_versions",
  "audit_log",
  "document_links",
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
  // Null on a healthy run. Otherwise the named reason NOTHING was deleted, which
  // is the field to read before believing a zero in any of the *_pruned counters.
  prune_refused: string | null;
  preflight: { documents: number; fts: string };
}

// A run that did not run. Named rather than thrown, so the caller can tell "another
// run holds the lease" apart from "the backup failed".
export interface BackupSkipped {
  ran: false;
  skipped: string;
}

export type BackupResult = BackupSummary | BackupSkipped;

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
    // Release on the way out, success or throw, so the TTL only ever has to cover
    // an isolate that died mid-run.
    await env.APP_KV.delete(LEASE_KEY);
  }
}

async function exportAndPrune(env: Env, now: string): Promise<BackupSummary> {
  // One object per table under a per-run prefix. The dump is the prefix; see the
  // retention note on runIdOf above for how ageing works now that it is not one key.
  const jsonPrefix = `${JSON_PREFIX}${now.replace(/[:.]/g, "-")}/`;
  const jsonKeys: string[] = [];
  let docs: Array<{ namespace: string; path: string; body: string | null }> = [];
  for (const table of TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    if (table === "documents") docs = results as typeof docs;
    const key = `${jsonPrefix}${table}.json`;
    await env.MEDIA.put(key, JSON.stringify({ exported_at: now, table, rows: results }), {
      httpMetadata: { contentType: "application/json" },
    });
    jsonKeys.push(key);
  }

  // PREFLIGHT BEFORE ANYTHING DESTRUCTIVE (audit 2, F16).
  //
  // The dangerous case is a SELECT that SUCCEEDS AND RETURNS NOTHING, not one that
  // throws. An empty documents table, or a DB binding resolved by name to an empty
  // or rebound database, makes currentKeys empty, which makes every single object
  // under backups/markdown/ "stale", and the mirror is deleted in one call. The
  // mirror is the last human-readable copy, so that is the whole backup story lost
  // to a read the run had no reason to trust.
  //
  // Two probes. A count floor (greater than zero, not a guess at a plausible size)
  // and the SAME pinned FTS probe /health uses, which is what catches a binding
  // pointed at a different database that happens to have rows.
  //
  // WHAT A FAILURE STOPS, and it is deliberately more than F16 asked for: the JSON
  // dumps are already written above and are kept, because an export deletes nothing
  // and an empty dump is itself the evidence of the day the store looked empty.
  // Everything after this point is refused as a unit, including the markdown WRITE,
  // the three R2 prunes and the two D1 deletes. Not just the markdown prune: a run
  // that cannot trust its read of documents cannot trust content derived from that
  // read either (a rebound DB would overwrite good mirror bodies with foreign ones),
  // and the D1 deletes target the same suspect database. A partially executed run is
  // also harder to reason about afterwards than a wholly refused one. The cost of
  // refusing is storage and a stale mirror until someone looks; the cost of guessing
  // wrong in the other direction is the backup.
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
  if (staleMarkdown.length > 0) await env.MEDIA.delete(staleMarkdown);

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
  if (staleDumpKeys.length > 0) await env.MEDIA.delete(staleDumpKeys);

  const reportCutoff = cutoffDay(new Date(now), REPORT_RETENTION_DAYS);
  const staleReports = (await listAllKeys(env.MEDIA, REPORT_PREFIX)).filter((key) =>
    isOlderThan(key, REPORT_PREFIX, reportCutoff)
  );
  if (staleReports.length > 0) await env.MEDIA.delete(staleReports);

  // Prune history AFTER the export above, so the rows leaving D1 are in today's dump.
  //
  // COUNTED, NOT REPORTED (audit 2, F37). meta.changes is inflated by the FTS5
  // triggers and cannot be used to say what a statement did here, so each DELETE is
  // preceded by a COUNT over the identical predicate. Both pairs go in one batch,
  // which is one transaction executed in order, so the count is of exactly the rows
  // the next statement removes.
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
  ]);

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
