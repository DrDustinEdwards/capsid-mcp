// One MATCH probe, used by /health and by backup preflight. COUNT(*) on an
// external-content FTS5 table reads through to documents and cannot see a
// corrupted index; integrity-check passes on an emptied one.
export const HEALTH_PROBE_NS = "capsid";
export const HEALTH_PROBE_PATH = "conventions.md";
export const HEALTH_PROBE_TERM = "conventions";

// Returns "ok", or a short reason. Never throws.
export async function probeFts(db: D1Database): Promise<string> {
  try {
    const hit = await db
      .prepare(
        `SELECT d.path FROM documents_fts
         JOIN documents d ON d.id = documents_fts.rowid
         WHERE documents_fts MATCH ?1 AND d.namespace = ?2 AND d.path = ?3
         LIMIT 1`
      )
      .bind(HEALTH_PROBE_TERM, HEALTH_PROBE_NS, HEALTH_PROBE_PATH)
      .first<{ path: string }>();
    return hit?.path === HEALTH_PROBE_PATH ? "ok" : `no match for ${HEALTH_PROBE_NS}/${HEALTH_PROBE_PATH}`;
  } catch (err) {
    return `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
  }
}
