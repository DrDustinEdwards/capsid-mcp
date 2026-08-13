import type { Env } from "./server";

const JSON_PREFIX = "backups/json/";
const MARKDOWN_PREFIX = "backups/markdown/";
const PUT_CONCURRENCY = 20;

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
const REPORT_PREFIX = "reports/csp/";
const REPORT_RETENTION_DAYS = 30;

// Both prefixes carry an ISO date at a fixed offset (backups/json/YYYY-MM-DD..., and
// reports/csp/YYYY-MM-DD/...), so an age comparison is a string comparison and needs
// no date parsing. Keys that do not carry a parseable day are never pruned.
function isOlderThan(key: string, prefix: string, cutoffDay: string): boolean {
  const day = key.slice(prefix.length, prefix.length + 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < cutoffDay;
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
  json_key: string;
  documents: number;
  markdown_written: number;
  markdown_pruned: number;
  json_backups_kept: number;
  json_backups_pruned: number;
  reports_pruned: number;
  versions_pruned: number;
  audit_pruned: number;
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

export async function runBackup(env: Env): Promise<BackupSummary> {
  const now = new Date().toISOString();
  const tables: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    tables[table] = results;
  }

  const jsonKey = `${JSON_PREFIX}${now.replace(/[:.]/g, "-")}.json`;
  await env.MEDIA.put(jsonKey, JSON.stringify({ exported_at: now, tables }), {
    httpMetadata: { contentType: "application/json" },
  });

  const docs = tables.documents as Array<{ namespace: string; path: string; body: string | null }>;
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

  // Newest first, so the floor is the head of the list.
  const dumps = (await listAllKeys(env.MEDIA, JSON_PREFIX)).sort().reverse();
  const dumpCutoff = cutoffDay(new Date(now), JSON_RETENTION_DAYS);
  const staleDumps = dumps.slice(JSON_MIN_KEPT).filter((key) => isOlderThan(key, JSON_PREFIX, dumpCutoff));
  if (staleDumps.length > 0) await env.MEDIA.delete(staleDumps);

  const reportCutoff = cutoffDay(new Date(now), REPORT_RETENTION_DAYS);
  const staleReports = (await listAllKeys(env.MEDIA, REPORT_PREFIX)).filter((key) =>
    isOlderThan(key, REPORT_PREFIX, reportCutoff)
  );
  if (staleReports.length > 0) await env.MEDIA.delete(staleReports);

  // Prune history AFTER the export above, so the rows leaving D1 are in today's dump.
  const [prunedVersions, prunedAudit] = await env.DB.batch([
    env.DB.prepare("DELETE FROM document_versions WHERE snapshot_at < datetime('now', ?1)").bind(
      `-${VERSION_RETENTION_DAYS} days`
    ),
    env.DB.prepare("DELETE FROM audit_log WHERE at < datetime('now', ?1)").bind(`-${AUDIT_RETENTION_DAYS} days`),
  ]);

  return {
    json_key: jsonKey,
    documents: docs.length,
    markdown_written: docs.length,
    markdown_pruned: staleMarkdown.length,
    json_backups_kept: dumps.length - staleDumps.length,
    json_backups_pruned: staleDumps.length,
    reports_pruned: staleReports.length,
    versions_pruned: prunedVersions.meta.changes ?? 0,
    audit_pruned: prunedAudit.meta.changes ?? 0,
  };
}
