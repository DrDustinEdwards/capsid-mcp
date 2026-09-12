import type { Env } from "./env";
import { dispatchWorkflow } from "./github";
import { SCORER_WORKFLOW } from "./improve-schema";
import { improveAudit } from "./improve-state";
import {
  acceptEdit,
  shouldProposeMerge,
  verdictFor,
  withinEditBound,
  type EditOp,
  type SkillStatus,
} from "./skills-lifecycle";
import { commitTransition, dueTransitions } from "./skills-records";

// ---- the evaluation cycle -------------------------------------------------------
//
// GROUP 4. A skill's status moves on evaluation evidence, and this is what produces
// it: on a cadence, every candidate and live skill has its namespace's probe set run
// in the scorer sandbox twice, with the skill and without it, and the difference is
// recorded. Nothing here decides a status; ./skills-records reads the rows and
// ./skills-lifecycle decides. The split is deliberate, because the deciding half is
// then testable without a sandbox.

export const CADENCE_KEY = "skills:evaluate:cadence-days";
export const LAST_CYCLE_KEY = "skills:evaluate:last";

// BIWEEKLY BY DEFAULT, and KV-configurable. Fortnightly rather than nightly because
// an evaluation costs two full probe-set runs per skill, and because the transition
// rules need two evaluations to move anything: a cadence faster than the thing it
// feeds just spends CI to reach the same answer sooner.
export const DEFAULT_CADENCE_DAYS = 14;

// The floor. A cadence of zero or a negative number would run the cycle on every
// five-minute tick, which is the one setting that turns a bounded cost into an
// unbounded one, so an unusable value falls back rather than being obeyed.
export const MIN_CADENCE_DAYS = 1;

export async function cadenceDays(env: Env): Promise<number> {
  try {
    const raw = await env.APP_KV.get(CADENCE_KEY);
    if (raw === null) return DEFAULT_CADENCE_DAYS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < MIN_CADENCE_DAYS) return DEFAULT_CADENCE_DAYS;
    return Math.floor(parsed);
  } catch {
    // An unreadable store means the default, on the same rule improve_mode follows:
    // fall back to the safe value rather than to whatever was last in memory.
    return DEFAULT_CADENCE_DAYS;
  }
}

export type DueVerdict = { due: true; reason: string } | { due: false; reason: string };

export function cycleDue(lastIso: string | null, days: number, now: Date): DueVerdict {
  if (!lastIso) return { due: true, reason: "no evaluation cycle has run yet." };
  const last = Date.parse(lastIso);
  if (Number.isNaN(last)) {
    // A corrupt stamp runs the cycle rather than blocking it forever: the cost of one
    // extra cycle is CI minutes, and the cost of never running again is a lifecycle
    // that silently stops moving.
    return { due: true, reason: `the last-cycle stamp '${lastIso}' does not parse, so the cycle runs.` };
  }
  const elapsedDays = (now.getTime() - last) / 86_400_000;
  return elapsedDays >= days
    ? { due: true, reason: `${elapsedDays.toFixed(1)} days since the last cycle, cadence is ${days}.` }
    : { due: false, reason: `${elapsedDays.toFixed(1)} of ${days} days since the last cycle.` };
}

export interface CycleReport {
  ran: boolean;
  note: string;
  dispatched: Array<{ skill: string; namespace: string }>;
  transitions: Array<{ skill: string; from: SkillStatus; to: SkillStatus; reason: string }>;
}

/**
 * One pass: apply whatever the stored evidence already decides, then dispatch the
 * next round of measurements.
 *
 * TRANSITIONS FIRST, deliberately. A skill that this cycle's evidence retires should
 * not have its next evaluation dispatched, and doing the reads in the other order
 * would spend two probe-set runs measuring something about to be retired.
 */
export async function runEvaluationCycle(env: Env, now: Date): Promise<CycleReport> {
  const days = await cadenceDays(env);
  const last = await env.APP_KV.get(LAST_CYCLE_KEY).catch(() => null);
  const verdict = cycleDue(last, days, now);
  if (!verdict.due) return { ran: false, note: verdict.reason, dispatched: [], transitions: [] };

  const transitions: CycleReport["transitions"] = [];
  for (const { skill, verdict: decision } of await dueTransitions(env)) {
    if (!decision.change) continue;
    const landed = await commitTransition(env, skill, decision.from, decision.to, now);
    if (!landed) continue;
    transitions.push({ skill, from: decision.from, to: decision.to, reason: decision.reason });
    await env.DB.batch([
      improveAudit(env.DB, "skill-status-changed", null, {
        skill,
        from: decision.from,
        to: decision.to,
        reason: decision.reason,
        at: now.toISOString(),
      }),
    ]);
  }

  // What is left to measure, after the retirements above have taken effect.
  const remaining = await env.DB.prepare(
    `SELECT id, version, source_namespace FROM improve_skills WHERE status IN ('candidate', 'live')`
  ).all<{ id: string; version: number; source_namespace: string }>();

  const dispatched: CycleReport["dispatched"] = [];
  for (const skill of remaining.results ?? []) {
    try {
      await dispatchWorkflow(env, skill.source_namespace, SCORER_WORKFLOW, {
        mode: "skill-probe",
        skill_id: skill.id,
        skill_version: String(skill.version),
      });
      dispatched.push({ skill: skill.id, namespace: skill.source_namespace });
    } catch (err) {
      // One namespace that will not dispatch does not stop the rest of the cycle.
      console.error(`SKILL_PROBE_DISPATCH_FAILED ${skill.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await env.APP_KV.put(LAST_CYCLE_KEY, now.toISOString());
  return {
    ran: true,
    note: `${verdict.reason} ${transitions.length} transition(s), ${dispatched.length} probe(s) dispatched.`,
    dispatched,
    transitions,
  };
}

/** Record one measured evaluation. The verdict is derived here and then stored, so a
 *  later change to the threshold cannot restate old rows as something they were not. */
export function evaluationStatement(
  db: D1Database,
  row: { skill: string; version: number; namespace: string; probeSetVersion: string; delta: number; runs: number }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO skill_evaluations (skill, version, namespace, probe_set_version, delta, runs, verdict)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(row.skill, row.version, row.namespace, row.probeSetVersion, row.delta, row.runs, verdictFor(row.delta));
}

// ---- bounded edits, ingested ----------------------------------------------------
//
// GROUP 5. An optimizer proposes operations on a skill's instructions. The bound is
// checked before anything is measured, because an edit that is out of bounds should
// cost no CI at all; the acceptance is decided afterwards, against the probe set.

export type ProposalVerdict =
  | { accepted: false; reason: string; recorded: D1PreparedStatement }
  | { accepted: true; reason: string; recorded: D1PreparedStatement[] };

/**
 * Whether a proposed edit is taken, and the rows that record the answer either way.
 *
 * BOTH OUTCOMES ARE RECORDED. A rejected edit is the memory that stops the next
 * optimizer proposing the same thing, which is the whole reason skill_edits exists,
 * so a refusal writes a row rather than returning nothing.
 */
export function judgeEdit(
  db: D1Database,
  skill: { id: string; version: number; l2: string },
  ops: readonly EditOp[],
  measured: { deltaBefore: number; deltaAfter: number } | null
): ProposalVerdict {
  const to = skill.version + 1;
  const row = (accepted: boolean, reason: string) =>
    db
      .prepare(
        `INSERT INTO skill_edits (skill, from_version, to_version, ops, accepted, reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(skill.id, skill.version, to, JSON.stringify(ops), accepted ? 1 : 0, reason);

  const bound = withinEditBound(skill.l2, ops);
  if (!bound.ok) return { accepted: false, reason: bound.reason, recorded: row(false, bound.reason) };

  if (!measured) {
    const reason = "the edited version was not measured against the probe set, and an unmeasured edit is not accepted.";
    return { accepted: false, reason, recorded: row(false, reason) };
  }

  const verdict = acceptEdit(measured.deltaBefore, measured.deltaAfter);
  if (!verdict.accepted) return { accepted: false, reason: verdict.reason, recorded: row(false, verdict.reason) };

  // THE VERSION BUMP IS THE COST. It resets the skill's evaluation evidence, which is
  // why the bound and the strict-improvement rule matter rather than being formalities.
  return {
    accepted: true,
    reason: verdict.reason,
    recorded: [
      row(true, verdict.reason),
      db.prepare("UPDATE improve_skills SET version = ?2 WHERE id = ?1 AND version = ?3").bind(skill.id, to, skill.version),
    ],
  };
}

/** What the next optimizer run is shown: this skill's refused proposals, newest first. */
export async function rejectedEdits(
  env: Env,
  skill: string,
  limit = 5
): Promise<Array<{ from_version: number; ops: string; reason: string; evaluated_at: string }>> {
  const rows = await env.DB.prepare(
    `SELECT from_version, ops, reason, evaluated_at FROM skill_edits
     WHERE skill = ?1 AND accepted = 0 ORDER BY evaluated_at DESC LIMIT ?2`
  )
    .bind(skill, limit)
    .all<{ from_version: number; ops: string; reason: string; evaluated_at: string }>();
  return rows.results ?? [];
}

// ---- merge proposals --------------------------------------------------------------
//
// GROUP 6. Two live skills saying nearly the same thing about the same trigger are a
// duplicate, and the merged result starts as a candidate because a merge is a new
// document that nothing has evaluated.

export interface MergeProposal {
  a: string;
  b: string;
  reason: string;
}

/**
 * Every pair worth proposing. Compared pairwise over live skills only, which is
 * bounded by the number of LIVE skills rather than by the whole table: a portfolio
 * with three live skills does three comparisons.
 */
export async function mergeProposals(env: Env): Promise<MergeProposal[]> {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.status, s.trigger_condition, d.body
     FROM improve_skills s
     LEFT JOIN documents d ON d.path = s.body_ref AND d.namespace = 'capsid'
     WHERE s.status = 'live' AND s.trigger_condition IS NOT NULL`
  ).all<{ id: string; status: string; trigger_condition: string; body: string | null }>();

  const live = rows.results ?? [];
  const out: MergeProposal[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const verdict = shouldProposeMerge(
        { status: "live", trigger: live[i].trigger_condition, body: live[i].body ?? "" },
        { status: "live", trigger: live[j].trigger_condition, body: live[j].body ?? "" }
      );
      if (verdict.merge) out.push({ a: live[i].id, b: live[j].id, reason: verdict.reason });
    }
  }
  return out;
}
