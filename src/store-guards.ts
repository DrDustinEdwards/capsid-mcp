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
