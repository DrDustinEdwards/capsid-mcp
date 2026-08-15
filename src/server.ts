import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env, Props } from "./env";
import {
  ciStatus,
  createBranch,
  deleteRepoFile,
  listRepoTree,
  managePr,
  openPr,
  parseReposList,
  readRepoFile,
  REPO_SHAPE,
  requireSinglePrimary,
  searchCode,
  writeRepoFile,
} from "./github";
import { sha256Hex } from "./auth";
import { normalizeDashes } from "./normalize";
import { parseLinks } from "./links";
import { validateDocStatus, validateDocType } from "./doc-meta";
import { authoritativeFor, scanCountClaims } from "./counts";
import { bounded, docPath, MAX_BODY, MAX_COMMIT_MESSAGE, MAX_DOC_TYPE, MAX_GLOB, MAX_LINKS_JSON, MAX_PATH, MAX_PR_BODY, MAX_PR_TITLE, MAX_QUERY, MAX_REF, MAX_REPO_SELECTOR, MAX_REPOS_JSON, MAX_SHA, MAX_TAGS, MAX_TITLE, nsName } from "./limits";
import { assembleBody } from "./write-modes";

const SERVER_INFO = { name: "capsid", version: "1.0.0" };

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const DENIED = "unauthorized: this tool requires a write-grant operator key; read-only (ro:) keys can only use the read tools";

// PATH_MUTATION_HELPER_START
// The ONLY place in this worker that mutates documents.path or removes a
// documents row. Every such operation drags document_links with it, because
// document_links stores (ns, path) strings rather than documents.id and the
// table carries no foreign key, so nothing at the database level keeps them in
// step. test/path-mutation.test.ts asserts this helper stays the only site.
//
// It exists because the same defect shipped three times: delete removed the row
// and orphaned every edge touching it, move renamed the document and left its
// edges on the old path, and lint finalize archived with an inline
// "UPDATE ... SET path = 'archive/' || path" that was a move by another name.
// All three are now callers.
//
// newPath null means delete. Otherwise the document is renamed to newPath and
// edges are repointed on both sides.
//
// Statement order is part of the contract, because callers read counts off the
// batch results positionally:
//   rename: [0] documents, [1] document_links.from_path, [2] document_links.to_path
//   delete: [0] document_links (both directions), [1] documents
function pathMutation(
  db: D1Database,
  namespace: string,
  path: string,
  newPath: string | null
): D1PreparedStatement[] {
  if (newPath === null) {
    return [
      db
        .prepare(
          "DELETE FROM document_links WHERE (from_ns = ?1 AND from_path = ?2) OR (to_ns = ?1 AND to_path = ?2)"
        )
        .bind(namespace, path),
      db.prepare("DELETE FROM documents WHERE namespace = ?1 AND path = ?2").bind(namespace, path),
    ];
  }
  return [
    db
      .prepare("UPDATE documents SET path = ?3, updated_at = datetime('now') WHERE namespace = ?1 AND path = ?2")
      .bind(namespace, path, newPath),
    db
      .prepare("UPDATE document_links SET from_path = ?3 WHERE from_ns = ?1 AND from_path = ?2")
      .bind(namespace, path, newPath),
    db
      .prepare("UPDATE document_links SET to_path = ?3 WHERE to_ns = ?1 AND to_path = ?2")
      .bind(namespace, path, newPath),
  ];
}

// Edges touching a document, read before a mutation so the caller can record
// them. document_versions snapshots only title and body, so for a delete this
// is the only place the edges survive.
function edgesTouching(db: D1Database, namespace: string, path: string): D1PreparedStatement {
  return db
    .prepare(
      "SELECT from_ns, from_path, type, to_ns, to_path FROM document_links WHERE (from_ns = ?1 AND from_path = ?2) OR (to_ns = ?1 AND to_path = ?2)"
    )
    .bind(namespace, path);
}
// PATH_MUTATION_HELPER_END

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
function requireExists(db: D1Database, namespace: string, path: string): D1PreparedStatement {
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
function isMissingRowAbort(err: unknown): boolean {
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
function requireBodyUnchanged(
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

function guardedCommit(opts: {
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

// Documents may only be written to a namespace that has a `namespaces` row.
//
// Writing to a namespace label does not create it, so a typo in `namespace` used
// to open a shadow namespace: documents that `namespaces` cannot see, that the
// unconsolidated counter never counts, that no repo tool can resolve, and that
// `brief` will not assemble because there is no core.md and never will be. It is
// invisible by construction, which is the whole failure mode. Measured
// 2026-08-13 before this landed: zero ghost namespaces live, so this closes the
// hole rather than cleaning one up.
//
// register_namespace stays the only way to create one, deliberately: a namespace
// is a repo mapping and an authorization boundary, not a string a write can coin.
async function requireRegisteredNamespace(db: D1Database, namespace: string): Promise<string | null> {
  const row = await db.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(namespace).first();
  if (row) return null;
  return (
    `unknown namespace '${namespace}'. Nothing was written. Documents can only live in a registered namespace, ` +
    `because an unregistered one is invisible to the namespaces list, the lint loop and every repo tool. ` +
    `Check the spelling against the namespaces tool, or create it with register_namespace.`
  );
}

// A write that overwrites a document touched in the last hour, WITHOUT if_match, gets
// a warning on the response. It is never refused.
//
// MOTIVATING INCIDENT, 2026-08-14: dustinedwards/core.md. One session patched it at
// 13:29 and a second session rewrote it at 14:13 from a body it had read earlier,
// dropping 2,253 bytes of consolidation work. The prior body survives only because
// every overwrite snapshots (document_versions 1142). Nothing anywhere said anything
// was wrong: the write succeeded, the response was clean, and the loss was found days
// later by someone re-reading the document for an unrelated reason.
//
// if_match already prevents this, and it could not have prevented THAT: it is opt-in,
// so it protects only the caller who passes it, and the overwriting client's cached
// tool schema predated the parameter entirely. A warning reaches the client that did
// not know to ask.
//
// WARN, NEVER REFUSE, and the asymmetry is deliberate. Refusing would break every
// legitimate rapid edit, and the common case for two writes inside an hour is one
// agent working. The warning costs a caller nothing and tells the one who is about to
// lose someone else's work that there is someone else.
const CONCURRENT_EDIT_WINDOW_MS = 60 * 60 * 1000;

export function concurrentEditWarning(updatedAt: string | null | undefined, now: number): string | null {
  if (!updatedAt) return null;
  // D1 stores datetime('now') as "YYYY-MM-DD HH:MM:SS" in UTC, which Date.parse reads
  // as LOCAL time unless the zone is made explicit. Getting that wrong would silence
  // the warning on a machine behind UTC and fire it constantly on one ahead.
  const parsed = Date.parse(`${updatedAt.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed)) return null;
  const age = now - parsed;
  if (age < 0 || age > CONCURRENT_EDIT_WINDOW_MS) return null;
  return (
    `possible concurrent edit: this document was last written at ${updatedAt} UTC, within the last hour, and no if_match was passed. ` +
    `The write went through and the prior body was snapshotted to document_versions, so nothing is lost, but if another session is working on this document your write may have just replaced its changes. ` +
    `Pass if_match (the sha256 this response returns) on the next write to make that a refusal instead of a warning.`
  );
}

type ConfirmVerdict = "accepted" | "declined" | "unsupported";

// Asks the connected client to confirm a destructive action via MCP elicitation.
// Stateless Streamable HTTP clients usually cannot answer server-initiated
// requests, so "unsupported" is the common case and callers must fall back to
// requiring an explicit confirm:true argument.
async function confirmDestructive(server: McpServer, message: string): Promise<ConfirmVerdict> {
  if (!server.server.getClientCapabilities()?.elicitation) return "unsupported";
  try {
    const result = await server.server.elicitInput(
      {
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", title: "Confirm", description: "Set to true to proceed" },
          },
          required: ["confirm"],
        },
      },
      { timeout: 90_000 }
    );
    return result.action === "accept" && result.content?.confirm === true ? "accepted" : "declined";
  } catch {
    return "unsupported";
  }
}

// THE CONFIRMATION BLOCK, ONCE (audit 2, F25). Four call sites wrote the same
// three-branch dance (accepted, declined, unsupported) around confirmDestructive,
// and each carried its own wording for the two refusals, so "is this tool
// confirmed?" could only be answered by reading four places. Returns a caller
// facing error string, or null to proceed.
//
// The messages stay per tool because they are the instruction the caller acts on:
// a generic "confirmation required" does not say which argument to add or what
// will happen when they do.
//
// IT REPORTS WHETHER IT ACTUALLY ELICITED, and that signal is load-bearing rather
// than informational (quality audit 4.1). A human who sat through an elicitation
// said "overwrite THIS" about a body that was read before the prompt went out, and
// the answer can arrive up to 90 seconds later, so that consent is about a
// specific body and goes stale exactly like an if_match does. Both write and
// restore arm the commit-time body guard on it.
//
// Before this returned it, the two paths inferred it separately: write kept its own
// `elicited` flag, restore re-derived it as `confirm !== true`. Those coincide
// today only because restore always calls this helper and this helper returns
// early when confirm is true. A change here, such as treating confirm:true after a
// successful elicitation, would have armed one path and not the other, silently.
type ConfirmResult = { ok: true; elicited: boolean } | { ok: false; message: string };

async function requireConfirmation(
  server: McpServer,
  confirm: boolean | undefined,
  messages: { prompt: string; declined: string; unsupported: string }
): Promise<ConfirmResult> {
  if (confirm === true) return { ok: true, elicited: false };
  const verdict = await confirmDestructive(server, messages.prompt);
  if (verdict === "accepted") return { ok: true, elicited: true };
  return { ok: false, message: verdict === "declined" ? messages.declined : messages.unsupported };
}

// `actor` is the principal that will be recorded on every audit_log row this
// server writes. It replaces a hardcoded 'operator' string that every one of the
// eight audit write sites used, which meant the column answered "what happened"
// and never "who did it". Establishing who deleted three parity documents on
// 2026-08-10 took the Workers Observability 7-day window plus prose in two
// session docs, because the audit log itself could not say.
//
// Shape: "github:<login>" for an OAuth session on /mcp, "opkey:<fingerprint>"
// for an operator key on /ops/mcp, where the fingerprint is a 12-char prefix of
// the key's sha256 and not the key. The 1,631 rows written before 2026-08-11
// keep their literal 'operator' value; there is no backfill, because inventing
// an attribution for them would be worse than an honest unknown.
export function buildServer(env: Env, operator: boolean, actor: string): McpServer {
  const server = new McpServer(SERVER_INFO);
  const db = env.DB;

  server.registerTool(
    "list",
    {
      description: "List documents with optional namespace, type, and status filters. Returns metadata rows without bodies: id, namespace, path, title, type, status, tags and timestamps.",
      inputSchema: {
        namespace: nsName.optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
        status: bounded(MAX_DOC_TYPE).optional(),
      },
    },
    async ({ namespace, type, status }) => {
      const { results } = await db
        .prepare(
          // frontmatter and publish_at are NOT selected. Both are columns from the
          // original CMS-shaped schema that nothing in this server reads or writes.
          // Measured 2026-08-13, not assumed: both are NULL on all 494 documents.
          // Listing publish_at advertised a scheduling feature that does not exist
          // and put a permanently empty field in front of every caller.
          // Ruled 2026-08-13: dropped from the output, LEFT IN THE TABLE. Removing
          // a column means a migration, a rebuild of the FTS triggers and a change
          // to the backup table guard, to reclaim nothing.
          `SELECT id, namespace, path, title, type, status, tags, created_at, updated_at
           FROM documents
           WHERE (?1 IS NULL OR namespace = ?1) AND (?2 IS NULL OR type = ?2) AND (?3 IS NULL OR status = ?3)
           ORDER BY namespace, path`
        )
        .bind(namespace ?? null, type ?? null, status ?? null)
        .all();
      return ok(results);
    }
  );

  server.registerTool(
    "read",
    {
      description: "Read a full document by namespace and path.",
      inputSchema: { namespace: nsName, path: docPath },
    },
    async ({ namespace, path }) => {
      const row = await db
        .prepare("SELECT * FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first();
      return row ? ok(row) : fail(`not found: ${namespace}/${path}`);
    }
  );

  // One-call session start: assembles the read ritual so a session cannot skip a
  // piece of it (a skipped core.md caused a real status misread). Pure assembly,
  // no reasoning. Size-bounded so it stays loadable; when trimmed it says so.
  server.registerTool(
    "brief",
    {
      description:
        "One-call session start for a namespace. Returns capsid/conventions.md, capsid/repo-structure.md, the namespace core.md, its open task docs (non-archived and not status closed), the 3 most recent episodics, and the typed edges on core.md, each with updated_at so staleness shows. Read-only assembly, no reasoning. Size-bounded near 40KB; if trimmed, the `trimmed` field lists what was dropped to metadata. Doing the start-ritual reads by hand stays a valid fallback.",
      inputSchema: { namespace: nsName },
    },
    async ({ namespace }) => {
      const BUDGET = 40_000;
      const doc = (ns: string, path: string) =>
        db
          .prepare("SELECT namespace, path, title, type, body, updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(ns, path)
          .first<{ namespace: string; path: string; title: string | null; type: string | null; body: string | null; updated_at: string }>();
      const [conventions, repoStructure, core] = await Promise.all([
        doc("capsid", "conventions.md"),
        doc("capsid", "repo-structure.md"),
        doc(namespace, "core.md"),
      ]);
      // Not filtered on status, and it must stay that way: same ruling as the
      // unconsolidated counter and the gather query (2aefceb). status records
      // editorial state, it does not mark a task done, so filtering on
      // 'published' here hid 21 of 32 non-archived task docs, including every
      // 'active' and 'ready' one. archive/ is the only exclusion.
      const openTasks = (
        await db
          .prepare(
            // The closure predicate below is the ONLY status filter in this
            // query, and it is not a return of the bug 94b8528 fixed. That one
            // filtered on status = published and hid 21 of 32 task docs whose
            // status happened to be something else. This excludes exactly one
            // value, set deliberately to mean finished, and a doc with any
            // other status still appears. SQL note: status is NOT NULL, so the
            // comparison cannot swallow a row via NULL semantics.
            //
            // test/doc-meta.test.ts asserts this predicate appears exactly ONCE
            // in this file, so the lint loop can never grow one. A closed task
            // is finished, not forgotten, and only the archive/ prefix takes a
            // document out of memory.
            "SELECT namespace, path, title, type, body, updated_at FROM documents WHERE namespace = ?1 AND type = 'task' AND status != 'closed' AND path NOT LIKE 'archive/%' ORDER BY updated_at DESC"
          )
          .bind(namespace)
          .all<{ namespace: string; path: string; title: string | null; type: string | null; body: string | null; updated_at: string }>()
      ).results;
      const recentEpisodics = (
        await db
          .prepare(
            "SELECT namespace, path, title, type, body, updated_at FROM documents WHERE namespace = ?1 AND type = 'episodic' AND path NOT LIKE 'archive/%' ORDER BY created_at DESC LIMIT 3"
          )
          .bind(namespace)
          .all<{ namespace: string; path: string; title: string | null; type: string | null; body: string | null; updated_at: string }>()
      ).results;
      const coreOut = (
        await db
          .prepare("SELECT type, to_ns, to_path FROM document_links WHERE from_ns = ?1 AND from_path = 'core.md' ORDER BY type, to_ns, to_path")
          .bind(namespace)
          .all()
      ).results;
      const coreIn = (
        await db
          .prepare("SELECT type, from_ns, from_path FROM document_links WHERE to_ns = ?1 AND to_path = 'core.md' ORDER BY type, from_ns, from_path")
          .bind(namespace)
          .all()
      ).results;

      // Stay under budget by trimming the largest, most re-readable sections to
      // metadata first (episodics, then task bodies), and report what was cut.
      type Row = { namespace: string; path: string; title: string | null; body: string | null; updated_at: string };
      const bodyChars = (rows: Row[]) => rows.reduce((sum, r) => sum + (r.body?.length ?? 0), 0);
      const toStub = (rows: Row[]) =>
        rows.map((r) => ({ namespace: r.namespace, path: r.path, title: r.title, updated_at: r.updated_at, body: `(trimmed for size: read ${r.namespace}/${r.path})` }));
      const trimmed: string[] = [];
      let total =
        (conventions?.body?.length ?? 0) +
        (repoStructure?.body?.length ?? 0) +
        (core?.body?.length ?? 0) +
        bodyChars(openTasks as Row[]) +
        bodyChars(recentEpisodics as Row[]);
      let episodicsOut: unknown[] = recentEpisodics;
      let tasksOut: unknown[] = openTasks;
      if (total > BUDGET) {
        total -= bodyChars(recentEpisodics as Row[]);
        episodicsOut = toStub(recentEpisodics as Row[]);
        trimmed.push(`${recentEpisodics.length} episodic bodies`);
      }
      if (total > BUDGET) {
        total -= bodyChars(openTasks as Row[]);
        tasksOut = toStub(openTasks as Row[]);
        trimmed.push(`${openTasks.length} task bodies`);
      }

      return ok({
        namespace,
        conventions,
        repo_structure: repoStructure,
        core,
        open_tasks: tasksOut,
        recent_episodics: episodicsOut,
        core_links: { outgoing: coreOut, incoming: coreIn },
        approx_chars: total,
        ...(core ? {} : { warning: `no core.md for namespace ${namespace}` }),
        ...(trimmed.length ? { trimmed } : {}),
      });
    }
  );

  server.registerTool(
    "write",
    {
      description:
        "Create or update a document. Snapshots the prior version and writes an audit log entry. mode selects how body is applied: 'replace' (default, full body, needs title and body), 'append' (body is added to the end of the existing document, no title needed, no confirmation needed because nothing is overwritten), 'patch' (replace an anchored region: needs find and replace_with, and find must occur EXACTLY ONCE or the write is refused), or 'meta' (change type, tags, status or title and leave the body byte-identical, normalization included; use this to close a task or correct a document's type). append, patch and meta exist so amending a large document does not mean retranscribing it. Every response carries sha256 and bytes of the resulting body, so a write can be verified without reading the document back. Optional if_match: the sha256 of the body you believe is stored (the value a previous read-back or write returned). When it does not match the stored body the write is REFUSED and the error carries the current sha256, so a concurrent edit cannot be silently overwritten. Overwriting with replace or patch needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Optional links: a JSON array of typed outgoing edges [{\"type\":\"references\",\"to_path\":\"decisions.md\",\"to_ns\":\"capsid\"}] (types: governs, references, supersedes, replaces, depends-on; to_ns defaults to this namespace). When provided it replaces this document's outgoing edges; omit it to leave edges untouched; pass [] to clear them. Read edges with backlinks.",
      inputSchema: {
        namespace: nsName,
        path: docPath,
        // title and body are required for mode 'replace' and validated as such
        // below. They are optional in the schema because append needs no title
        // and patch needs neither: making them required here would force a
        // caller to resupply a title it is not changing, which is the
        // retranscription this mode exists to remove.
        title: bounded(MAX_TITLE).optional(),
        body: bounded(MAX_BODY).optional(),
        mode: z.enum(["replace", "append", "patch", "meta"]).optional(),
        find: bounded(MAX_BODY).optional(),
        replace_with: bounded(MAX_BODY).optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
        tags: bounded(MAX_TAGS).optional(),
        status: bounded(MAX_DOC_TYPE).optional(),
        confirm: z.boolean().optional(),
        links: bounded(MAX_LINKS_JSON).optional(),
        if_match: bounded(MAX_SHA).optional(),
      },
    },
    async ({ namespace, path, title, body, mode, find, replace_with, type, tags, status, confirm, links, if_match }) => {
      if (!operator) return fail(DENIED);
      const writeMode = mode ?? "replace";
      const typeError = type === undefined ? null : validateDocType(type);
      if (typeError) return fail(typeError);
      const statusError = status === undefined ? null : validateDocStatus(status);
      if (statusError) return fail(statusError);
      const parsedLinks = links === undefined ? null : parseLinks(links, namespace);
      if (parsedLinks && "error" in parsedLinks) return fail(parsedLinks.error);
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);

      const prior = await db
        .prepare("SELECT id, title, body, type, status, tags, updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null; type: string | null; status: string | null; tags: string | null; updated_at: string }>();

      // OPTIMISTIC CONCURRENCY. if_match is the sha256 of the body the caller
      // believes is stored, which is exactly the value every write already
      // returns, so a client that read or wrote the document has it without an
      // extra fetch.
      //
      // It exists because conventions.md's "re-read a document immediately
      // before overwriting it" is a discipline the server could not enforce, and
      // it was caught firing live on 2026-07-27 when a session doc was
      // substantially rewritten between a read and a planned write. A
      // lost-update needs no malice and leaves no trace in the result: the write
      // succeeds, the prior body is snapshotted, and nobody looks at the
      // snapshot because nothing said anything went wrong.
      //
      // Fail closed, the same shape as a patch anchor: on mismatch NOTHING is
      // written and the error carries the CURRENT sha so the caller can re-read,
      // rebase its edit and retry without guessing what it is racing. Opt-in,
      // because requiring it would break append, which is safe by construction.
      const commit = guardedCommit({
        db,
        namespace,
        path,
        prior,
        if_match,
        refusals: {
          ifMatchOnMissing: `if_match was given but ${namespace}/${path} does not exist. Nothing was written. Omit if_match to create it.`,
          ifMatchMismatch: (currentSha, passed) =>
            `if_match mismatch on ${namespace}/${path}: the stored body is not the one you read. Nothing was written. ` +
            `Current sha256 is ${currentSha}; you passed ${passed}. ` +
            `Re-read the document, reapply your change to the current body, and retry.`,
          createCollision:
            `create collision on ${namespace}/${path}: the document did not exist when this write started and it does now, so another writer created it first. ` +
            `Nothing was written and the other writer's body is intact. ` +
            `Re-read the document and retry as an update if you still mean to change it.`,
          deletedInFlight: `conflict on ${namespace}/${path}: the document was deleted while this write was in flight. Nothing was written.`,
          bodyChanged: (currentSha, elicited) =>
            `${if_match !== undefined ? "if_match mismatch" : "stale confirmation"} on ${namespace}/${path}: the stored body changed after this write read it${elicited && if_match === undefined ? " and while the overwrite confirmation was pending" : ""}. Nothing was written. ` +
            `Current sha256 is ${currentSha}. ` +
            `Re-read the document, reapply your change to the current body, and retry.`,
          batchFailed: (reason) => `write failed, nothing was written: ${reason}`,
        },
      });
      const staleIfMatch = await commit.precheckIfMatch();
      if (staleIfMatch) return fail(staleIfMatch);

      // Body assembly, per mode. Pure and unit-tested in ./write-modes. Every
      // mode returns the FULL new body, so the write path below is unchanged and
      // both invariants (version snapshot, audit row) apply identically to all
      // three.
      const assembled = assembleBody({
        mode: writeMode,
        exists: Boolean(prior),
        priorBody: prior?.body ?? null,
        title,
        body,
        find,
        replace_with,
      });
      if ("error" in assembled) return fail(`${assembled.error} (${namespace}/${path})`);
      body = assembled.body;
      if (writeMode === "meta" && title === undefined && type === undefined && tags === undefined && status === undefined) {
        return fail(`mode 'meta' needs at least one of title, type, tags or status to change (${namespace}/${path}).`);
      }

      // Normalize wide dashes server-side so no client can store an em dash,
      // regardless of whether the Claude Code hook ran. See ./normalize. This
      // runs AFTER assembly so append and patch content is normalized too,
      // which is the gap the hand-run SQL splice had: normalization did not run
      // on that path at all.
      if (title !== undefined) title = normalizeDashes(title, "title");
      // mode 'meta' does not touch the body, so the body is not normalized
      // either. THE CONTRACT IS: meta leaves the stored body byte-identical.
      // Running the normalizer over an untouched body broke that in one case
      // that matters, and it is not hypothetical: bodies stored before the
      // normalizer existed can still carry a wide dash, and a meta write meant
      // to close a task would then silently rewrite prose it was never asked to
      // change, with bytes_before != bytes as the only hint. conventions.md also
      // forbids editing already-stored content to satisfy the dash rule.
      // Everything a caller actually supplies still goes through the normalizer,
      // so no client can introduce an em dash: this only declines to rewrite
      // what nobody submitted.
      if (writeMode !== "meta") body = normalizeDashes(body as string, "prose");
      // append is exempt from confirmation, deliberately. Confirmation exists to
      // stop an accidental clobber of existing text, and an append cannot
      // destroy any: the prior body is still snapshotted, and the addition goes
      // after it. Requiring a confirm here would make the cheap, safe operation
      // more ceremonious than the dangerous one, and callers would go back to
      // full-body rewrites. patch and replace both mutate existing text and are
      // NOT exempt.
      // Whether a human actually answered a prompt, reported by the helper rather
      // than inferred here. It arms the commit-time body guard; why that consent
      // goes stale is stated once, on requireConfirmation.
      let elicited = false;
      if (prior && confirm !== true && writeMode !== "append" && writeMode !== "meta") {
        const refusal = await requireConfirmation(server, confirm, {
          prompt: `Overwrite ${namespace}/${path}? The current version will be snapshotted to document_versions first.`,
          declined: `overwrite of ${namespace}/${path} declined`,
          unsupported: `confirmation required: ${namespace}/${path} already exists. Re-run write with confirm: true to overwrite it. The current version will be snapshotted to document_versions first.`,
        });
        if (!refusal.ok) return fail(refusal.message);
        elicited = refusal.elicited;
      }
      // The guard itself is armed by commit.run() below, from this same pre-read.
      const statements: D1PreparedStatement[] = [];
      if (prior) {
        statements.push(
          db
            .prepare(
              "INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (?1, ?2, ?3, ?4, ?5)"
            )
            .bind(prior.id, namespace, path, prior.title, prior.body)
        );
      }
      statements.push(
        db
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
          .bind(namespace, path, title ?? null, body, type ?? null, tags ?? null, status ?? null)
      );
      // The PRIOR type, status, tags and title go into the audit params whenever
      // a write changes any of them, and this is the only place they survive.
      // document_versions snapshots title and body ONLY, so a meta write that
      // retyped a document or closed a task was previously unrecoverable: the
      // new value was in documents, the old value was nowhere. Ruled 2026-08-13:
      // the snapshot schema stays title plus body, and the audit log carries the
      // metadata delta instead, because a version row is a body snapshot and
      // widening it would mean a migration plus a rewrite of every restore path
      // to answer a question the log can already answer.
      const metaChanged = title !== undefined || type !== undefined || tags !== undefined || status !== undefined;
      statements.push(
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'write', ?2, ?3, ?4)")
          .bind(
            actor,
            namespace,
            path,
            JSON.stringify({
              title,
              type,
              tags,
              status,
              mode: writeMode,
              updated: Boolean(prior),
              ...(prior && metaChanged
                ? { prior_meta: { title: prior.title, type: prior.type, status: prior.status, tags: prior.tags } }
                : {}),
            })
          )
      );
      // links replaces this document's outgoing edges when provided. Left
      // untouched when omitted, so a routine body edit never drops edges.
      if (parsedLinks && "edges" in parsedLinks) {
        statements.push(
          db.prepare("DELETE FROM document_links WHERE from_ns = ?1 AND from_path = ?2").bind(namespace, path)
        );
        for (const edge of parsedLinks.edges) {
          statements.push(
            db
              .prepare(
                "INSERT OR IGNORE INTO document_links (from_ns, from_path, type, to_ns, to_path) VALUES (?1, ?2, ?3, ?4, ?5)"
              )
              .bind(namespace, path, edge.type, edge.to_ns, edge.to_path)
          );
        }
        statements.push(
          db
            .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'links', ?2, ?3, ?4)")
            .bind(actor, namespace, path, JSON.stringify({ edges: parsedLinks.edges.length }))
        );
      }
      // The warning is computed from a read taken HERE, not from the pre-read at
      // the top of the handler. Between those two points this handler may have
      // sat in a 90 second elicitation, which is exactly when a racing write is
      // most likely to have landed and precisely the case the warning exists to
      // surface. Reading it late costs one SELECT and makes the telemetry
      // describe the state the write is actually committing against.
      const atCommit = prior
        ? await db
            .prepare("SELECT updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
            .bind(namespace, path)
            .first<{ updated_at: string }>()
        : null;
      const conflict = await commit.run(elicited, statements);
      if (conflict) return fail(conflict);
      // Warn, do not reject, when an edge points at a document that does not
      // exist. Rejecting would block the legitimate case of asserting an edge
      // before its target is written, and edges may also address repo files
      // rather than Capsid documents. But a silent dangling edge is how 23 of
      // them accumulated unnoticed before 2026-08-10, so the write says so.
      // The lint loop reports these per namespace; this is the same check at
      // the moment the edge is created.
      let danglingTargets: string[] = [];
      let danglingCheckFailed: string | null = null;
      if (parsedLinks && "edges" in parsedLinks && parsedLinks.edges.length > 0) {
        // This read runs AFTER the commit, so a failure here must not be reported
        // as a failed write: the document is stored. Same shape as the audit
        // warning in guardedWrite (F17).
        try {
          const checks = await db.batch(
            parsedLinks.edges.map((edge) =>
              db
                .prepare("SELECT 1 AS ok FROM documents WHERE namespace = ?1 AND path = ?2")
                .bind(edge.to_ns, edge.to_path)
            )
          );
          danglingTargets = parsedLinks.edges
            .filter((_, i) => (checks[i].results?.length ?? 0) === 0)
            .map((edge) => `${edge.to_ns}/${edge.to_path}`);
        } catch (err) {
          danglingCheckFailed = err instanceof Error ? err.message : String(err);
        }
      }
      // The read-back. sha256 and byte length of the body that is now stored, so
      // a caller can verify the write landed exactly as intended WITHOUT
      // fetching the document and comparing it by eye. That second read was
      // itself a transcription, and the correlated-transcription risk fired
      // twice on 2026-08-07 because verifying a write meant re-reading and
      // re-writing the same 30KB.
      //
      // Hash the assembled body rather than re-selecting it: re-selecting would
      // prove the round trip but would also be the extra read this is meant to
      // avoid, and D1 returns exactly what was bound.
      const bodySha = await sha256Hex(body);
      const bodyBytes = new TextEncoder().encode(body).length;

      return ok({
        namespace,
        path,
        action: prior ? "updated" : "created",
        mode: writeMode,
        sha256: bodySha,
        bytes: bodyBytes,
        ...(writeMode !== "replace" && prior
          ? { bytes_before: new TextEncoder().encode(prior.body ?? "").length }
          : {}),
        snapshotted: Boolean(prior),
        // Only when the caller did not already guard the write.
        ...(prior && if_match === undefined
          ? (() => {
              const warning = concurrentEditWarning(atCommit?.updated_at ?? prior.updated_at, Date.now());
              return warning ? { concurrency_warning: warning } : {};
            })()
          : {}),
        ...(parsedLinks && "edges" in parsedLinks ? { links: parsedLinks.edges.length } : {}),
        ...(danglingTargets.length
          ? {
              warning: `${danglingTargets.length} link target(s) do not exist as Capsid documents: ${danglingTargets.join(", ")}. The edge was still written. This is fine if the target is a repo file or is about to be created; otherwise it is a dangling edge and the lint loop will report it.`,
            }
          : {}),
      });
    }
  );

  // Every overwrite and delete has snapshotted the prior row into
  // document_versions since the beginning, and until 2026-08-13 nothing could read
  // it back. The rows were reachable only by raw SQL, which meant a recovery was a
  // hand-written D1 query by whoever still had account access, and it was done that
  // way twice: the 2026-08-10 edge repair read snapshots directly, and
  // recova/parity/INVENTORY-SEED.md is STILL unrestored while surviving as a
  // 7889-byte snapshot, because restoring it was more work than it was worth. A
  // backup nobody can read is a backup nobody uses.
  server.registerTool(
    "history",
    {
      description:
        "List the retained versions of a document (newest first) from document_versions, or fetch one body by passing version_id. Snapshots are written by every overwrite and delete, so the history of a deleted document is still readable. Retention is 90 days; older snapshots live only in the R2 dumps. Read-only. Note the scope: a version records title and body, so a change to type, status or tags is not here, it is in the audit log.",
      inputSchema: { namespace: nsName, path: docPath, version_id: z.number().int().positive().optional() },
    },
    async ({ namespace, path, version_id }) => {
      if (version_id !== undefined) {
        const row = await db
          .prepare(
            "SELECT id, document_id, namespace, path, title, body, snapshot_at FROM document_versions WHERE id = ?1 AND namespace = ?2 AND path = ?3"
          )
          .bind(version_id, namespace, path)
          .first<{ id: number; body: string | null }>();
        // namespace and path are part of the lookup on purpose: an id alone would
        // let a caller walk every snapshot in the store by incrementing a number.
        if (!row) return fail(`no version ${version_id} for ${namespace}/${path}`);
        return ok({ ...row, bytes: new TextEncoder().encode(row.body ?? "").length });
      }
      const { results } = await db
        .prepare(
          `SELECT id, snapshot_at, title, LENGTH(body) AS bytes
           FROM document_versions
           WHERE namespace = ?1 AND path = ?2
           ORDER BY snapshot_at DESC, id DESC`
        )
        .bind(namespace, path)
        .all();
      const live = await db
        .prepare("SELECT title, updated_at, LENGTH(body) AS bytes FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first();
      return ok({
        namespace,
        path,
        live: live ?? null,
        versions: results,
        ...(live ? {} : { note: "no live document at this path: these are the snapshots of a deleted or moved document" }),
      });
    }
  );

  server.registerTool(
    "restore",
    {
      description:
        "Restore a document's title and body from one of its retained versions (see history). It carries the same two write-path invariants as write: the CURRENT body is snapshotted to document_versions first and the restore is appended to audit_log, so a restore is itself undoable. It is NOT the write tool's code path and differs from it deliberately: the snapshotted bytes go back exactly as they were stored, with no dash normalization, and type, status, tags and links are neither validated nor restored, because a version row does not carry them. Restoring a deleted document recreates it. Optional if_match: the sha256 of the body you believe is live now, enforced as a commit-time predicate, so a restore cannot land on a body that changed after you read it. Requires operator key and confirm: true.",
      inputSchema: {
        namespace: nsName,
        path: docPath,
        version_id: z.number().int().positive(),
        confirm: z.boolean().optional(),
        if_match: bounded(MAX_SHA).optional(),
      },
    },
    async ({ namespace, path, version_id, confirm, if_match }) => {
      if (!operator) return fail(DENIED);
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      const version = await db
        .prepare("SELECT id, title, body, snapshot_at FROM document_versions WHERE id = ?1 AND namespace = ?2 AND path = ?3")
        .bind(version_id, namespace, path)
        .first<{ id: number; title: string | null; body: string | null; snapshot_at: string }>();
      if (!version) return fail(`no version ${version_id} for ${namespace}/${path}`);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      // The same protocol the write tool runs, with restore's wordings. On the
      // recreate path the guard is the ABSENCE of a row, because the snapshot
      // statement is only added when the pre-read saw one, so a racing create
      // would otherwise be overwritten with nothing kept.
      const commit = guardedCommit({
        db,
        namespace,
        path,
        prior,
        if_match,
        refusals: {
          ifMatchOnMissing: `if_match was given but ${namespace}/${path} does not exist. Nothing was written. Omit if_match to recreate it from a version.`,
          ifMatchMismatch: (currentSha, passed) =>
            `if_match mismatch on ${namespace}/${path}: the live body is not the one you read. Nothing was restored. ` +
            `Current sha256 is ${currentSha}; you passed ${passed}.`,
          createCollision: `create collision on ${namespace}/${path}: it did not exist when this restore started and it does now, so another writer created it first. Nothing was written and that body is intact.`,
          deletedInFlight: `conflict on ${namespace}/${path}: the document was deleted while this restore was in flight. Nothing was written.`,
          bodyChanged: (currentSha) =>
            `conflict on ${namespace}/${path}: the live body changed after this restore read it. Nothing was written. ` +
            `Current sha256 is ${currentSha}. Re-read history and retry.`,
          batchFailed: (reason) => `restore failed, nothing was written: ${reason}`,
        },
      });
      const staleIfMatch = await commit.precheckIfMatch();
      if (staleIfMatch) return fail(staleIfMatch);
      const restoreRefusal = await requireConfirmation(server, confirm, {
        prompt: `Restore ${namespace}/${path} to the version snapshotted at ${version.snapshot_at}? The current body will be snapshotted first.`,
        declined: `restore of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run restore with confirm: true to overwrite ${namespace}/${path} with version ${version_id} (snapshotted ${version.snapshot_at}). The current body will be snapshotted first.`,
      });
      if (!restoreRefusal.ok) return fail(restoreRefusal.message);
      const elicited = restoreRefusal.elicited;
      // The stored body goes back EXACTLY as it was snapshotted, with no dash
      // normalization. A snapshot is a record of what the document said, and a
      // restore that quietly rewrote it would not be a restore.
      const body = version.body ?? "";
      const statements: D1PreparedStatement[] = [];
      if (prior) {
        statements.push(
          db
            .prepare("INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (?1, ?2, ?3, ?4, ?5)")
            .bind(prior.id, namespace, path, prior.title, prior.body)
        );
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO documents (namespace, path, title, body)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(namespace, path) DO UPDATE SET
               title = ?3,
               body = excluded.body,
               updated_at = datetime('now')`
          )
          .bind(namespace, path, version.title, body)
      );
      statements.push(
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'restore', ?2, ?3, ?4)")
          .bind(
            actor,
            namespace,
            path,
            JSON.stringify({ version_id, snapshot_at: version.snapshot_at, recreated: !prior, snapshotted: Boolean(prior) })
          )
      );
      const conflict = await commit.run(elicited, statements);
      if (conflict) return fail(conflict);
      return ok({
        namespace,
        path,
        action: prior ? "restored" : "recreated",
        version_id,
        snapshot_at: version.snapshot_at,
        sha256: await sha256Hex(body),
        bytes: new TextEncoder().encode(body).length,
        snapshotted: Boolean(prior),
        ...(prior ? {} : { note: "the document did not exist and was recreated; its type, status, tags and links are defaults, not the ones it had" }),
      });
    }
  );

  server.registerTool(
    "backlinks",
    {
      description:
        "Return the typed edges touching a document: outgoing (declared on this doc) and incoming (other docs pointing here). Edges are asserted via the write tool's links param. Read-only. Endpoints may be Capsid documents or repo files addressed as namespace/path.",
      inputSchema: { namespace: nsName, path: docPath },
    },
    async ({ namespace, path }) => {
      const outgoing = await db
        .prepare(
          "SELECT type, to_ns, to_path FROM document_links WHERE from_ns = ?1 AND from_path = ?2 ORDER BY type, to_ns, to_path"
        )
        .bind(namespace, path)
        .all();
      const incoming = await db
        .prepare(
          "SELECT type, from_ns, from_path FROM document_links WHERE to_ns = ?1 AND to_path = ?2 ORDER BY type, from_ns, from_path"
        )
        .bind(namespace, path)
        .all();
      return ok({ namespace, path, outgoing: outgoing.results, incoming: incoming.results });
    }
  );

  server.registerTool(
    "delete",
    {
      description: "Delete a document. Snapshots it first and writes an audit log entry. Needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true.",
      inputSchema: { namespace: nsName, path: docPath, confirm: z.boolean().optional() },
    },
    async ({ namespace, path, confirm }) => {
      if (!operator) return fail(DENIED);
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      if (!prior) return fail(`not found: ${namespace}/${path}`);
      const deleteRefusal = await requireConfirmation(server, confirm, {
        prompt: `Delete ${namespace}/${path}? It will be snapshotted to document_versions first, so it can be recovered.`,
        declined: `delete of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run delete with confirm: true to remove ${namespace}/${path}. It will be snapshotted to document_versions first.`,
      });
      if (!deleteRefusal.ok) return fail(deleteRefusal.message);
      // Read the edges before pathMutation removes them: the audit row is the
      // only place they survive, since document_versions holds title and body
      // only.
      const { results: removedEdges } = await edgesTouching(db, namespace, path).all();
      // requireExists is not redundant with the `prior` read above: that read is
      // a separate transaction, and a delete that matches zero rows would
      // otherwise snapshot a body, write an audit row saying 'delete', and answer
      // "deleted" having removed nothing.
      try {
        await db.batch([
          requireExists(db, namespace, path),
          db
            .prepare(
              "INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (?1, ?2, ?3, ?4, ?5)"
            )
            .bind(prior.id, namespace, path, prior.title, prior.body),
          ...pathMutation(db, namespace, path, null),
          db
            .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'delete', ?2, ?3, ?4)")
            .bind(actor, namespace, path, JSON.stringify({ edges_removed: removedEdges })),
        ]);
      } catch (err) {
        if (isMissingRowAbort(err)) {
          return fail(`delete aborted, nothing changed: ${namespace}/${path} no longer exists. Another session removed it after this call started.`);
        }
        return fail(`delete failed, nothing changed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok({
        namespace,
        path,
        action: "deleted",
        snapshotted: true,
        edges_removed: removedEdges.length,
      });
    }
  );

  server.registerTool(
    "move",
    {
      description: "Rename a document path within its namespace, repointing every typed edge that touches it. Audit logged. Needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Requires operator key.",
      inputSchema: { namespace: nsName, path: docPath, new_path: docPath, confirm: z.boolean().optional() },
    },
    async ({ namespace, path, new_path, confirm }) => {
      if (!operator) return fail(DENIED);
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      // Existence and the edge count are both read BEFORE the batch, deliberately.
      // D1's meta.changes cannot be used for either here: documents carries FTS5
      // sync triggers, so an UPDATE on it reports the trigger's row changes too,
      // and in a batch those accumulate across statements. Measured 2026-08-10,
      // when deriving the count from the batch reported 5 edges repointed for a
      // single edge. The repointing itself was correct; only the number lied.
      const exists = await db
        .prepare("SELECT 1 AS ok FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ ok: number }>();
      if (!exists) return fail(`not found: ${namespace}/${path}`);
      // move JOINS the confirmation as of 2026-08-17 (audit 2, F25 ruling). It is
      // destructive-class and had none at all: it renames a document and repoints
      // every edge that touches it, and unlike delete it leaves no snapshot of the
      // old path to recover from, only an audit row.
      const moveRefusal = await requireConfirmation(server, confirm, {
        prompt: `Rename ${namespace}/${path} to ${namespace}/${new_path}? Edges pointing at the old path are repointed.`,
        declined: `move of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run move with confirm: true to rename ${namespace}/${path} to ${new_path}.`,
      });
      if (!moveRefusal.ok) return fail(moveRefusal.message);
      const { results: movingEdges } = await edgesTouching(db, namespace, path).all();
      const repointed = movingEdges.length;
      // ONE batch: the guard, the rename, the edge repointing AND the audit row.
      //
      // The audit INSERT used to run as its own statement after the batch, which
      // made two failures possible that the log then could not describe. A move
      // that succeeded and an audit write that failed left a rename with no
      // record, and the reverse left a record of a move that never happened. The
      // 2026-08-10 edge repair depended entirely on audit_log move records to
      // recover five repoints, so a log that can disagree with the table is not
      // an academic problem here.
      try {
        await db.batch([
          requireExists(db, namespace, path),
          ...pathMutation(db, namespace, path, new_path),
          db
            .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'move', ?2, ?3, ?4)")
            .bind(actor, namespace, path, JSON.stringify({ new_path, edges_repointed: repointed })),
        ]);
      } catch (err) {
        if (isMissingRowAbort(err)) {
          return fail(`move aborted, nothing changed: ${namespace}/${path} no longer exists. Another session moved or removed it after this call started.`);
        }
        return fail(`move failed, nothing changed (target may already exist): ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok({ namespace, path, new_path, action: "moved", edges_repointed: repointed });
    }
  );

  server.registerTool(
    "find",
    {
      description: "Find documents whose path matches a glob pattern (SQLite GLOB, e.g. 'notes/*.md'). Optional namespace filter.",
      inputSchema: { namespace: nsName.optional(), glob: bounded(MAX_GLOB) },
    },
    async ({ namespace, glob }) => {
      const { results } = await db
        .prepare(
          `SELECT namespace, path, title, type, status, updated_at
           FROM documents
           WHERE path GLOB ?1 AND (?2 IS NULL OR namespace = ?2)
           ORDER BY namespace, path`
        )
        .bind(glob, namespace ?? null)
        .all();
      return ok(results);
    }
  );

  server.registerTool(
    "search",
    {
      description: "Full text search across all documents (FTS5, ranked by bm25). Optional namespace and type filters. This is the cross-project search.",
      inputSchema: {
        query: bounded(MAX_QUERY),
        namespace: nsName.optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
      },
    },
    async ({ query, namespace, type }) => {
      const run = (match: string) =>
        db
          .prepare(
            `SELECT d.id, d.namespace, d.path, d.title, d.type, d.status, d.updated_at,
                    snippet(documents_fts, 1, '[', ']', ' ... ', 16) AS snippet
             FROM documents_fts
             JOIN documents d ON d.id = documents_fts.rowid
             WHERE documents_fts MATCH ?1
               AND (?2 IS NULL OR d.namespace = ?2)
               AND (?3 IS NULL OR d.type = ?3)
             ORDER BY bm25(documents_fts)
             LIMIT 25`
          )
          .bind(match, namespace ?? null, type ?? null)
          .all();
      try {
        return ok((await run(query)).results);
      } catch {
        // Hyphens, quotes, and bare AND/OR/NOT are FTS5 syntax. Retry the whole
        // query as a quoted phrase so plain text is always a safe input.
        try {
          return ok((await run(`"${query.replace(/"/g, '""')}"`)).results);
        } catch (err) {
          return fail(`search failed (check FTS5 query syntax): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  );

  server.registerTool(
    "namespaces",
    {
      description: "List all namespaces and the repos each maps to.",
      inputSchema: {},
    },
    async () => {
      // unconsolidated = episodic/source docs not yet archived by the lint loop;
      // surfaced here so every session sees which namespaces need a run.
      // Deliberately NOT filtered on status: this counted only status
      // 'published' until 2026-07-30 and so read 2 for recova against a real
      // backlog of 24, because 22 episodics had been written as 'active'.
      // The archive/ prefix is the only thing that takes a doc out of the loop.
      const { results } = await db
        .prepare(
          `SELECT n.namespace, n.repos, n.created_at,
                  (SELECT COUNT(*) FROM documents d
                   WHERE d.namespace = n.namespace AND d.type IN ('episodic', 'source')
                     AND d.path NOT LIKE 'archive/%') AS unconsolidated
           FROM namespaces n ORDER BY n.namespace`
        )
        .all();
      return ok(results);
    }
  );

  // Register a namespace: the one row in the namespaces table that repo tools and
  // the namespaces list read. Writing documents to a new namespace label does not
  // create it, so without this a namespace was a raw D1 insert (how bsw shipped).
  // Create-only: it will not overwrite an existing mapping. Requires operator key.
  server.registerTool(
    "register_namespace",
    {
      description:
        "Register a namespace by inserting its row in the namespaces table, so repo tools and the namespaces list can see it. Give repo as 'owner/name' (label defaults to 'primary'), or pass a repos JSON array like [{\"repo\":\"owner/name\",\"label\":\"primary\"}] for a multi-repo namespace. Create-only: it will not overwrite an existing namespace. Requires operator key.",
      inputSchema: {
        namespace: nsName,
        repo: bounded(MAX_REPO_SELECTOR).optional(),
        label: bounded(MAX_REPO_SELECTOR).optional(),
        repos: bounded(MAX_REPOS_JSON).optional(),
      },
    },
    async ({ namespace, repo, label, repos }) => {
      if (!operator) return fail(DENIED);
      const ns = namespace.trim();
      if (!ns) return fail("namespace is required");
      let list: Array<{ repo: string; label: string }>;
      if (repos) {
        const parsed = parseReposList(repos);
        if ("error" in parsed) return fail(parsed.error);
        list = parsed.list;
      } else {
        if (!repo || !REPO_SHAPE.test(repo)) {
          return fail('provide repo as "owner/name", or pass a repos JSON array');
        }
        list = [{ repo, label: (label ?? "primary").trim() || "primary" }];
      }
      // The single-primary requirement is UNIFIED with update_namespace as of
      // 2026-08-13. It was enforced on the update path only, so the two tools
      // disagreed about what a valid mapping is: register could create a namespace
      // with two primaries or none, which every repo tool then resolves by
      // accident, and update would refuse to fix it in place. One rule, both
      // paths, and the rule belongs where the mapping is created.
      const primaryError = requireSinglePrimary(list);
      if (primaryError) return fail(primaryError);
      const existing = await db.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(ns).first();
      if (existing) {
        return fail(`namespace already registered: ${ns}. Use update_namespace to change its repo mapping; it snapshots the prior mapping to the audit log.`);
      }
      const reposJson = JSON.stringify(list);
      await db.batch([
        db.prepare("INSERT INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind(ns, reposJson),
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'register_namespace', ?2, NULL, ?3)")
          .bind(actor, ns, reposJson),
      ]);
      return ok({ namespace: ns, repos: list, action: "registered" });
    }
  );

  // Remap an existing namespace's repos. register_namespace stays the create
  // path; this is the update path that the recova remap needed (previously a raw
  // D1 UPDATE that bypassed the audit log). Snapshots the prior mapping. It does
  // NOT rename the namespace: a rename touches document keys, versions, and audit
  // history and is a separate task.
  server.registerTool(
    "update_namespace",
    {
      description:
        "Remap an existing namespace's repos. Pass repos as a JSON array like [{\"repo\":\"owner/name\",\"label\":\"primary\"},{\"repo\":\"owner/legacy\",\"label\":\"legacy\"}], with exactly one entry labeled \"primary\". The namespace must already exist (use register_namespace to create). Snapshots the prior mapping to the audit log. Does NOT rename the namespace or move its documents. Requires operator key.",
      inputSchema: { namespace: nsName, repos: bounded(MAX_REPOS_JSON) },
    },
    async ({ namespace, repos }) => {
      if (!operator) return fail(DENIED);
      const ns = namespace.trim();
      if (!ns) return fail("namespace is required");
      const parsed = parseReposList(repos);
      if ("error" in parsed) return fail(parsed.error);
      const list = parsed.list;
      const primaryError = requireSinglePrimary(list);
      if (primaryError) return fail(primaryError);
      const existing = await db
        .prepare("SELECT repos FROM namespaces WHERE namespace = ?1")
        .bind(ns)
        .first<{ repos: string }>();
      if (!existing) return fail(`namespace not found: ${ns}. Use register_namespace to create it.`);
      const reposJson = JSON.stringify(list);
      await db.batch([
        db.prepare("UPDATE namespaces SET repos = ?2 WHERE namespace = ?1").bind(ns, reposJson),
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'update_namespace', ?2, NULL, ?3)")
          .bind(actor, ns, JSON.stringify({ old: existing.repos, new: reposJson })),
      ]);
      return ok({ namespace: ns, repos: list, action: "updated", previous: existing.repos });
    }
  );

  // Consolidation loop (the LLM Wiki maintenance step). The Worker does no
  // reasoning: a capable client calls gather, synthesizes the update with the
  // existing read/write tools, then calls finalize to archive what it consumed.
  server.registerTool(
    "lint",
    {
      description:
        "Consolidation loop for a namespace. mode 'gather' (default, read-only) returns the packet a driving LLM needs to compile the wiki: current core.md, the concept and decision docs, every unconsolidated episodic and source doc, and the capsid schema and conventions rules. After writing the updated core.md and concept docs via write, call mode 'finalize' with consumed: the episodic/source paths that were compiled. Finalize moves them under archive/ (never deletes, never touches core or concept docs) and writes one audit row. Finalize requires operator key and confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true.",
      inputSchema: {
        namespace: nsName,
        mode: z.enum(["gather", "finalize"]).optional(),
        consumed: z.array(docPath).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ namespace, mode, consumed, confirm }) => {
      if ((mode ?? "gather") === "gather") {
        const core = await db
          .prepare("SELECT namespace, path, title, type, status, body, updated_at FROM documents WHERE namespace = ?1 AND path = 'core.md'")
          .bind(namespace)
          .first();
        const wiki = await db
          .prepare(
            `SELECT namespace, path, title, type, status, tags, body, updated_at
             FROM documents
             WHERE namespace = ?1 AND type IN ('concept', 'decision')
             ORDER BY path`
          )
          .bind(namespace)
          .all();
        // Not filtered on status, and it must stay that way: see the note on the
        // unconsolidated counter. A doc written with any status is consolidatable;
        // only the archive/ prefix removes it, which is what keeps gather
        // idempotent after finalize.
        const raw = await db
          .prepare(
            `SELECT namespace, path, title, type, status, tags, body, created_at, updated_at
             FROM documents
             WHERE namespace = ?1 AND type IN ('episodic', 'source')
               AND path NOT LIKE 'archive/%'
             ORDER BY created_at`
          )
          .bind(namespace)
          .all();
        const rules = await db
          .prepare("SELECT namespace, path, title, body FROM documents WHERE namespace = 'capsid' AND path IN ('schema.md', 'conventions.md') ORDER BY path")
          .all();
        // Typed edges whose endpoint no longer exists. Gather is read-only and
        // the client judges, so these are reported, never auto-repaired: a
        // dangling edge usually means the target was renamed by hand or removed
        // before delete cascaded, and which of those it was decides whether the
        // fix is repointing the edge or dropping it. Both endpoints are checked,
        // since a source can go missing as easily as a target.
        const danglingEdges = await db
          .prepare(
            `SELECT l.from_ns, l.from_path, l.type, l.to_ns, l.to_path,
                    CASE WHEN f.id IS NULL THEN 1 ELSE 0 END AS source_missing,
                    CASE WHEN t.id IS NULL THEN 1 ELSE 0 END AS target_missing
             FROM document_links l
             LEFT JOIN documents f ON f.namespace = l.from_ns AND f.path = l.from_path
             LEFT JOIN documents t ON t.namespace = l.to_ns AND t.path = l.to_path
             WHERE (f.id IS NULL OR t.id IS NULL)
               AND (l.from_ns = ?1 OR l.to_ns = ?1)
             ORDER BY l.from_ns, l.from_path, l.type`
          )
          .bind(namespace)
          .all();
        // Rough packet size so a driving LLM knows when a gather will not fit
        // its context and it should consolidate in batches instead.
        const packetChars = [core, ...wiki.results, ...raw.results, ...rules.results].reduce(
          (sum, row) => sum + String((row as { body?: unknown } | null)?.body ?? "").length,
          0
        );
        // Batch-two item 10: prose counts checked against the artifacts they
        // describe. Standing docs only; episodics record history and their
        // numbers were right when written. FLAG, never correct: the claims come
        // back for a human to judge, and nothing here rewrites a document.
        const standing = await db
          .prepare(
            `SELECT path, type, body FROM documents
             WHERE namespace = ?1 AND path NOT LIKE 'archive/%'`
          )
          .bind(namespace)
          .all<{ path: string; type: string | null; body: string | null }>();
        // Namespace-scoped: a namespace with no authoritative numbers of its own
        // gets no claims, rather than being measured against capsid's.
        const countClaims = scanCountClaims(standing.results, namespace);

        return ok({
          mode: "gather",
          namespace,
          core: core ?? null,
          wiki: wiki.results,
          unconsolidated: raw.results,
          rules: rules.results,
          dangling_edges: danglingEdges.results,
          authoritative_counts: authoritativeFor(namespace),
          count_claims: countClaims,
          packet_chars: packetChars,
          ...(packetChars > 150_000
            ? { warning: "large packet: consider consolidating the oldest unconsolidated docs first, in batches, using read on individual paths" }
            : {}),
        });
      }

      if (!operator) return fail(DENIED);
      const paths = [...new Set(consumed ?? [])];
      if (paths.length === 0) {
        return fail("finalize requires consumed: the episodic/source paths that were compiled into the wiki");
      }
      const problems: string[] = [];
      for (const path of paths) {
        const row = await db
          .prepare("SELECT type FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path)
          .first<{ type: string | null }>();
        if (!row) problems.push(`not found: ${namespace}/${path}`);
        else if (path.startsWith("archive/")) problems.push(`already archived: ${namespace}/${path}`);
        else if (row.type !== "episodic" && row.type !== "source") {
          problems.push(`not consumable: ${namespace}/${path} has type '${row.type}' (only episodic and source docs are archived)`);
        }
      }
      if (problems.length > 0) return fail(`finalize aborted, nothing archived:\n${problems.join("\n")}`);
      // finalize JOINS the confirmation too (audit 2, F25 ruling), and it is the
      // widest mutation in this file: one call renames every consumed document.
      const finalizeRefusal = await requireConfirmation(server, confirm, {
        prompt: `Archive ${paths.length} document(s) in ${namespace} by moving them under archive/?`,
        declined: `finalize of ${namespace} declined`,
        unsupported: `confirmation required: re-run lint finalize with confirm: true to archive ${paths.length} document(s) in ${namespace}.`,
      });
      if (!finalizeRefusal.ok) return fail(finalizeRefusal.message);
      // Archiving is a rename to archive/<path>, so it goes through the same
      // helper as move and drags its edges along for the same reason.
      // Each path carries its own in-batch existence guard. The loop above
      // already checked every path, but that was a separate transaction per path
      // and finalize is the widest of these mutations: it renames many documents
      // at once, so it is the one most likely to race a delete, and a partial
      // archive silently drops documents out of the lint loop's view.
      const statements = paths.flatMap((path) => [
        requireExists(db, namespace, path),
        ...pathMutation(db, namespace, path, `archive/${path}`),
      ]);
      statements.push(
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'lint', ?2, NULL, ?3)")
          .bind(actor, namespace, JSON.stringify({ consolidated: paths.length, consumed: paths }))
      );
      try {
        await db.batch(statements);
      } catch (err) {
        if (isMissingRowAbort(err)) {
          return fail(
            "finalize aborted, nothing archived: one of the consumed paths no longer exists. Another session moved or removed it after this call started. Re-run gather and finalize the current set."
          );
        }
        return fail(`finalize failed, nothing archived (an archive/ target may already exist): ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok({
        mode: "finalize",
        namespace,
        consolidated: paths.length,
        archived: paths.map((path) => ({ from: path, to: `archive/${path}` })),
      });
    }
  );

  // Repo fallthrough: live GitHub access via the Capsid GitHub App. Reads are
  // open to any admitted client; writes require the operator key. The target
  // repo is resolved per namespace from the namespaces table.
  const guarded = async (fn: () => Promise<unknown>) => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  // Repo writes are operator-gated and audit-logged. The whole result (which
  // includes the resolved repo) goes into params so a misdirected write is
  // diagnosable from the log; path is the file path where one applies.
  const guardedWrite = async (
    action: string,
    namespace: string,
    path: string | null,
    fn: () => Promise<Record<string, unknown>>
  ) => {
    if (!operator) return fail(DENIED);
    let result: Record<string, unknown>;
    try {
      result = await fn();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    // THE MUTATION ALREADY LANDED (audit 2, F17). fn() has committed to GitHub by
    // the time this row is written, and the audit INSERT is a separate statement
    // that cannot be rolled into it. When it failed, the caller was told the tool
    // failed, so the honest report of "the branch exists, the PR is open, and the
    // log does not know" came out as "nothing happened". A caller acting on that
    // retries, and the retry is a second commit.
    //
    // The D1-only tools do not need this: delete, move and finalize put the audit
    // INSERT inside the same batch as the mutation, so there both land or neither
    // does. GitHub cannot join that transaction.
    try {
      await db
        .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(actor, action, namespace, path, JSON.stringify(result))
        .run();
    } catch (err) {
      console.error(`AUDIT_INSERT_FAILED ${action} ${namespace}/${path ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
      return ok({
        ...result,
        audit_warning:
          `THE ${action} SUCCEEDED and is described by this result, but the audit_log row could not be written: ` +
          `${err instanceof Error ? err.message : String(err)}. Do not retry this call; the change is already made.`,
      });
    }
    return ok(result);
  };

  // A namespace can map to more than one repo (e.g. recova -> foxhound primary +
  // recova legacy). The optional `repo` argument on every repo tool selects one:
  // pass a label ("primary", "legacy") or a full "owner/name" that is mapped to
  // the namespace. Omit it to target the primary repo. Use `namespaces` to see
  // the mapping.
  const REPO_ARG = "Optional repo selector for a multi-repo namespace: a label (\"primary\", \"legacy\") or a mapped \"owner/name\". Defaults to the primary repo.";

  server.registerTool(
    "list_repo_tree",
    {
      description: "List a directory in a namespace's GitHub repo. Omit path for the repo root. Live GitHub, briefly cached.",
      inputSchema: { namespace: nsName, path: bounded(MAX_PATH).optional(), ref: bounded(MAX_REF).optional(), repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG) },
    },
    ({ namespace, path, ref, repo }) => guarded(() => listRepoTree(env, namespace, path ?? "", ref, repo))
  );

  server.registerTool(
    "read_repo_file",
    {
      description: "Read a file from a namespace's GitHub repo, decoded to text. Optional ref (branch, tag, or sha). Live GitHub, briefly cached.",
      inputSchema: { namespace: nsName, path: bounded(MAX_PATH), ref: bounded(MAX_REF).optional(), repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG) },
    },
    ({ namespace, path, ref, repo }) => guarded(() => readRepoFile(env, namespace, path, ref, repo))
  );

  server.registerTool(
    "search_code",
    {
      description:
        "Case-insensitive substring search across a namespace repo's files. Walks the repo tree and greps blobs server-side (GitHub's code-search index does not serve these private repos over an App token), so scope with path_prefix on large repos. Returns path, line number, and the matching line. When it stops early it sets truncated:true with a note explaining why and a next_start to resume from (or raise max_files); a truncated result is a partial scan, not an empty repo. namespace is required.",
      inputSchema: {
        query: bounded(MAX_QUERY),
        namespace: nsName,
        path_prefix: bounded(MAX_PATH).optional().describe("Only scan files whose path starts with this prefix, e.g. 'app/lib/billing'."),
        ref: bounded(MAX_REF).optional().describe("Branch, tag, or sha to search. Defaults to the default branch."),
        max_results: z.number().int().positive().optional().describe("Cap on returned matches (default 20, max 200)."),
        max_files: z.number().int().positive().optional().describe("Cap on files fetched and scanned (default 200, max 200). A wider sweep resumes with start, because each file costs one GitHub request against the App installation's quota; narrowing path_prefix is cheaper."),
        start: z.number().int().nonnegative().optional().describe("Candidate-file offset to resume a truncated scan; pass the previous result's next_start."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ query, namespace, path_prefix, ref, max_results, max_files, start, repo }) =>
      guarded(() =>
        searchCode(env, namespace, query, {
          pathPrefix: path_prefix,
          ref,
          maxResults: max_results,
          maxFiles: max_files,
          start,
          repoSelector: repo,
        })
      )
  );

  server.registerTool(
    "write_repo_file",
    {
      description:
        "Write a file to a namespace's GitHub repo. mode 'pr' (default) commits to a new branch and opens a PR; mode 'direct' commits straight to the default branch. Requires operator key.",
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH),
        content: bounded(MAX_BODY),
        message: bounded(MAX_COMMIT_MESSAGE),
        mode: z.enum(["pr", "direct"]).optional(),
        branch: bounded(MAX_REF).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, path, content, message, mode, branch, repo }) =>
      guardedWrite("write_repo_file", namespace, path, () =>
        writeRepoFile(env, namespace, path, content, message, mode ?? "pr", branch, repo)
      )
  );

  server.registerTool(
    "create_branch",
    {
      description: "Create a branch in a namespace's GitHub repo. Branches off the default branch unless 'from' is given. Requires operator key.",
      inputSchema: { namespace: nsName, branch: bounded(MAX_REF), from: bounded(MAX_REF).optional(), repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG) },
    },
    ({ namespace, branch, from, repo }) =>
      guardedWrite("create_branch", namespace, null, () => createBranch(env, namespace, branch, from, repo))
  );

  server.registerTool(
    "open_pr",
    {
      description: "Open a pull request in a namespace's GitHub repo. Base defaults to the repo's default branch. Requires operator key.",
      inputSchema: {
        namespace: nsName,
        title: bounded(MAX_PR_TITLE),
        head: bounded(MAX_REF),
        base: bounded(MAX_REF).optional(),
        body: bounded(MAX_PR_BODY).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, title, head, base, body, repo }) =>
      guardedWrite("open_pr", namespace, null, () => openPr(env, namespace, title, head, base, body, repo))
  );

  server.registerTool(
    "delete_repo_file",
    {
      description:
        "Delete a file from a namespace's GitHub repo. mode 'pr' (default) commits the deletion to a new branch and opens a PR; mode 'direct' deletes on the default branch. The file must exist. Requires operator key.",
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH),
        message: bounded(MAX_COMMIT_MESSAGE),
        mode: z.enum(["pr", "direct"]).optional(),
        branch: bounded(MAX_REF).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, path, message, mode, branch, repo }) =>
      guardedWrite("delete_repo_file", namespace, path, () => deleteRepoFile(env, namespace, path, message, mode ?? "pr", branch, repo))
  );

  server.registerTool(
    "manage_pr",
    {
      description:
        "Merge or close an open pull request in a namespace's repo. action 'merge' uses merge_method (default 'squash'); action 'close' just closes it. Merging can trigger CI deploys in repos with deploy workflows (foxhound): prefer PR mode plus manage_pr for anything touching live behavior, per conventions. Requires operator key.",
      inputSchema: {
        namespace: nsName,
        number: z.number().int().positive(),
        action: z.enum(["merge", "close"]),
        merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, number, action, merge_method, repo }) =>
      guardedWrite("manage_pr", namespace, null, () => managePr(env, namespace, number, action, merge_method ?? "squash", repo))
  );

  server.registerTool(
    "ci_status",
    {
      description:
        "Recent CI workflow runs for a namespace's repo (name, head sha, status, conclusion, timestamps). For the most recent failed run it also returns the failing jobs and steps, plus a bounded log tail for write-grant keys only (a read-only key gets the metadata and a note saying the tail was withheld, because job logs can echo ids and variables). Read-only; use it to verify a deploy is green after a merge instead of guessing. Needs the GitHub App's Actions: Read permission.",
      inputSchema: {
        namespace: nsName,
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
        limit: z.number().int().positive().optional().describe("How many recent runs to return (default 10, max 20)."),
      },
    },
    ({ namespace, repo, limit }) => guarded(() => ciStatus(env, namespace, repo, { limit, logTail: operator }))
  );

  // Resources: every document is addressable context at capsid://<namespace>/<path>.
  // Read-only, same visibility as the read tool. The D1 queries run lazily, only
  // when a client actually calls resources/list or resources/read.
  server.registerResource(
    "document",
    new ResourceTemplate("capsid://{namespace}/{+path}", {
      list: async () => {
        const { results } = await db
          .prepare("SELECT namespace, path, title FROM documents ORDER BY namespace, path")
          .all<{ namespace: string; path: string; title: string | null }>();
        return {
          resources: results.map((row) => ({
            uri: `capsid://${row.namespace}/${row.path}`,
            name: `${row.namespace}/${row.path}`,
            title: row.title ?? undefined,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    // Template metadata spreads onto every listed resource, so keep it to
    // fields that are true per document.
    { title: "Capsid documents", mimeType: "text/markdown" },
    async (uri, variables) => {
      const namespace = String(variables.namespace);
      const path = String(variables.path);
      const row = await db
        .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ body: string | null }>();
      if (!row) throw new McpError(ErrorCode.InvalidParams, `not found: ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: row.body ?? "" }] };
    }
  );

  // Prompts: reusable templates stored as type 'prompt' documents whose bodies
  // use {{variable}} placeholders. Handled at the protocol level (McpServer only
  // lists prompts registered at build time) so the D1 query runs lazily, only on
  // prompts/list and prompts/get.
  //
  // A prompt is named "<namespace>/<path without .md>", which is how every other
  // tool in this server addresses a document. It used to be the bare path, and a
  // bare path is not a document key: two namespaces can both hold prompts/brief.md
  // and the lookup ended in `LIMIT 1`, so it would answer with whichever row
  // SQLite reached first and the caller could not tell which one it got. One
  // prompt document exists today, so this collides with nothing yet.
  const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  const promptVariables = (body: string) => [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))];
  server.server.registerCapabilities({ prompts: { listChanged: false } });
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const { results } = await db
      .prepare("SELECT namespace, path, title, body FROM documents WHERE type = 'prompt' ORDER BY namespace, path")
      .all<{ namespace: string; path: string; title: string | null; body: string | null }>();
    return {
      prompts: results.map((row) => ({
        name: `${row.namespace}/${row.path.replace(/\.md$/, "")}`,
        description: row.title ?? undefined,
        arguments: promptVariables(row.body ?? "").map((name) => ({ name, required: true })),
      })),
    };
  });
  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    // Split on the FIRST slash only: the namespace never contains one and the
    // path frequently does.
    const slash = name.indexOf("/");
    if (slash <= 0 || slash === name.length - 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `prompt name must be "<namespace>/<path>", got "${name}". Call prompts/list for the available names.`
      );
    }
    const promptNs = name.slice(0, slash);
    const promptPath = name.slice(slash + 1);
    const row = await db
      .prepare(
        "SELECT title, body FROM documents WHERE type = 'prompt' AND namespace = ?1 AND (path = ?2 OR path = ?2 || '.md')"
      )
      .bind(promptNs, promptPath)
      .first<{ title: string | null; body: string | null }>();
    if (!row) throw new McpError(ErrorCode.InvalidParams, `prompt not found: ${name}`);
    const missing = new Set<string>();
    const text = (row.body ?? "").replace(PLACEHOLDER, (placeholder, variable: string) => {
      const value = args[variable];
      if (value === undefined) {
        missing.add(variable);
        return placeholder;
      }
      return String(value);
    });
    if (missing.size > 0) {
      throw new McpError(ErrorCode.InvalidParams, `missing arguments for prompt ${name}: ${[...missing].join(", ")}`);
    }
    return {
      description: row.title ?? undefined,
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    };
  });

  return server;
}
