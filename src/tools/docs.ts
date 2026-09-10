import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import type { Env } from "../env";
import { parseReposList, REPO_SHAPE, requireSinglePrimary } from "../github";
import { sha256Hex } from "../auth";
import { documentUpsert, guardedCommit, isMissingRowAbort, requireBodyUnchanged, requireExists } from "../store-guards";
import { normalizeDashes } from "../normalize";
import { parseLinks } from "../links";
import { validateDocStatus, validateDocType } from "../doc-meta";
import { bounded, BRIEF_BUDGET, HISTORY_ROWS, MAX_BODY, MAX_DOC_STATUS, MAX_DOC_TYPE, MAX_GLOB, MAX_LINKS_JSON, MAX_QUERY, MAX_REPO_SELECTOR, MAX_REPOS_JSON, MAX_ROWS, MAX_SHA, MAX_TAGS, MAX_TITLE, nsName, SEARCH_ROWS, docPath } from "../limits";
import { assembleBody } from "../write-modes";
import { improveWriteRefusal } from "../improve-scores";
import { concurrentEditWarning } from "../server";

export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Ask for one extra row so "exactly limit" is distinguishable from "there are more".
function boundedRows<T>(rows: T[], limit: number, advice: string) {
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  return {
    count: kept.length,
    limit,
    truncated,
    ...(truncated ? { note: `Returned the first ${limit} rows; there are more. ${advice}` } : {}),
    documents: kept,
  };
}

export function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export const DENIED = "unauthorized: this tool requires a write-grant operator key; read-only (ro:) keys can only use the read tools";

// PATH_MUTATION_HELPER_START
// The only site that mutates documents.path or deletes a documents row.
// document_links stores (ns, path) strings, no FK. newPath null means delete.
// Statement order is positional: rename [0] documents [1] from_path [2] to_path;
// delete [0] document_links [1] documents.
export function pathMutation(
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

async function requireRegisteredNamespace(db: D1Database, namespace: string): Promise<string | null> {
  const row = await db.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(namespace).first();
  if (row) return null;
  return (
    `unknown namespace '${namespace}'. Nothing was written. Documents can only live in a registered namespace, ` +
    `because an unregistered one is invisible to the namespaces list, the lint loop and every repo tool. ` +
    `Check the spelling against the namespaces tool, or create it with register_namespace.`
  );
}

type ConfirmVerdict = "accepted" | "declined" | "unsupported";

// Asks the connected client to confirm a destructive action via MCP elicitation.
// Stateless Streamable HTTP clients usually cannot answer server-initiated requests,
// so "unsupported" is the common case and callers fall back to requiring an explicit
// confirm:true argument.
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

// THE CONFIRMATION BLOCK, ONCE. Four call sites wrote the same three-branch dance
// around confirmDestructive, each with its own wording for the two refusals. The
// messages stay per tool because they are the instruction the caller acts on.
//
// IT REPORTS WHETHER IT ACTUALLY ELICITED. A human who sat through an elicitation
// said "overwrite THIS" about a body read before the prompt went out, and the answer
// can arrive 90 seconds later, so that consent goes stale exactly like an if_match.
// Both write and restore arm the commit-time body guard on it.
//
// Before this returned it, write kept its own `elicited` flag and restore re-derived
// it as `confirm !== true`. Those coincide only because restore always calls this
// helper and this helper returns early when confirm is true.
type ConfirmResult = { ok: true; elicited: boolean } | { ok: false; message: string };

export async function requireConfirmation(
  server: McpServer,
  confirm: boolean | undefined,
  messages: { prompt: string; declined: string; unsupported: string }
): Promise<ConfirmResult> {
  if (confirm === true) return { ok: true, elicited: false };
  const verdict = await confirmDestructive(server, messages.prompt);
  if (verdict === "accepted") return { ok: true, elicited: true };
  return { ok: false, message: verdict === "declined" ? messages.declined : messages.unsupported };
}

// `actor` is the principal recorded on every audit_log row. It replaced a hardcoded
// 'operator' string at all eight audit write sites, which left the column answering
// "what happened" and never "who did it".
//
// Shape: "github:<login>" for an OAuth session, "opkey:<fingerprint>" for an operator
// key. The fingerprint is a 12-char PREFIX of the key's sha256, not the key:
// OPERATOR_KEY_HASH is the verifier, so a full hash in audit_log would copy it into
// the database the audit log holds to account. Rows written before the change keep
// their literal 'operator' value.

// THE GRANT, NOT A BOOLEAN. This was `operator: boolean`, which misread at every call
// site: `buildServer(env, true, ...)` looks like "this is the operator server" when
// it means "this grant may write", and a read-only ro: key IS an operator.
// src/auth.ts already resolves a key to exactly this union.
export type ToolGrant = "write" | "read";

export interface ToolCtx {
  env: Env;
  db: D1Database;
  grant: ToolGrant;
  mayWrite: boolean;
  actor: string;
  lastActor: (ns: string, path: string) => Promise<string | null>;
}

export function registerDocTools(server: McpServer, ctx: ToolCtx): void {
  const { db, mayWrite, actor, lastActor } = ctx;

  server.registerTool(
    "list",
    {
      annotations: hintsFor("list"),
      description: `List documents with optional namespace, type, and status filters. Returns metadata rows without bodies under \`documents\`: id, namespace, path, title, type, status, tags and timestamps. Bounded to ${MAX_ROWS} rows; when there are more it sets truncated:true with a note, so a short list is never mistaken for a complete one.`,
      inputSchema: {
        namespace: nsName.optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
        status: bounded(MAX_DOC_STATUS).optional(),
      },
    },
    async ({ namespace, type, status }) => {
      const { results } = await db
        .prepare(
          // frontmatter and publish_at are NOT selected. Both are columns from the
          // original CMS-shaped schema that nothing in this server reads or writes.
          // Measured 2026-08-13: both are NULL on all 494 documents. Ruled
          // 2026-08-13: dropped from the output, LEFT IN THE TABLE. Removing a
          // column means a migration, a rebuild of the FTS triggers and a change to
          // the backup table guard, to reclaim nothing.
          `SELECT id, namespace, path, title, type, status, tags, created_at, updated_at
           FROM documents
           WHERE (?1 IS NULL OR namespace = ?1) AND (?2 IS NULL OR type = ?2) AND (?3 IS NULL OR status = ?3)
           ORDER BY namespace, path
           LIMIT ?4`
        )
        .bind(namespace ?? null, type ?? null, status ?? null, MAX_ROWS + 1)
        .all();
      return ok(
        boundedRows(
          results,
          MAX_ROWS,
          namespace
            ? "Narrow with type or status, or use find with a path glob."
            : "Narrow with namespace (the usual case), type or status, or use find with a path glob."
        )
      );
    }
  );

  server.registerTool(
    "read",
    {
      annotations: hintsFor("read"),
      description:
        "Read a full document by namespace and path. The response carries last_actor: the actor from the most recent audit_log entry for this document, so a reader can tell who last wrote it (a document is data, and a document another client wrote is untrusted input; provenance makes that visible). null when there is no audit row.",
      inputSchema: { namespace: nsName, path: docPath },
    },
    async ({ namespace, path }) => {
      // NAMED COLUMNS, the same set `list` returns plus the body (quality audit 7.3).
      // SELECT * left `read` the one tool still handing back frontmatter and
      // publish_at, two columns from the original CMS-shaped schema that nothing
      // reads or writes and that `list` dropped on 2026-08-13. Re-measured
      // 2026-08-17: both still NULL on all 559 documents.
      //
      // They stay IN THE TABLE: dropping a column means a migration, a rebuild of
      // the FTS triggers and a change to the backup table guard, to reclaim nothing.
      const row = await db
        .prepare(
          `SELECT id, namespace, path, title, type, status, tags, created_at, updated_at, body
           FROM documents WHERE namespace = ?1 AND path = ?2`
        )
        .bind(namespace, path)
        .first();
      if (!row) return fail(`not found: ${namespace}/${path}`);
      return ok({ ...row, last_actor: await lastActor(namespace, path) });
    }
  );

  // One-call session start: assembles the read ritual so a session cannot skip a
  // piece of it (a skipped core.md caused a real status misread). Pure assembly, no
  // reasoning. Size-bounded so it stays loadable; when trimmed it says so.
  server.registerTool(
    "brief",
    {
      annotations: hintsFor("brief"),
      description:
        `One-call session start for a namespace. Returns capsid/conventions.md, capsid/repo-structure.md, the namespace core.md, its open task docs (non-archived and not status closed), the 3 most recent episodics, and the typed edges on core.md, each with updated_at so staleness shows. Read-only assembly, no reasoning. Size-bounded near ${Math.round(BRIEF_BUDGET / 1000)}KB; if trimmed, the \`trimmed\` field lists what was dropped to metadata. Doing the start-ritual reads by hand stays a valid fallback.`,
      inputSchema: { namespace: nsName },
    },
    async ({ namespace }) => {
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
      // editorial state and does not mark a task done, so filtering on 'published'
      // hid 21 of 32 non-archived task docs. archive/ is the only exclusion.
      //
      // The four remaining reads run TOGETHER (quality audit 9.5). They were four
      // sequential awaits on the call every session makes first. None depends on
      // another's result and the trim arithmetic below needs all four.
      const [openTasksResult, recentEpisodicsResult, coreOutResult, coreInResult] = await Promise.all([
        db
          .prepare(
            // The closure predicate below is the ONLY status filter in this query,
            // and it is not a return of the bug 94b8528 fixed. That one filtered on
            // status = published and hid 21 of 32 task docs. This excludes exactly
            // one value, set deliberately to mean finished. status is NOT NULL, so
            // the comparison cannot swallow a row via NULL semantics.
            //
            // test/doc-meta.test.ts asserts this predicate appears exactly ONCE in
            // this file, so the lint loop can never grow one. Only the archive/
            // prefix takes a document out of memory.
            "SELECT namespace, path, title, type, body, updated_at FROM documents WHERE namespace = ?1 AND type = 'task' AND status != 'closed' AND path NOT LIKE 'archive/%' ORDER BY updated_at DESC"
          )
          .bind(namespace)
          .all<{ namespace: string; path: string; title: string | null; type: string | null; body: string | null; updated_at: string }>(),
        db
          .prepare(
            "SELECT namespace, path, title, type, body, updated_at FROM documents WHERE namespace = ?1 AND type = 'episodic' AND path NOT LIKE 'archive/%' ORDER BY created_at DESC LIMIT 3"
          )
          .bind(namespace)
          .all<{ namespace: string; path: string; title: string | null; type: string | null; body: string | null; updated_at: string }>(),
        db
          .prepare("SELECT type, to_ns, to_path FROM document_links WHERE from_ns = ?1 AND from_path = 'core.md' ORDER BY type, to_ns, to_path")
          .bind(namespace)
          .all(),
        db
          .prepare("SELECT type, from_ns, from_path FROM document_links WHERE to_ns = ?1 AND to_path = 'core.md' ORDER BY type, from_ns, from_path")
          .bind(namespace)
          .all(),
      ]);
      const openTasks = openTasksResult.results;
      const recentEpisodics = recentEpisodicsResult.results;
      const coreOut = coreOutResult.results;
      const coreIn = coreInResult.results;

      // PROVENANCE on every document in the packet (audit 2026-09-06). Attached after
      // the reads rather than joined in, so each documents SELECT stays a plain
      // projection. A poisoned task or core.md is instructions at turn 0; last_actor
      // is how a session tells the operator's own writing from another client's.
      type Actored<T> = T & { last_actor: string | null };
      const withActor = async <T extends { namespace: string; path: string }>(row: T | null): Promise<(Actored<T>) | null> =>
        row ? { ...row, last_actor: await lastActor(row.namespace, row.path) } : null;
      const withActors = async <T extends { namespace: string; path: string }>(rows: T[]): Promise<Actored<T>[]> =>
        Promise.all(rows.map((r) => withActor(r) as Promise<Actored<T>>));
      const [conventionsA, repoStructureA, coreA, openTasksA, recentEpisodicsA] = await Promise.all([
        withActor(conventions),
        withActor(repoStructure),
        withActor(core),
        withActors(openTasks),
        withActors(recentEpisodics),
      ]);

      // Stay under budget by trimming the largest, most re-readable sections to
      // metadata first (episodics, then task bodies), and report what was cut.
      type Row = { namespace: string; path: string; title: string | null; body: string | null; updated_at: string; last_actor?: string | null };
      const bodyChars = (rows: Row[]) => rows.reduce((sum, r) => sum + (r.body?.length ?? 0), 0);
      const toStub = (rows: Row[]) =>
        rows.map((r) => ({ namespace: r.namespace, path: r.path, title: r.title, updated_at: r.updated_at, last_actor: r.last_actor ?? null, body: `(trimmed for size: read ${r.namespace}/${r.path})` }));
      const trimmed: string[] = [];
      let total =
        (conventionsA?.body?.length ?? 0) +
        (repoStructureA?.body?.length ?? 0) +
        (coreA?.body?.length ?? 0) +
        bodyChars(openTasksA as Row[]) +
        bodyChars(recentEpisodicsA as Row[]);
      let episodicsOut: unknown[] = recentEpisodicsA;
      let tasksOut: unknown[] = openTasksA;
      if (total > BRIEF_BUDGET) {
        total -= bodyChars(recentEpisodicsA as Row[]);
        episodicsOut = toStub(recentEpisodicsA as Row[]);
        trimmed.push(`${recentEpisodicsA.length} episodic bodies`);
      }
      if (total > BRIEF_BUDGET) {
        total -= bodyChars(openTasksA as Row[]);
        tasksOut = toStub(openTasksA as Row[]);
        trimmed.push(`${openTasksA.length} task bodies`);
      }

      return ok({
        namespace,
        conventions: conventionsA,
        repo_structure: repoStructureA,
        core: coreA,
        open_tasks: tasksOut,
        recent_episodics: episodicsOut,
        core_links: { outgoing: coreOut, incoming: coreIn },
        approx_chars: total,
        ...(coreA ? {} : { warning: `no core.md for namespace ${namespace}` }),
        ...(trimmed.length ? { trimmed } : {}),
      });
    }
  );

  server.registerTool(
    "write",
    {
      annotations: hintsFor("write"),
      description:
        "Create or update a document. Snapshots the prior version and writes an audit log entry. mode selects how body is applied: 'replace' (default, full body, needs title and body), 'append' (body is added to the end of the existing document, no title needed, no confirmation needed because nothing is overwritten), 'patch' (replace an anchored region: needs find and replace_with, and find must occur EXACTLY ONCE or the write is refused), or 'meta' (change type, tags, status or title and leave the body byte-identical, normalization included; use this to close a task or correct a document's type). append, patch and meta exist so amending a large document does not mean retranscribing it. Every response carries sha256 and bytes of the resulting body, so a write can be verified without reading the document back. Optional if_match: the sha256 of the body you believe is stored (the value a previous read-back or write returned). When it does not match the stored body the write is REFUSED and the error carries the current sha256, so a concurrent edit cannot be silently overwritten. Overwriting with replace or patch needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Optional links: a JSON array of typed outgoing edges [{\"type\":\"references\",\"to_path\":\"decisions.md\",\"to_ns\":\"capsid\"}] (types: governs, references, supersedes, replaces, depends-on; to_ns defaults to this namespace). When provided it replaces this document's outgoing edges; omit it to leave edges untouched; pass [] to clear them. Read edges with backlinks.",
      inputSchema: {
        namespace: nsName,
        path: docPath,
        // title and body are required for mode 'replace' and validated as such below.
        // They are optional in the schema because append needs no title and patch
        // needs neither. Requiring them here would force a caller to resupply a title
        // it is not changing, which is the retranscription this mode removes.
        title: bounded(MAX_TITLE).optional(),
        body: bounded(MAX_BODY).optional(),
        mode: z.enum(["replace", "append", "patch", "meta"]).optional(),
        find: bounded(MAX_BODY).optional(),
        replace_with: bounded(MAX_BODY).optional(),
        type: bounded(MAX_DOC_TYPE).optional(),
        tags: bounded(MAX_TAGS).optional(),
        status: bounded(MAX_DOC_STATUS).optional(),
        confirm: z.boolean().optional(),
        links: bounded(MAX_LINKS_JSON).optional(),
        if_match: bounded(MAX_SHA).optional(),
        // Opt-in to writing the improve loop's control surface (improve/prompts/,
        // improve/skills/, or the Anchors block of improve/scores.md). Refused
        // without it; audit-logged with it. See improveWriteRefusal.
        allow_improve_paths: z.boolean().optional(),
      },
    },
    async ({ namespace, path, title, body, mode, find, replace_with, type, tags, status, confirm, links, if_match, allow_improve_paths }) => {
      if (!mayWrite) return fail(DENIED);
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

      // OPTIMISTIC CONCURRENCY. if_match is the sha256 of the body the caller believes
      // is stored, which is the value every write already returns, so a client that
      // read or wrote the document has it without an extra fetch.
      //
      // conventions.md's "re-read a document immediately before overwriting it" is a
      // discipline the server could not enforce. It fired live on 2026-07-27 when a
      // session doc was rewritten between a read and a planned write. A lost update
      // leaves no trace in the result: the write succeeds, the prior body is
      // snapshotted, and nothing says anything went wrong.
      //
      // Fail closed, the same shape as a patch anchor: on mismatch NOTHING is written
      // and the error carries the CURRENT sha so the caller can rebase and retry.
      // Opt-in, because requiring it would break append, which is safe by
      // construction.
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

      // Body assembly, per mode. Pure and unit-tested in ./write-modes. All FOUR modes
      // return the FULL new body, so the write path below is unchanged and both
      // invariants (version snapshot, audit row) apply identically. meta returns the
      // stored body BYTE-IDENTICAL, which is its contract, and is the one mode the
      // dash normalizer below is skipped for.
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

      // Normalize wide dashes server-side so no client can store an em dash, whether
      // or not the Claude Code hook ran. See ./normalize. This runs AFTER assembly so
      // append and patch content is normalized too, which is the gap the hand-run SQL
      // splice had.
      if (title !== undefined) title = normalizeDashes(title, "title");
      // mode 'meta' does not touch the body, so the body is not normalized either.
      // THE CONTRACT IS: meta leaves the stored body byte-identical. Bodies stored
      // before the normalizer existed can still carry a wide dash, and a meta write
      // closing a task would then rewrite prose it was never asked to change, with
      // bytes_before != bytes as the only hint. conventions.md also forbids editing
      // already-stored content to satisfy the dash rule. Everything a caller supplies
      // still goes through the normalizer.
      if (writeMode !== "meta") body = normalizeDashes(body as string, "prose");

      // IMPROVE CONTROL-SURFACE GUARD (audit 2026-09-06). Computed on the final
      // assembled and normalized body, so it sees exactly what would be stored: a
      // patch or append that ends up changing scores.md's anchor block is caught the
      // same as a full replace. Refused unless allow_improve_paths was passed.
      const improveRefusal = await improveWriteRefusal(namespace, path, prior?.body ?? null, body as string, allow_improve_paths === true);
      if (improveRefusal) return fail(improveRefusal);

      // append is exempt from confirmation. Confirmation exists to stop an accidental
      // clobber of existing text, and an append destroys none: the prior body is still
      // snapshotted and the addition goes after it. Requiring a confirm here would put
      // more friction on the safe operation than on the dangerous one. patch and
      // replace both mutate existing text and are NOT exempt.
      //
      // `elicited` is whether a human answered a prompt, reported by the helper rather
      // than inferred here. It arms the commit-time body guard; why that consent goes
      // stale is stated once, on requireConfirmation.
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
        // SNAPSHOT FROM THE LIVE ROW, INSIDE THE BATCH (audit 2026-09-06, Grok MAJOR
        // 20 / 4.1b). Binding the pre-read body filed what this handler had READ, not
        // what the table HELD at commit: on an unguarded update, a body written in
        // the gap was overwritten while the snapshot recorded its predecessor. The
        // SELECT runs in the same transaction as the overwrite.
        statements.push(
          db
            .prepare(
              `INSERT INTO document_versions (document_id, namespace, path, title, body)
               SELECT id, namespace, path, title, body FROM documents WHERE namespace = ?1 AND path = ?2`
            )
            .bind(namespace, path)
        );
      }
      statements.push(documentUpsert(db, namespace, path, title ?? null, body, type ?? null, tags ?? null, status ?? null));
      // The PRIOR type, status, tags and title go into the audit params whenever a
      // write changes any of them, and this is the only place they survive.
      // document_versions snapshots title and body ONLY, so a meta write that retyped
      // a document or closed a task was previously unrecoverable. Ruled 2026-08-13:
      // the snapshot schema stays title plus body and the audit log carries the
      // metadata delta, because widening a version row would mean a migration plus a
      // rewrite of every restore path to answer a question the log already answers.
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
              ...(allow_improve_paths === true ? { allow_improve_paths: true } : {}),
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
      // The warning is computed from a read taken HERE, not from the pre-read at the
      // top of the handler. Between those two points this handler may have sat in a 90
      // second elicitation, which is when a racing write is most likely to have
      // landed. Reading it late costs one SELECT.
      const atCommit = prior
        ? await db
            .prepare("SELECT updated_at FROM documents WHERE namespace = ?1 AND path = ?2")
            .bind(namespace, path)
            .first<{ updated_at: string }>()
        : null;
      const conflict = await commit.run(elicited, statements);
      if (conflict) return fail(conflict);
      // Warn, do not reject, when an edge points at a document that does not exist.
      // Rejecting would block asserting an edge before its target is written, and a
      // silent dangling edge is how 23 of them accumulated before 2026-08-10.
      //
      // The second reason, that edges may address repo files, was withdrawn
      // 2026-08-17: an edge has nowhere to put a repo or a ref. The endpoint grammar
      // is enforced in parseLinks. The lint loop reports these per namespace; this is
      // the same check at the moment the edge is created.
      let danglingTargets: string[] = [];
      if (parsedLinks && "edges" in parsedLinks && parsedLinks.edges.length > 0) {
        // This read runs AFTER the commit, so a failure here must not be reported as a
        // failed write: the document is stored. Same shape as the audit warning in
        // guardedWrite (F17).
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
        } catch {
          // A failed dangling-edge read cannot fail a write that already committed.
        }
      }
      // The read-back: sha256 and byte length of the body now stored, so a caller can
      // verify the write landed WITHOUT fetching the document and comparing it by eye.
      // That second read was itself a transcription, and the correlated-transcription
      // risk fired twice on 2026-08-07.
      //
      // Hash the assembled body rather than re-selecting it: re-selecting would be the
      // extra read this avoids, and D1 returns exactly what was bound.
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

  // Every overwrite and delete has snapshotted the prior row into document_versions
  // since the beginning, and until 2026-08-13 nothing could read it back. The rows
  // were reachable only by raw SQL: the 2026-08-10 edge repair read snapshots
  // directly, and recova/parity/INVENTORY-SEED.md is STILL unrestored while surviving
  // as a 7889-byte snapshot.
  server.registerTool(
    "history",
    {
      annotations: hintsFor("history"),
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
        // namespace and path are part of the lookup on purpose: an id alone would let
        // a caller walk every snapshot in the store by incrementing a number.
        if (!row) return fail(`no version ${version_id} for ${namespace}/${path}`);
        return ok({ ...row, bytes: new TextEncoder().encode(row.body ?? "").length });
      }
      const { results } = await db
        .prepare(
          // Bounded (audit 2026-09-06): retention is 90 days, so HISTORY_ROWS covers
          // more than a snapshot a day. Without a LIMIT this returned every snapshot
          // ever taken of a hot document in one response.
          `SELECT id, snapshot_at, title, LENGTH(body) AS bytes
           FROM document_versions
           WHERE namespace = ?1 AND path = ?2
           ORDER BY snapshot_at DESC, id DESC
           LIMIT ?3`
        )
        .bind(namespace, path, HISTORY_ROWS)
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
      annotations: hintsFor("restore"),
      description:
        "Restore a document's title and body from one of its retained versions (see history). It carries the same two write-path invariants as write: the CURRENT body is snapshotted to document_versions first and the restore is appended to audit_log, so a restore is itself undoable. It is NOT the write tool's code path and differs from it deliberately: the snapshotted bytes go back exactly as they were stored, with no dash normalization, and type, status, tags and links are neither validated nor restored, because a version row does not carry them. Restoring a deleted document recreates it. Optional if_match: the sha256 of the body you believe is live now, enforced as a commit-time predicate, so a restore cannot land on a body that changed after you read it. Requires operator key and confirm: true.",
      inputSchema: {
        namespace: nsName,
        path: docPath,
        version_id: z.number().int().positive(),
        confirm: z.boolean().optional(),
        if_match: bounded(MAX_SHA).optional(),
        allow_improve_paths: z.boolean().optional(),
      },
    },
    async ({ namespace, path, version_id, confirm, if_match, allow_improve_paths }) => {
      if (!mayWrite) return fail(DENIED);
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
      // THE IMPROVE CONTROL-SURFACE GUARD, on restore too (audit 2026-09-07, Opus
      // MAJOR 5.4). The guard shipped on `write` alone, so restoring
      // improve/prompts/run.md to an earlier version installed an older system prompt
      // for the nightly attempt generator with no flag and no marked audit row. Same
      // call shape as write: what is stored now, against what would be stored.
      const restoreImproveRefusal = await improveWriteRefusal(
        namespace,
        path,
        prior?.body ?? null,
        version.body ?? "",
        allow_improve_paths === true
      );
      if (restoreImproveRefusal) return fail(restoreImproveRefusal);
      // The same protocol the write tool runs, with restore's wordings. On the
      // recreate path the guard is the ABSENCE of a row: the snapshot statement is
      // only added when the pre-read saw one, so a racing create would otherwise be
      // overwritten with nothing kept.
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
      // The stored body goes back EXACTLY as snapshotted, with no dash normalization.
      // A snapshot is a record of what the document said.
      const body = version.body ?? "";
      const statements: D1PreparedStatement[] = [];
      if (prior) {
        // SNAPSHOT FROM THE LIVE ROW, INSIDE THE BATCH (audit 2026-09-07, Grok MAJOR
        // 10). write and delete were fixed on 2026-09-06 and restore was not, so this
        // was the last write path binding the body this handler had READ rather than
        // what the table HELD at commit. Restore elicits a confirmation, so the gap
        // could be the full 90 second prompt. The SELECT runs in the same transaction
        // as the overwrite.
        statements.push(
          db
            .prepare(
              `INSERT INTO document_versions (document_id, namespace, path, title, body)
               SELECT id, namespace, path, title, body FROM documents WHERE namespace = ?1 AND path = ?2`
            )
            .bind(namespace, path)
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
      annotations: hintsFor("backlinks"),
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
      annotations: hintsFor("delete"),
      description: "Delete a document. Snapshots it first and writes an audit log entry. Needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true.",
      inputSchema: { namespace: nsName, path: docPath, confirm: z.boolean().optional(), allow_improve_paths: z.boolean().optional() },
    },
    async ({ namespace, path, confirm, allow_improve_paths }) => {
      if (!mayWrite) return fail(DENIED);
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      if (!prior) return fail(`not found: ${namespace}/${path}`);
      // THE IMPROVE CONTROL-SURFACE GUARD, on delete too (audit 2026-09-07, Opus MAJOR
      // 5.4). Removing improve/prompts/run.md drops the loop back to the hardcoded
      // default prompt and removing a skill retires it, so a delete is a steering
      // change even though it installs nothing. The "" is the resulting body: for the
      // two prefixes that is a prefix match, and for scores.md an anchor block going
      // from something to nothing.
      const deleteImproveRefusal = await improveWriteRefusal(
        namespace,
        path,
        prior.body,
        "",
        allow_improve_paths === true
      );
      if (deleteImproveRefusal) return fail(deleteImproveRefusal);
      const deleteRefusal = await requireConfirmation(server, confirm, {
        prompt: `Delete ${namespace}/${path}? It will be snapshotted to document_versions first, so it can be recovered.`,
        declined: `delete of ${namespace}/${path} declined`,
        unsupported: `confirmation required: re-run delete with confirm: true to remove ${namespace}/${path}. It will be snapshotted to document_versions first.`,
      });
      if (!deleteRefusal.ok) return fail(deleteRefusal.message);
      const elicited = deleteRefusal.elicited;
      // Read the edges before pathMutation removes them: the audit row is the only
      // place they survive, since document_versions holds title and body only.
      const { results: removedEdges } = await edgesTouching(db, namespace, path).all();
      // The guard is not redundant with the `prior` read above: that read is a separate
      // transaction, and a delete matching zero rows would otherwise snapshot a body,
      // write an audit row saying 'delete', and answer "deleted" having removed
      // nothing. AFTER AN ELICITATION the guard is the body one (audit 2026-09-06,
      // Grok 4.1b): the human consented to deleting the body they were shown, so a
      // body written in that window must abort the delete. The snapshot itself SELECTs
      // the live row inside the batch; see the write handler.
      try {
        await db.batch([
          elicited ? requireBodyUnchanged(db, namespace, path, prior.body) : requireExists(db, namespace, path),
          db
            .prepare(
              `INSERT INTO document_versions (document_id, namespace, path, title, body)
               SELECT id, namespace, path, title, body FROM documents WHERE namespace = ?1 AND path = ?2`
            )
            .bind(namespace, path),
          ...pathMutation(db, namespace, path, null),
          db
            .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'delete', ?2, ?3, ?4)")
            .bind(actor, namespace, path, JSON.stringify({ edges_removed: removedEdges })),
        ]);
      } catch (err) {
        if (isMissingRowAbort(err)) {
          return fail(
            elicited
              ? `delete aborted, nothing changed: ${namespace}/${path} changed or was removed while the confirmation was open. Re-read it and try again.`
              : `delete aborted, nothing changed: ${namespace}/${path} no longer exists. Another session removed it after this call started.`
          );
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
      annotations: hintsFor("move"),
      description: "Rename a document path within its namespace, repointing every typed edge that touches it. Audit logged. Needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true. Requires operator key.",
      inputSchema: { namespace: nsName, path: docPath, new_path: docPath, confirm: z.boolean().optional(), allow_improve_paths: z.boolean().optional() },
    },
    async ({ namespace, path, new_path, confirm, allow_improve_paths }) => {
      if (!mayWrite) return fail(DENIED);
      const nsError = await requireRegisteredNamespace(db, namespace);
      if (nsError) return fail(nsError);
      // Existence and the edge count are both read BEFORE the batch. D1's meta.changes
      // cannot be used for either: documents carries FTS5 sync triggers, so an UPDATE
      // reports the trigger's row changes too, and in a batch those accumulate across
      // statements. Measured 2026-08-10, when the batch reported 5 edges repointed for
      // a single edge.
      const exists = await db
        .prepare("SELECT 1 AS ok FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ ok: number }>();
      if (!exists) return fail(`not found: ${namespace}/${path}`);
      // THE IMPROVE CONTROL-SURFACE GUARD, BOTH ENDS (audit 2026-09-07, Opus MAJOR
      // 5.4). A move touches two paths and either can steer the loop: moving a document
      // INTO improve/skills/ installs a skill other namespaces' runs re-inject, and
      // moving run.md OUT of improve/prompts/ drops the attempt generator to its
      // hardcoded default. Checked as what each path ends up holding: the source is
      // emptied, the destination is filled with the moved body.
      const moved = await db
        .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ body: string | null }>();
      const movedBody = moved?.body ?? "";
      for (const [checkPath, before, after] of [
        [path, movedBody, ""],
        [new_path, null, movedBody],
      ] as Array<[string, string | null, string]>) {
        const refusal = await improveWriteRefusal(namespace, checkPath, before, after, allow_improve_paths === true);
        if (refusal) return fail(refusal);
      }
      // move JOINS the confirmation as of 2026-08-17 (audit 2, F25 ruling). It is
      // destructive-class and had none: it renames a document and repoints every edge
      // touching it, and unlike delete it leaves no snapshot of the old path, only an
      // audit row.
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
      // The audit INSERT used to run as its own statement after the batch, which made
      // two failures possible that the log could not then describe: a move that
      // succeeded with no record, and a record of a move that never happened. The
      // 2026-08-10 edge repair recovered five repoints from audit_log move records.
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
      annotations: hintsFor("find"),
      description: `Find documents whose path matches a glob pattern (SQLite GLOB, e.g. 'notes/*.md'). Optional namespace filter. Returns matches under \`documents\`, bounded to ${MAX_ROWS} rows; when there are more it sets truncated:true with a note.`,
      inputSchema: { namespace: nsName.optional(), glob: bounded(MAX_GLOB) },
    },
    async ({ namespace, glob }) => {
      const { results } = await db
        .prepare(
          `SELECT namespace, path, title, type, status, updated_at
           FROM documents
           WHERE path GLOB ?1 AND (?2 IS NULL OR namespace = ?2)
           ORDER BY namespace, path
           LIMIT ?3`
        )
        .bind(glob, namespace ?? null, MAX_ROWS + 1)
        .all();
      return ok(boundedRows(results, MAX_ROWS, "Tighten the glob, or add a namespace filter."));
    }
  );

  server.registerTool(
    "search",
    {
      annotations: hintsFor("search"),
      description: `Full text search across all documents (FTS5, ranked by bm25). Optional namespace and type filters. This is the cross-project search. Returns the top ${SEARCH_ROWS} matches under \`documents\`; when more matched it sets truncated:true, so a full page of hits is never mistaken for the whole answer.`,
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
             LIMIT ?4`
          )
          .bind(match, namespace ?? null, type ?? null, SEARCH_ROWS + 1)
          .all();
      const bound = (rows: unknown[]) =>
        boundedRows(rows, SEARCH_ROWS, "Add a namespace or type filter, or make the query more specific.");
      try {
        return ok(bound((await run(query)).results));
      } catch {
        // Hyphens, quotes, and bare AND/OR/NOT are FTS5 syntax. Retry the whole query
        // as a quoted phrase so plain text is always a safe input.
        try {
          return ok(bound((await run(`"${query.replace(/"/g, '""')}"`)).results));
        } catch (err) {
          return fail(`search failed (check FTS5 query syntax): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  );

  server.registerTool(
    "namespaces",
    {
      annotations: hintsFor("namespaces"),
      description: "List all namespaces and the repos each maps to.",
      inputSchema: {},
    },
    async () => {
      // unconsolidated = episodic and source docs not yet archived by the lint loop,
      // surfaced so every session sees which namespaces need a run. Deliberately NOT
      // filtered on status: this counted only status 'published' until 2026-07-30 and
      // read 2 for recova against a real backlog of 24. The archive/ prefix is the only
      // thing that takes a doc out of the loop.
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

  // Register a namespace: the one row in the namespaces table that repo tools and the
  // namespaces list read. Writing documents to a new namespace label does not create
  // it, so without this a namespace was a raw D1 insert. Create-only: it will not
  // overwrite an existing mapping. Requires an operator key.
  server.registerTool(
    "register_namespace",
    {
      annotations: hintsFor("register_namespace"),
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
      if (!mayWrite) return fail(DENIED);
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
      // 2026-08-13. It was enforced on the update path only, so register could create
      // a namespace with two primaries or none, which every repo tool then resolves by
      // accident, and update would refuse to fix it in place.
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

  // Remap an existing namespace's repos. register_namespace stays the create path;
  // this is the update path the recova remap needed, previously a raw D1 UPDATE that
  // bypassed the audit log. Snapshots the prior mapping. It does NOT rename the
  // namespace: a rename touches document keys, versions and audit history.
  server.registerTool(
    "update_namespace",
    {
      annotations: hintsFor("update_namespace"),
      description:
        "Remap an existing namespace's repos. Pass repos as a JSON array like [{\"repo\":\"owner/name\",\"label\":\"primary\"},{\"repo\":\"owner/legacy\",\"label\":\"legacy\"}], with exactly one entry labeled \"primary\". The namespace must already exist (use register_namespace to create). Snapshots the prior mapping to the audit log. Does NOT rename the namespace or move its documents. Requires operator key.",
      inputSchema: { namespace: nsName, repos: bounded(MAX_REPOS_JSON) },
    },
    async ({ namespace, repos }) => {
      if (!mayWrite) return fail(DENIED);
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
}
