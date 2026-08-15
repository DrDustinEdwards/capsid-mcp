// THE PINNED FTS PROBE. One definition, two callers: /health reports it, and the
// backup preflight refuses to delete anything when it fails.
//
// It lives here rather than in either caller because the two must agree. A backup
// that trusted a probe of its own would eventually drift from the probe the gate
// family asserts, and the drift would only show up on the day the store was
// actually broken, which is the day neither of them can afford to be wrong.
//
// Why a MATCH pinned to one document rather than a count: DELETE FROM documents_fts
// corrupts the index, COUNT(*) on an external-content FTS5 table reads through to
// the content table so it cannot detect drift, and integrity-check passes on an
// emptied index (all three measured 2026-07-27). A MATCH that has to find a
// specific row is the only cheap check that fails when the index is empty.
export const HEALTH_PROBE_NS = "capsid";
export const HEALTH_PROBE_PATH = "conventions.md";
export const HEALTH_PROBE_TERM = "conventions";

// Returns "ok", or a short reason. Never throws: a caller deciding whether to
// delete needs an answer, not an exception to forget to catch.
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
