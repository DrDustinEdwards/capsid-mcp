import type { Env } from "./env";
import {
  attribute,
  nextStatus,
  type Evaluation,
  type RunSignal,
  type SkillStatus,
  type Transition,
} from "./skills-lifecycle";

// ---- offering, creating, and remembering failures ------------------------------
//
// The lifecycle rules in ./skills-lifecycle are pure. This is the half that touches
// rows: which skills to offer a driver, how a candidate comes into existence, what a
// failed run leaves behind, and how a transition is committed.

// AT MOST THREE. A recommend step that returned ten would be handing a driver a
// reading list rather than a suggestion, and the offered-but-not-used rate, which is
// how the recommend step itself is judged, would stop meaning anything.
export const MAX_OFFERED = 3;

// How many failure notes ride along with each offered skill.
export const FAILURE_NOTES_PER_SKILL = 2;

export interface OfferedSkill {
  id: string;
  title: string;
  status: SkillStatus;
  version: number;
  trigger_condition: string | null;
  body_ref: string;
  // The most recent failures recorded against this skill, newest first. A driver
  // about to follow a skill sees how it went wrong the last two times first.
  recent_failures: Array<{ note: string; source_kind: string; source_id: string; created_at: string }>;
}

/**
 * The skills worth offering for one piece of work.
 *
 * CANDIDATE AND LIVE ONLY. A retired skill is a record of something that did not
 * work, kept so it is not regenerated, and offering it would be recommending the
 * thing the evidence retired.
 *
 * Matched on trigger_condition through FTS. A skill with no trigger condition is
 * never offered: the rows that predate migration 0012 have none, and matching them on
 * title instead would be inventing the field the match runs on.
 */
export async function offerSkills(env: Env, namespace: string, work: string): Promise<OfferedSkill[]> {
  const terms = ftsQuery(work);
  if (!terms) return [];

  // The FTS index covers documents, and a skill's prose lives at improve/skills/<id>.md,
  // so the match runs there and resolves back to the row. That keeps one index rather
  // than adding a second over a column.
  const matched = await env.DB.prepare(
    `SELECT s.id, s.title, s.status, s.version, s.trigger_condition, s.body_ref
     FROM improve_skills s
     JOIN documents d ON d.path = s.body_ref AND d.namespace = 'capsid'
     JOIN documents_fts f ON f.rowid = d.id
     WHERE f.documents_fts MATCH ?1
       AND s.status IN ('candidate', 'live')
       AND s.trigger_condition IS NOT NULL
       AND (s.namespaces IS NULL OR s.namespaces LIKE ?2)
     ORDER BY bm25(documents_fts)
     LIMIT ?3`
  )
    .bind(terms, `%"${namespace}"%`, MAX_OFFERED)
    .all<{ id: string; title: string; status: string; version: number; trigger_condition: string | null; body_ref: string }>();

  const rows = matched.results ?? [];
  const out: OfferedSkill[] = [];
  for (const row of rows) {
    const failures = await env.DB.prepare(
      `SELECT note, source_kind, source_id, created_at FROM skill_failures
       WHERE skill = ?1 ORDER BY created_at DESC LIMIT ?2`
    )
      .bind(row.id, FAILURE_NOTES_PER_SKILL)
      .all<{ note: string; source_kind: string; source_id: string; created_at: string }>();
    out.push({
      id: row.id,
      title: row.title,
      status: row.status as SkillStatus,
      version: row.version,
      trigger_condition: row.trigger_condition,
      body_ref: row.body_ref,
      recent_failures: failures.results ?? [],
    });
  }
  return out;
}

// FTS5 takes a query language, and work descriptions are free prose that regularly
// contains its operators. Reduced to bare words joined by OR, so a description
// containing a quote or a NEAR does not become a syntax error or, worse, a query that
// means something other than it says.
export function ftsQuery(work: string): string | null {
  const words = work
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .slice(0, 24);
  return words.length > 0 ? words.join(" OR ") : null;
}

// ---- creating a candidate -------------------------------------------------------

export interface CandidateSource {
  kind: "attempt" | "job";
  id: string;
  // For a job: the outcome row's verified counts. A candidate is written from a job
  // only when the outcome was FULLY verified, which is the job's own bar.
  prsMerged?: number | null;
  ciGreen?: number | null;
  kept?: boolean;
}

export type CreateVerdict = { create: true; reason: string } | { create: false; reason: string };

/**
 * Whether a source has earned a candidate skill.
 *
 * A kept attempt, or a job whose outcome is verified with a merged pull request and
 * green CI. Both bars are about the WORK having landed, not about the skill being
 * good: nothing here decides that, which is why the result is always a candidate and
 * never live.
 */
export function shouldCreateCandidate(source: CandidateSource): CreateVerdict {
  if (source.kind === "attempt") {
    return source.kept
      ? { create: true, reason: `attempt ${source.id} was kept.` }
      : { create: false, reason: `attempt ${source.id} was reverted, so there is nothing to abstract from it.` };
  }
  if (source.prsMerged !== 1 || source.ciGreen !== 1) {
    return {
      create: false,
      reason: `job ${source.id} is not fully verified (prs_merged ${source.prsMerged ?? "null"}, ci_green ${source.ciGreen ?? "null"}); a candidate is written only from work the Worker checked landed.`,
    };
  }
  return { create: true, reason: `job ${source.id} merged one pull request with green CI.` };
}

/**
 * Whether this source has already produced a skill, retired ones included.
 *
 * RETIRED COUNTS, and that is the point of the check. A skill retired for not helping
 * would otherwise be abstracted again from the same attempt on the next pass, evaluated
 * again, and retired again, forever.
 */
export async function alreadyAbstracted(env: Env, source: CandidateSource): Promise<{ skill: string; status: string } | null> {
  // TWO SPELLED-OUT STATEMENTS rather than one with the column interpolated. A query
  // assembled by string concatenation cannot be reconstructed and checked by the
  // integration suite's query-plan guard, and that guard is the only thing that reads
  // every statement this Worker issues.
  const row =
    source.kind === "attempt"
      ? await env.DB.prepare("SELECT id, status FROM improve_skills WHERE source_attempt = ?1 LIMIT 1")
          .bind(source.id)
          .first<{ id: string; status: string }>()
      : await env.DB.prepare("SELECT id, status FROM improve_skills WHERE source_job = ?1 LIMIT 1")
          .bind(source.id)
          .first<{ id: string; status: string }>();
  return row ? { skill: row.id, status: row.status } : null;
}

// ---- failure memory -------------------------------------------------------------

/** One note per skill that was in use when a run failed or was reverted. */
export function failureNoteStatements(
  db: D1Database,
  namespace: string,
  source: { kind: "attempt" | "job"; id: string },
  skillIds: readonly string[],
  note: string
): D1PreparedStatement[] {
  return skillIds.map((skill) =>
    db
      .prepare(
        `INSERT INTO skill_failures (skill, namespace, source_kind, source_id, note)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
      .bind(skill, namespace, source.kind, source.id, note.slice(0, 2000))
  );
}

// ---- committing a transition ----------------------------------------------------

/**
 * Apply what the rules decided, as a keyed UPDATE so a status that moved underneath
 * this read does not get overwritten. Returns whether it landed.
 *
 * The transition itself is decided by ./skills-lifecycle and never here: this is the
 * write, and splitting them is what lets the rules be tested without a database.
 */
export async function commitTransition(env: Env, skill: string, from: SkillStatus, to: SkillStatus, now: Date): Promise<boolean> {
  const won = await env.DB.prepare(
    `UPDATE improve_skills SET status = ?3, retired_at = CASE WHEN ?3 = 'retired' THEN ?4 ELSE retired_at END
     WHERE id = ?1 AND status = ?2 RETURNING id`
  )
    .bind(skill, from, to, now.toISOString())
    .first<{ id: string }>();
  return won !== null;
}

/** Every candidate and live skill's transition verdict, from its stored evaluations. */
export async function dueTransitions(env: Env): Promise<Array<{ skill: string; verdict: Transition }>> {
  const skills = await env.DB.prepare(
    "SELECT id, status, version FROM improve_skills WHERE status IN ('candidate', 'live')"
  ).all<{ id: string; status: string; version: number }>();

  const out: Array<{ skill: string; verdict: Transition }> = [];
  for (const skill of skills.results ?? []) {
    const evaluations = await env.DB.prepare(
      `SELECT skill, version, namespace, probe_set_version, delta, runs, verdict, evaluated_at
       FROM skill_evaluations WHERE skill = ?1 AND version = ?2 ORDER BY evaluated_at ASC`
    )
      .bind(skill.id, skill.version)
      .all<Evaluation>();
    out.push({
      skill: skill.id,
      verdict: nextStatus(skill.status as SkillStatus, skill.version, evaluations.results ?? []),
    });
  }
  return out;
}

// ---- attribution, applied -------------------------------------------------------

export interface AttributionInput {
  offered: readonly string[];
  used: readonly string[];
  signal: RunSignal;
}

/**
 * What one finished run does to each skill it was offered. Returns a statement per
 * skill that actually moves, and nothing for the ones that do not: a skill offered and
 * not used produces no write at all, so the table does not fill up with rows recording
 * that nothing happened.
 */
export function attributionStatements(db: D1Database, input: AttributionInput): D1PreparedStatement[] {
  const used = new Set(input.used);
  const statements: D1PreparedStatement[] = [];
  for (const skill of input.offered) {
    const verdict = attribute(used.has(skill), input.signal);
    if (verdict.credit === "none") continue;
    // Spelled out for the same reason as above.
    statements.push(
      verdict.credit === "win"
        ? db.prepare("UPDATE improve_skills SET wins = wins + 1 WHERE id = ?1").bind(skill)
        : db.prepare("UPDATE improve_skills SET losses = losses + 1 WHERE id = ?1").bind(skill)
    );
  }
  return statements;
}
