import { sha256Hex } from "./auth";

// INSERT that violates NOT NULL, guarded by NOT EXISTS, so a missing row aborts
// the batch. A pre-read is a different transaction. meta.changes is inflated by
// FTS5 triggers and cannot count what a batch did.
const GUARD_VIOLATION = "document_versions.document_id";
export function requireExists(db: D1Database, namespace: string, path: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, ?2
       WHERE NOT EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path = ?2)`
    )
    .bind(namespace, path);
}

export function isMissingRowAbort(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(GUARD_VIOLATION);
}

// Body equality rather than a stored sha column. `IS` rather than `=` because a
// NULL body is legitimate and `body = NULL` is never true.
export function requireBodyUnchanged(
  db: D1Database,
  namespace: string,
  path: string,
  expectedBody: string | null
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, ?2
       WHERE NOT EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path = ?2 AND body IS ?3)`
    )
    .bind(namespace, path, expectedBody);
}

function requireMissing(db: D1Database, namespace: string, path: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, ?2
       WHERE EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path = ?2)`
    )
    .bind(namespace, path);
}

type WriteGuard = "none" | "body" | "missing";

type CommitRefusals = {
  ifMatchOnMissing: string;
  ifMatchMismatch: (currentSha: string, passed: string) => string;
  createCollision: string;
  deletedInFlight: string;
  bodyChanged: (currentSha: string, elicited: boolean) => string;
  batchFailed: (reason: string) => string;
};

export function guardedCommit(opts: {
  db: D1Database;
  namespace: string;
  path: string;
  prior: { body: string | null } | null;
  if_match: string | undefined;
  refusals: CommitRefusals;
}) {
  const { db, namespace, path, prior, if_match, refusals } = opts;
  return {
    async precheckIfMatch(): Promise<string | null> {
      if (if_match === undefined) return null;
      if (!prior) return refusals.ifMatchOnMissing;
      const currentSha = await sha256Hex(prior.body ?? "");
      const passed = if_match.trim().toLowerCase();
      return currentSha === passed ? null : refusals.ifMatchMismatch(currentSha, passed);
    },
    async run(elicited: boolean, statements: D1PreparedStatement[]): Promise<string | null> {
      let guard: WriteGuard = "none";
      const armed: D1PreparedStatement[] = [];
      if (!prior) {
        guard = "missing";
        armed.push(requireMissing(db, namespace, path));
      } else if (if_match !== undefined || elicited) {
        guard = "body";
        armed.push(requireBodyUnchanged(db, namespace, path, prior.body));
      }
      try {
        await db.batch([...armed, ...statements]);
        return null;
      } catch (err) {
        if (!isMissingRowAbort(err)) {
          return refusals.batchFailed(err instanceof Error ? err.message : String(err));
        }
        if (guard === "missing") return refusals.createCollision;
        const current = await db
          .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path)
          .first<{ body: string | null }>();
        if (!current) return refusals.deletedInFlight;
        return refusals.bodyChanged(await sha256Hex(current.body ?? ""), elicited);
      }
    },
  };
}

// THE DOCUMENT UPSERT, ONE SPELLING. `write` and `lint` mode `report` both store a
// document and both have to store it the same way, or two write paths disagree about
// what a write is. The split of 2026-09-10 put them in different files, which is
// where a second spelling comes from.
//
// COALESCE on every optional column, so an argument the caller did not supply leaves
// the stored value alone rather than nulling it. The improve loop's own writer is
// deliberately NOT folded in here: it always sets every column and has no COALESCE.
//
// test/mutation-guard-coverage.test.ts and test/tool-annotations.test.ts both match
// this call as a mutation marker, the same way they match pathMutation().
export function documentUpsert(
  db: D1Database,
  namespace: string,
  path: string,
  title: string | null,
  body: string,
  type: string | null,
  tags: string | null,
  status: string | null
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO documents (namespace, path, title, body, type, tags, status)
       VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'note'), ?6, COALESCE(?7, 'published'))
       ON CONFLICT(namespace, path) DO UPDATE SET
         title = COALESCE(?3, documents.title),
         body = excluded.body,
         type = COALESCE(?5, documents.type),
         tags = COALESCE(?6, documents.tags),
         status = COALESCE(?7, documents.status),
         updated_at = datetime('now')`
    )
    .bind(namespace, path, title, body, type, tags, status);
}
