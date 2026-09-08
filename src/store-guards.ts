// THE D1 WRITE-INTEGRITY CORE: the statements and the commit protocol that make
// every overwrite, create and path mutation abort inside its own transaction
// rather than report a success it did not achieve. Tool registration stays in
// server.ts; this is only the mechanism, imported back by it.

import { sha256Hex } from "./auth";

// A statement that ABORTS the batch it is in unless (namespace, path) names an
// existing document, and writes nothing when it does.
//
// A STATEMENT rather than an `if`, because the pre-read is a different
// transaction from the batch and the row can go between them: move answered
// "moved" and delete answered "deleted" over documents that were not there.
// meta.changes cannot catch it either, since the FTS5 triggers on `documents`
// inflate it (measured 2026-08-10: one repointed edge reported as five).
//
// The mechanism, since SQLite has no RAISE outside a trigger body: attempt an
// INSERT that violates NOT NULL, guarded by NOT EXISTS so it is attempted only
// when the document is missing. It never actually inserts a row.
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

// True when the batch failed because a requireExists guard fired, rather than for
// the reason the caller's catch block would otherwise assume (a UNIQUE collision
// on the move target).
export function isMissingRowAbort(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(GUARD_VIOLATION);
}

// THE WRITE PREDICATE. if_match used to be a pre-read: select, hash, compare,
// then run an unguarded batch. The window between the compare and the commit is
// not theoretical, because a large replace elicits a confirmation first and the
// gap can be the full 90 second timeout. The expectation now lives INSIDE the
// batch, by the same mechanism and for the same reason as requireExists.
//
// BODY EQUALITY RATHER THAN A STORED SHA COLUMN, deliberately. A hash column is
// a second source of truth for something the row already contains, has to be
// recomputed correctly by every future write path, and leaves the guard
// comparing a stale hash while looking green when one forgets. Comparing the
// body needs no migration and cannot drift from what it describes.
//
// `IS` rather than `=` because a NULL body is a legitimate stored value and
// `body = NULL` is never true, which would make the guard fire forever on it.
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

// The create-path half. Fires when the row DOES exist, so a create that raced
// another create aborts instead of falling into the ON CONFLICT branch and
// overwriting a body that was never snapshotted, because the snapshot statement
// is only added when the pre-read saw a row.
function requireMissing(db: D1Database, namespace: string, path: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, ?2
       WHERE EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path = ?2)`
    )
    .bind(namespace, path);
}

// All three guards abort with the same NOT NULL violation, so the caller cannot
// tell them apart from the message and must know which one it armed. Each write
// site arms exactly one.
type WriteGuard = "none" | "body" | "missing";

// THE COMMIT PROTOCOL, in one place. write and restore perform the same four
// steps and the ORDER is the whole point:
//
//   1. pre-check if_match BEFORE any elicitation, so a caller holding an
//      obviously stale sha is refused immediately rather than after 90 seconds;
//   2. arm exactly one guard: absence for a create, unchanged-body for an update
//      the caller asked to be checked or a human confirmed;
//   3. run the batch with that guard FIRST, so nothing is half-written;
//   4. map the abort back to the guard that was armed, since all three fail with
//      the identical NOT NULL violation and the error cannot say which.
//
// It was written out twice and the copies had drifted on step 2's consent
// condition. `guard` is unreachable from the handlers now, so arming and
// interpreting cannot disagree about what was armed.
//
// An unguarded update keeps last-writer-wins on purpose: requiring if_match
// everywhere would refuse every legitimate rapid edit, and break append.
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
    // Step 1. A fast refusal that costs no statement. The AUTHORITY is the
    // in-batch predicate below, not this: everything can change between the two.
    async precheckIfMatch(): Promise<string | null> {
      if (if_match === undefined) return null;
      if (!prior) return refusals.ifMatchOnMissing;
      const currentSha = await sha256Hex(prior.body ?? "");
      const passed = if_match.trim().toLowerCase();
      return currentSha === passed ? null : refusals.ifMatchMismatch(currentSha, passed);
    },
    // Steps 2 to 4. Returns null when the batch committed, or the refusal to
    // hand back. `elicited` is requireConfirmation's own report of whether a
    // human actually answered a prompt, so both callers key off one signal.
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
        // Every batch failure returns a clean refusal. This used to rethrow
        // anything that was not a guard abort, so the same class of failure had
        // two shapes depending on which tool the caller had called.
        if (!isMissingRowAbort(err)) {
          return refusals.batchFailed(err instanceof Error ? err.message : String(err));
        }
        if (guard === "missing") return refusals.createCollision;
        // guard === "body". Report the sha that is stored NOW so the caller can
        // rebase without a second round trip to find out what it lost to.
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
