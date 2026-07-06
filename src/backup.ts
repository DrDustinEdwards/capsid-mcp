import type { Env } from "./server";

const JSON_PREFIX = "backups/json/";
const MARKDOWN_PREFIX = "backups/markdown/";
const KEEP_JSON_BACKUPS = 14;
const PUT_CONCURRENCY = 20;

const TABLES = ["documents", "namespaces", "document_versions", "audit_log"] as const;

export interface BackupSummary {
  json_key: string;
  documents: number;
  markdown_written: number;
  markdown_pruned: number;
  json_backups_kept: number;
  json_backups_pruned: number;
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

  return {
    json_key: jsonKey,
    documents: docs.length,
    markdown_written: docs.length,
    markdown_pruned: staleMarkdown.length,
    json_backups_kept: dumps.length - staleDumps.length,
    json_backups_pruned: staleDumps.length,
  };
}
