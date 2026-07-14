import type { Env } from "./server";

const JSON_PREFIX = "backups/json/";
const MARKDOWN_PREFIX = "backups/markdown/";
const KEEP_JSON_BACKUPS = 14;
const PUT_CONCURRENCY = 20;
// Retention for the history tables, pruned after each export so every pruned
// row still exists in at least one JSON dump (and in D1 Time Travel).
const VERSION_RETENTION_DAYS = 90;
const AUDIT_RETENTION_DAYS = 180;

const TABLES = ["documents", "namespaces", "document_versions", "audit_log"] as const;

export interface BackupSummary {
  json_key: string;
  documents: number;
  markdown_written: number;
  markdown_pruned: number;
  json_backups_kept: number;
  json_backups_pruned: number;
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

  const dumps = (await listAllKeys(env.MEDIA, JSON_PREFIX)).sort().reverse();
  const staleDumps = dumps.slice(KEEP_JSON_BACKUPS);
  if (staleDumps.length > 0) await env.MEDIA.delete(staleDumps);

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
    versions_pruned: prunedVersions.meta.changes ?? 0,
    audit_pruned: prunedAudit.meta.changes ?? 0,
  };
}
