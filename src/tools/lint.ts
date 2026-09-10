import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { repoBlobPaths } from "../github";
import { isMissingRowAbort, requireExists } from "../store-guards";
import { authoritativeFor, scanCountClaims } from "../counts";
import { buildTruthReport, renderTruthReport, reportPath, type ReportDoc, type ReportEdge } from "../truth-report";
import { docPath, GATHER_BUDGET, LINT_CONSUMED_MAX, nsName } from "../limits";
import { improveWriteRefusal } from "../improve-scores";
import { DENIED, fail, ok, pathMutation, requireConfirmation, type ToolCtx } from "./docs";

export function registerLintTools(server: McpServer, ctx: ToolCtx): void {
  const { env, db, mayWrite, actor } = ctx;

  // Consolidation loop (the LLM Wiki maintenance step). The Worker does no
  // reasoning: a capable client calls gather, synthesizes the update with the
  // existing read/write tools, then calls finalize to archive what it consumed.
  server.registerTool(
    "lint",
    {
      annotations: hintsFor("lint"),
      description:
        "Consolidation loop and truth report for a namespace. mode 'gather' (default, read-only) returns the packet a driving LLM needs to compile the wiki: current core.md, the concept and decision docs, every unconsolidated episodic and source doc, and the capsid schema and conventions rules. After writing the updated core.md and concept docs via write, call mode 'finalize' with consumed: the episodic/source paths that were compiled. Finalize moves them under archive/ (never deletes, never touches core or concept docs) and writes one audit row. mode 'report' measures the store instead of compiling it: documents by type, contradictions (prose asserting a number the artifact disagrees with), stale decisions, unbound specs, broken links, and doc-vs-code drift (a repo path named in canon that is no longer in the repo), plus ONE integrity percentage. It STORES the result as <namespace>/reports/lint-<date>.md so the trend is a document, and improve_status surfaces the latest number per namespace. A check that could not run is excluded from integrity rather than counted as clean. finalize and report require operator key; finalize also requires confirmation, elicited when the client supports it, otherwise pass confirm: true.",
      inputSchema: {
        namespace: nsName,
        mode: z.enum(["gather", "finalize", "report"]).optional(),
        // Bounded (audit 2026-09-06): the finalize batch spends four statements
        // per path plus one audit row, and D1 caps a batch at 100 statements.
        // The bound keeps the archive one atomic batch; see LINT_CONSUMED_MAX.
        consumed: z.array(docPath).max(LINT_CONSUMED_MAX).optional(),
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
        // BOUNDED, not merely measured. This used to compute a size and WARN over
        // 150KB, which is not a bound: the packets measured over it routinely
        // (recova 213KB, dustinedwards 330KB on 2026-08-17), so the warning fired
        // on the normal case and the response was oversized anyway.
        //
        // Trim order follows what gather is FOR. The client needs core (the thing
        // being updated), the unconsolidated docs (the input being compiled), and
        // the wiki (current state). The wiki is the largest section and the most
        // re-readable one document at a time, so it stubs first. Unconsolidated
        // bodies are held back last, oldest kept, because oldest-first is both the
        // compile order and the batching advice this tool already gives.
        //
        // core and rules are never trimmed: they are the rules of the job.
        type PacketRow = { namespace?: unknown; path?: unknown; body?: unknown };
        const bodyChars = (row: unknown) => String((row as PacketRow | null)?.body ?? "").length;
        const sumChars = (rows: unknown[]) => rows.reduce<number>((sum, r) => sum + bodyChars(r), 0);
        const toStub = (row: unknown) => {
          const r = row as PacketRow;
          return { ...(row as object), body: `(trimmed for size: read ${String(r.namespace)}/${String(r.path)})` };
        };

        const trimmed: string[] = [];
        const fixed = bodyChars(core) + sumChars(rules.results);
        let wikiOut: unknown[] = wiki.results;
        if (fixed + sumChars(wiki.results) + sumChars(raw.results) > GATHER_BUDGET) {
          wikiOut = wiki.results.map(toStub);
          trimmed.push(`${wiki.results.length} wiki bodies (concept and decision docs; read them individually by path)`);
        }

        // Keep whole documents, never half a body: a truncated markdown document
        // is worse than an honest stub, because the client cannot tell it is
        // reading a fragment.
        let running = fixed + sumChars(wikiOut);
        let heldBack = 0;
        const unconsolidatedOut = raw.results.map((row) => {
          if (running + bodyChars(row) <= GATHER_BUDGET) {
            running += bodyChars(row);
            return row;
          }
          heldBack++;
          return toStub(row);
        });
        if (heldBack > 0) {
          trimmed.push(
            `${heldBack} of ${raw.results.length} unconsolidated bodies (the oldest were kept, which is the compile order; finalize this batch and call gather again for the rest)`
          );
        }
        const packetChars = fixed + sumChars(wikiOut) + sumChars(unconsolidatedOut);
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
          wiki: wikiOut,
          unconsolidated: unconsolidatedOut,
          rules: rules.results,
          dangling_edges: danglingEdges.results,
          authoritative_counts: authoritativeFor(namespace),
          count_claims: countClaims,
          packet_chars: packetChars,
          budget: GATHER_BUDGET,
          truncated: trimmed.length > 0,
          ...(trimmed.length ? { trimmed } : {}),
        });
      }

      if (!mayWrite) return fail(DENIED);

      // ---- mode "report": measure the store rather than compile it ----------
      //
      // WRITE-GATED because it produces a document. The trend is the whole point
      // (capsid/conventions.md: a number that lives only here can be wrong
      // forever and nothing notices), and a trend needs something written down.
      // One document per namespace per day: a second run the same date overwrites
      // rather than accumulating, so the series is daily rather than
      // per-invocation.
      if (mode === "report") {
        const now = new Date();
        const docs = await db
          .prepare(
            `SELECT path, type, status, title, body, updated_at FROM documents
             WHERE namespace = ?1 ORDER BY path`
          )
          .bind(namespace)
          .all<ReportDoc>();
        const edges = await db
          .prepare(
            `SELECT from_ns, from_path, type, to_ns, to_path FROM document_links
             WHERE from_ns = ?1 OR to_ns = ?1`
          )
          .bind(namespace)
          .all<ReportEdge>();
        const dangling = await db
          .prepare(
            `SELECT l.from_ns, l.from_path, l.type, l.to_ns, l.to_path,
                    CASE WHEN f.id IS NULL THEN 1 ELSE 0 END AS source_missing,
                    CASE WHEN t.id IS NULL THEN 1 ELSE 0 END AS target_missing
             FROM document_links l
             LEFT JOIN documents f ON f.namespace = l.from_ns AND f.path = l.from_path
             LEFT JOIN documents t ON t.namespace = l.to_ns AND t.path = l.to_path
             WHERE (f.id IS NULL OR t.id IS NULL)
               AND (l.from_ns = ?1 OR l.to_ns = ?1)`
          )
          .bind(namespace)
          .all<ReportEdge>();
        // The count-claim scan wants standing documents only, same as gather.
        const claims = scanCountClaims(
          docs.results.filter((d) => !d.path.startsWith("archive/")).map((d) => ({ path: d.path, type: d.type, body: d.body })),
          namespace
        );
        // NULL, NOT AN EMPTY SET, when the tree cannot be read. An empty set would
        // report every path the canon names as drift, which is a worse answer than
        // not looking; buildTruthReport excludes the check from integrity instead.
        const repoPaths = (await repoBlobPaths(env, namespace)) ?? undefined;

        const report = buildTruthReport({
          namespace,
          now,
          docs: docs.results,
          edges: edges.results,
          danglingEdges: dangling.results,
          countClaims: claims.map((c) => ({ path: c.path, noun: c.noun, states: c.states, authoritative: c.authoritative, quote: c.quote })),
          repoPaths,
        });
        const path = reportPath(now);
        const body = renderTruthReport(report);
        // Through the ordinary write path, so the report is snapshotted and
        // audited like any other document. Hard rule 5: no write path skips
        // document_versions and audit_log, and a report is not an exception.
        const prior = await db
          .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path)
          .first<{ id: number; title: string | null; body: string | null }>();
        const title = `Truth report - ${namespace} - ${path.slice("reports/lint-".length, -3)}`;
        const statements = [];
        if (prior) {
          statements.push(
            db
              .prepare(
                "INSERT INTO document_versions (document_id, namespace, path, title, body) SELECT id, namespace, path, title, body FROM documents WHERE namespace = ?1 AND path = ?2"
              )
              .bind(namespace, path)
          );
        }
        // THE SAME UPSERT THE `write` TOOL ISSUES, byte for byte. One spelling of
        // the document upsert in this file, so a change to the write path cannot
        // leave a second one behind that nobody remembers to update.
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
            .bind(namespace, path, title, body, "reference", null, "published")
        );
        statements.push(
          db
            .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'lint_report', ?2, ?3, ?4)")
            .bind(actor, namespace, path, JSON.stringify({ integrity: report.integrity, findings: report.findings.length }))
        );
        await db.batch(statements);
        return ok({ mode: "report", stored: `${namespace}/${path}`, ...report });
      }

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
      // THE IMPROVE CONTROL-SURFACE GUARD, on finalize too (audit 2026-09-07,
      // Opus MAJOR 5.4). finalize is type-gated to episodic and source documents,
      // and improve documents are task, prompt and reference, so this looks
      // unreachable. It is not: a document written to an improve path WITH the
      // opt-in flag can carry type 'source', and finalize would then archive the
      // run prompt out from under the loop. NO OPT-IN HERE, deliberately:
      // archiving the loop's control surface is never the right move, and lint
      // has no business being the tool that does it.
      const consumedImproveRefusals = (
        await Promise.all(paths.map((consumedPath) => improveWriteRefusal(namespace, consumedPath, null, "", false)))
      ).filter((r): r is string => r !== null);
      if (consumedImproveRefusals.length > 0) {
        return fail(`finalize aborted, nothing archived:\n${consumedImproveRefusals.join("\n")}`);
      }
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
}
