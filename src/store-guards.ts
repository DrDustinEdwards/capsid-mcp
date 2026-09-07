// THE D1 WRITE-INTEGRITY CORE, extracted from server.ts on 2026-09-07 (audit
// MAJOR 17). These are the statements and the commit protocol that make every
// overwrite, create and path mutation abort inside its own transaction rather
// than reporting a success it did not achieve. They lived beside the tool
// registrations, which is the one file a tool must be added to and the one file
// the invariant scanners read; keeping the guards there tied the store's
// integrity core to the registration surface for no reason. Tool registration
// stays in server.ts; this is only the mechanism, imported back by it.
//
// The source-guard walk is recursive as of the same day, so a scanner that reads
// through test/source-files.ts sees this module without any change to it.

import { sha256Hex } from "./auth";

// A statement that ABORTS the batch it is in unless (namespace, path) names an
// existing document. It writes nothing when the document is there.
//
// Why a statement and not an `if`: every path-mutating tool already reads the row
// first, and that read is a different transaction from the batch that follows it.
// Between the two, the row can go. What the tools then reported was a success:
// the batch ran, zero rows matched, `move` answered "moved" and `delete` answered
// "deleted" over a document that was not there. D1's meta.changes cannot be used
// to catch it either, because `documents` carries FTS5 sync triggers whose row
// changes accumulate across a batch (measured 2026-08-10: one repointed edge
// reported as five). So the check has to be INSIDE the transaction, and it has to
// be a statement rather than a number read back afterwards.
//
// The mechanism, since SQLite has no RAISE outside a trigger body: attempt an
// INSERT that violates NOT NULL, guarded by NOT EXISTS so it is attempted only
// when the document is missing. Present, and the SELECT yields no rows and
// nothing is inserted. Missing, and it tries to write NULL into
// document_versions.document_id, which fails the constraint and rolls the whole
// batch back. document_versions is the target because it carries no triggers and
// is already in this file's vocabulary; the guard never inserts a row into it.
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

// THE WRITE PREDICATE (audit 2 finding F12/F13/F14, 2026-08-17).
//
// Before this, if_match was a PRE-READ: select the body, hash it, compare, then
// run an unguarded batch. Everything between the compare and the commit was
// unprotected, and the window is not theoretical: mode 'replace' over a large
// document elicits a confirmation first, so the gap could be the full 90 second
// elicitation timeout. A writer that landed inside that window was overwritten
// with a clean success and no signal, which is the precise failure if_match
// exists to prevent.
//
// So the expectation moves INSIDE the batch, using the same mechanism
// requireExists uses and for the same reason: SQLite has no RAISE outside a
// trigger body, D1's meta.changes is inflated by the FTS5 triggers on
// `documents` and cannot be used to count what a batch did, so the check has to
// be a STATEMENT that aborts the transaction rather than a number read back
// afterwards.
//
// WHY BODY EQUALITY RATHER THAN A STORED SHA COLUMN. The obvious alternative is
// a `body_sha` column compared in the WHERE clause. It was not taken: a hash
// column is a second source of truth for something the row already contains, it
// has to be recomputed correctly by every present and future write path, and a
// path that forgets leaves the guard comparing a stale hash while looking
// green. That is the mirrored-state defect class this repo already guards
// against elsewhere. Comparing the body itself needs no migration, cannot drift
// from the thing it describes, and is strictly stronger than comparing a digest
// of it. The caller still speaks sha256, which is what it already holds; the
// server resolves that to the body it read and asserts THAT body is still
// there.
//
// `IS` rather than `=` because a NULL body is a legitimate stored value and
// `body = NULL` is never true in SQL, which would make the guard fire forever
// on any document with a null body.
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

// THE COMMIT PROTOCOL, in one place.
//
// write and restore perform the same four steps, and the ORDER is the whole point:
//
//   1. pre-check if_match, BEFORE any elicitation, so a caller holding an
//      obviously stale sha is refused immediately instead of being made to sit
//      through a 90 second prompt for a write that was never going to land;
//   2. arm exactly one guard, chosen from the same pre-read the caller already
//      has: absence for a create, unchanged-body for an update the caller asked
//      to be checked (if_match) or a human confirmed (elicited);
//   3. run the batch with that guard FIRST, so the transaction aborts before any
//      other statement is attempted and nothing is half-written;
//   4. map the abort back to the guard that was armed, since all three guards
//      fail with the identical NOT NULL violation and the error cannot say which.
//
// It was written out twice, and the copies had drifted: they spelled step 2's
// consent condition differently (`elicited` against `confirm !== true`), which
// happened to denote the same thing only because of how requireConfirmation
// returns. Step 4 is the reason the flag from step 2 must not be a separate
// variable a caller can forget to set: `guard` is now unreachable from the
// handlers, so arming and interpreting cannot disagree about what was armed.
//
// An unguarded update keeps its last-writer-wins behaviour on purpose. Requiring
// if_match everywhere would refuse every legitimate rapid edit, and would break
// append, which is safe by construction.
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
        // Every batch failure returns a clean refusal (audit 2, F30). This used to
        // rethrow anything that was not a guard abort, so a D1 error escaped the
        // handler as an exception while delete, move and finalize all answered
        // with fail(). Same class of failure, two different shapes, and the
        // caller had to know which tool it called to know what to expect.
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
