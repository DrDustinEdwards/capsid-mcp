// The state machine's storage layer: KV for the small facts, D1 for the run.
//
// EVERY TRANSITION IS IDEMPOTENT AND KEYED ON THE STATUS IT EXPECTS. A tick that
// finds a row already advanced does nothing and says so. This is not defensive
// coding, it is the contract the tick cron needs: ticks overlap (a slow one is
// still running when the next fires), an isolate can die between a GitHub call
// and the row update, and a hand-run improve_run can land in the middle of both.
// Any of those replays a transition, and a replayed transition that is not
// idempotent double-counts an attempt or reverts a change that was kept.
//
// THE MECHANISM IS `UPDATE ... WHERE status = <expected> RETURNING id`, NOT
// meta.changes. This repo's rule 7 says D1's meta.changes cannot be used to count
// what a statement did, because the FTS5 triggers on `documents` inflate it.
// These tables carry no triggers, so meta.changes would in fact be honest here,
// and RETURNING is used anyway: a rule that holds only where someone remembers
// which tables have triggers is a rule that gets broken by the next author. The
// returned row set is unambiguous everywhere.

import { sha256Hex } from "./auth";
import type { Env } from "./env";
import { normalizeDashes } from "./normalize";
import {
  bestKey,
  DEFAULT_MODE,
  IMPROVE_MODES,
  MODE_KEY,
  pausedKey,
  type BestRecord,
  type ImproveMode,
  type RunCondition,
  type RunStatus,
} from "./improve-schema";

// The principal on every audit row this subsystem writes. One spelling, here,
// because the arc asked for "full logs to audit_log with actor improve-loop" and
// a second spelling would make that query silently incomplete.
export const IMPROVE_ACTOR = "improve-loop";

// ---- KV ---------------------------------------------------------------------

// FAIL TO "off", ALWAYS. An unset key, an unrecognised value, or a KV that threw
// all resolve to off. The asymmetry is deliberate: the cost of wrongly running is
// five repos receiving machine-authored branches overnight, and the cost of
// wrongly not running is one quiet night.
export async function readMode(kv: KVNamespace): Promise<{ mode: ImproveMode; reason: string | null }> {
  let raw: string | null;
  try {
    raw = await kv.get(MODE_KEY);
  } catch (err) {
    return { mode: "off", reason: `could not read ${MODE_KEY}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw === null) return { mode: DEFAULT_MODE, reason: `${MODE_KEY} is unset` };
  const value = raw.trim().toLowerCase();
  if ((IMPROVE_MODES as readonly string[]).includes(value)) return { mode: value as ImproveMode, reason: null };
  return { mode: "off", reason: `${MODE_KEY} holds an unrecognised value; expected one of ${IMPROVE_MODES.join(", ")}` };
}

// A paused namespace is skipped. A KV error here also pauses: the same
// asymmetry as the mode read, for the same reason.
export async function pausedReason(kv: KVNamespace, namespace: string): Promise<string | null> {
  try {
    return await kv.get(pausedKey(namespace));
  } catch (err) {
    return `could not read the pause key: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// NO TTL. A pause is a decision that outlives any run and is cleared by a human
// deleting the key, which is the point: an expiring pause silently resumes a
// namespace that was stopped for a reason nobody has looked at yet.
export async function pauseNamespace(kv: KVNamespace, namespace: string, reason: string): Promise<void> {
  await kv.put(pausedKey(namespace), reason);
}

export async function readBest(kv: KVNamespace, namespace: string): Promise<BestRecord | null> {
  try {
    const raw = await kv.get(bestKey(namespace));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BestRecord;
    return typeof parsed?.sha === "string" && parsed.sha.length > 0 ? parsed : null;
  } catch {
    // A corrupt best record is treated as absent rather than thrown: the run then
    // branches from the repo's default branch, which is a worse base but a safe
    // one. Throwing here would wedge every future run on one bad JSON value.
    return null;
  }
}

export async function writeBest(kv: KVNamespace, namespace: string, record: BestRecord): Promise<void> {
  await kv.put(bestKey(namespace), JSON.stringify(record));
}

// ---- rows -------------------------------------------------------------------

export interface RunRow {
  id: string;
  namespace: string;
  mode: string;
  started: string;
  finished: string | null;
  attempts: number;
  kept: number;
  reverts: number;
  cost_usd: number;
  ci_minutes: number;
  status: RunStatus;
  consecutive_reverts: number;
  current_attempt: string | null;
  base_sha: string | null;
  pr_url: string | null;
  note: string | null;
  condition: RunCondition;
  advanced_at: string;
}

export interface AttemptRow {
  id: string;
  namespace: string;
  run_id: string;
  change_summary: string | null;
  diff_ref: string | null;
  score_before: number | null;
  score_after: number | null;
  kept: number;
  reason: string | null;
  lineage_parent: string | null;
  status: string;
  branch: string | null;
  head_sha: string | null;
  base_sha: string | null;
  flagged: number;
  flag_reason: string | null;
  skill_id: string | null;
  anchors_json: string | null;
  secondary_json: string | null;
  dispatched_at: string | null;
  ts: string;
}

const RUN_COLUMNS =
  "id, namespace, mode, started, finished, attempts, kept, reverts, cost_usd, ci_minutes, status, " +
  "consecutive_reverts, current_attempt, base_sha, pr_url, note, condition, advanced_at";

const ATTEMPT_COLUMNS =
  "id, namespace, run_id, change_summary, diff_ref, score_before, score_after, kept, reason, lineage_parent, " +
  "status, branch, head_sha, base_sha, flagged, flag_reason, skill_id, anchors_json, secondary_json, dispatched_at, ts";

// The one active run for a namespace, or null. The partial unique index in
// migrations/0003_improve.sql is what makes "the one" true even when two ticks
// race; this read is the fast path, not the guarantee.
export async function activeRun(db: D1Database, namespace: string): Promise<RunRow | null> {
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM improve_runs
       WHERE namespace = ?1 AND status NOT IN ('done', 'paused')
       ORDER BY started DESC LIMIT 1`
    )
    .bind(namespace)
    .first<RunRow>();
}

export async function runById(db: D1Database, runId: string): Promise<RunRow | null> {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM improve_runs WHERE id = ?1`).bind(runId).first<RunRow>();
}

// Every run not in a terminal state, oldest first. The tick's work list.
export async function advanceableRuns(db: D1Database, limit: number): Promise<RunRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM improve_runs
       WHERE status NOT IN ('done', 'paused')
       ORDER BY advanced_at ASC LIMIT ?1`
    )
    .bind(limit)
    .all<RunRow>();
  return results;
}

export async function attemptById(db: D1Database, attemptId: string): Promise<AttemptRow | null> {
  return db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM improve_attempts WHERE id = ?1`).bind(attemptId).first<AttemptRow>();
}

export async function attemptsForRun(db: D1Database, runId: string): Promise<AttemptRow[]> {
  const { results } = await db
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM improve_attempts WHERE run_id = ?1 ORDER BY ts ASC`)
    .bind(runId)
    .all<AttemptRow>();
  return results;
}

// ---- transitions ------------------------------------------------------------

export interface Transition {
  runId: string;
  // The status the caller believes the run is in. The update only fires if it
  // still is. Passing the wrong one is not an error, it is a no-op, which is
  // exactly what a replayed tick should be.
  expected: RunStatus;
  next: RunStatus;
  patch?: Partial<
    Pick<
      RunRow,
      | "attempts"
      | "kept"
      | "reverts"
      | "cost_usd"
      | "ci_minutes"
      | "consecutive_reverts"
      | "current_attempt"
      | "base_sha"
      | "pr_url"
      | "note"
      | "finished"
    >
  >;
}

// Returns true when THIS call moved the run. False means someone else already
// did, which is a normal outcome and never an error.
export async function advanceRun(db: D1Database, t: Transition): Promise<boolean> {
  const sets: string[] = ["status = ?1", "advanced_at = datetime('now')"];
  const binds: unknown[] = [t.next];
  for (const [column, value] of Object.entries(t.patch ?? {})) {
    binds.push(value);
    sets.push(`${column} = ?${binds.length}`);
  }
  binds.push(t.runId, t.expected);
  const { results } = await db
    .prepare(
      `UPDATE improve_runs SET ${sets.join(", ")}
       WHERE id = ?${binds.length - 1} AND status = ?${binds.length}
       RETURNING id`
    )
    .bind(...binds)
    .all<{ id: string }>();
  return results.length === 1;
}

// ---- documents --------------------------------------------------------------

// THE IMPROVE LOOP WRITES DOCUMENTS THROUGH THE SAME TWO INVARIANTS AS EVERY
// OTHER WRITE PATH IN THIS WORKER: the prior row is snapshotted into
// document_versions and a row is appended to audit_log, both in the SAME BATCH as
// the write, so either all three land or none do.
//
// This is CLAUDE.md hard rule 5, and it applies here even though nothing the loop
// writes is canon: an archive doc that overwrites a previous archive doc with no
// snapshot is exactly the unrecoverable state the rule exists to prevent, and
// "the loop's own documents do not matter" is the sentence that precedes finding
// out they did.
//
// Returns STATEMENTS rather than executing, so a caller can batch a document
// write together with the row update it belongs to.
export async function improveDocStatements(
  db: D1Database,
  doc: {
    namespace: string;
    path: string;
    title: string;
    body: string;
    type: string;
    status?: string;
    tags?: string;
    prior: { id: number; title: string | null; body: string | null } | null;
    action: string;
  }
): Promise<D1PreparedStatement[]> {
  // Server-side dash normalization, the same as the write tool applies. A
  // document written by a model is the single most likely source of an em dash
  // in this store, so the normalizer matters more here than anywhere else.
  const body = normalizeDashes(doc.body, "prose");
  const title = normalizeDashes(doc.title, "title");

  const statements: D1PreparedStatement[] = [];
  if (doc.prior) {
    statements.push(
      db
        .prepare(
          "INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (?1, ?2, ?3, ?4, ?5)"
        )
        .bind(doc.prior.id, doc.namespace, doc.path, doc.prior.title, doc.prior.body)
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO documents (namespace, path, title, body, type, tags, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(namespace, path) DO UPDATE SET
           title = ?3, body = excluded.body, type = ?5, tags = ?6, status = ?7,
           updated_at = datetime('now')`
      )
      .bind(doc.namespace, doc.path, title, body, doc.type, doc.tags ?? "improve", doc.status ?? "published")
  );
  statements.push(
    db
      .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(
        IMPROVE_ACTOR,
        doc.action,
        doc.namespace,
        doc.path,
        JSON.stringify({ bytes: body.length, sha256: await sha256Hex(body), updated: Boolean(doc.prior) })
      )
  );
  return statements;
}

export async function priorDoc(
  db: D1Database,
  namespace: string,
  path: string
): Promise<{ id: number; title: string | null; body: string | null } | null> {
  return db
    .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ id: number; title: string | null; body: string | null }>();
}

// Write one improve document on its own. The batched form above is for the cases
// where the document and a row change must land together.
export async function writeImproveDoc(
  env: Pick<Env, "DB">,
  doc: { namespace: string; path: string; title: string; body: string; type: string; status?: string; action: string }
): Promise<void> {
  const prior = await priorDoc(env.DB, doc.namespace, doc.path);
  await env.DB.batch(await improveDocStatements(env.DB, { ...doc, prior }));
}

// An audit row for something that is not a document write: a run opening, a
// namespace pausing, a scorer dispatch. Same actor, same table, so one query
// answers "what did the loop do last night".
export function improveAudit(
  db: D1Database,
  action: string,
  namespace: string,
  params: unknown
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, ?2, ?3, NULL, ?4)")
    .bind(IMPROVE_ACTOR, action, namespace, JSON.stringify(params));
}
