// The run: opening one, advancing one, finishing one.
//
// THE SHAPE, because it is not obvious from any single function below.
//
// A run is a resumable state machine in D1. Nothing here loops until a run is
// finished, because a Cloudflare cron invocation has a wall-clock ceiling and a
// CI scoring job takes minutes. Instead the nightly opener creates the run, and a
// tick every five minutes advances whichever runs are not finished, ONE STEP AT A
// TIME. Every step is idempotent and keyed on the status it expects, so a tick
// that overlaps another tick, or an isolate that dies mid-step, costs nothing.
//
//   opening        -> dispatch a BASELINE scoring job, so keep/revert has
//                     something to compare against on the very first attempt.
//   attempting     -> propose one change, push it to a branch, dispatch the
//                     scorer, and wait.
//   awaiting-score -> do nothing until CI posts back, or until the 20 minute
//                     stale guard fires and reverts that attempt.
//   judging        -> held only inside the score ingest, which runs in an HTTP
//                     request and therefore has time to decide.
//   finalizing     -> open the PR for what was kept, write the run document,
//                     run the drift gate.
//   done | paused  -> terminal. The partial unique index frees the namespace.
//
// WHY A BASELINE RUN AT ALL, since it costs one extra CI job per namespace per
// night: without it the first attempt of a namespace's first run has nothing to
// compare against, `compare()` reports zero comparable metrics, and the attempt is
// reverted for a reason that has nothing to do with its quality. Measuring the
// base fresh each night also catches the metrics that move on their own (error
// counts, latency) rather than attributing that drift to the first attempt.

import type { Env } from "./env";
import { listRepoTree, openPr, resolveRepo } from "./github";
import { proposeChange, pushAttempt, renderChange } from "./improve-attempt";
import { anchorDriftVerdict, driftVerdict, monitorAttempt } from "./improve-gates";
import { runMetaLoop } from "./improve-meta";
import {
  anchorVerdict,
  compare,
  parseScoresDoc,
  verifyAnchors,
  type MetricMap,
  type ScoresDoc,
} from "./improve-scores";
import { checkHoldout, dispatchScorer, readHoldoutManifest, type ScoreReport } from "./improve-scorer";
import {
  archivePath,
  attemptId,
  branchName,
  chicagoDay,
  DEFAULT_CONDITION,
  isRunCondition,
  MAX_ATTEMPTS_PER_RUN,
  MAX_CONSECUTIVE_REVERTS,
  ROSTER,
  RUN_MAX_AGE_MS,
  runId as makeRunId,
  RUN_CONDITIONS,
  runTaskPath,
  RUN_PROMPT_PATH,
  SCORES_PATH,
  SCORE_TIMEOUT_MS,
  type BestRecord,
  type ImproveMode,
  type RunCondition,
} from "./improve-schema";
import { selectBase } from "./improve-select";
import { abstractSkill, candidateSkills, readSkillBody, recordSkill, recordSkillOutcome } from "./improve-skills";
import {
  activeRun,
  advanceableRuns,
  advanceRun,
  attemptById,
  attemptsForRun,
  improveAudit,
  improveDocStatements,
  pauseNamespace,
  pausedReason,
  priorDoc,
  readBest,
  readMode,
  runById,
  writeBest,
  type AttemptRow,
  type RunRow,
} from "./improve-state";

// A baseline job is dispatched under a synthetic attempt id that is deliberately
// NOT a row in improve_attempts: it measures the base, it is not an attempt at
// anything, and giving it a row would make every attempt count off by one.
const baselineId = (runIdValue: string) => `${runIdValue}-baseline`;

// How many runs one tick will advance. Bounded so a tick cannot exceed its
// invocation budget when every namespace is mid-run; the ones not reached this
// tick are reached five minutes later, ordered oldest-advanced-first.
const RUNS_PER_TICK = 3;

// ---- shared reads -----------------------------------------------------------

async function readDoc(db: D1Database, namespace: string, path: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ body: string | null }>();
  return row?.body ?? null;
}

async function loadScores(env: Env, namespace: string): Promise<{ doc: ScoresDoc; refusal: string | null }> {
  const body = await readDoc(env.DB, namespace, SCORES_PATH);
  if (body === null) {
    const empty = parseScoresDoc(namespace, "");
    return { doc: empty, refusal: `${namespace}/${SCORES_PATH} does not exist. The loop cannot score a namespace with no scores document.` };
  }
  const doc = parseScoresDoc(namespace, body);
  const verification = await verifyAnchors(env.APP_KV, namespace, doc);
  return { doc, refusal: verification.refusal };
}

// The metric map for a run's baseline, or for one attempt, read back out of
// improve_scores. One reader, so the baseline and the attempt sides of a
// comparison can never be assembled two different ways.
async function metricsFor(db: D1Database, runIdValue: string, attemptIdValue: string | null): Promise<MetricMap> {
  const { results } = await db
    .prepare(
      attemptIdValue === null
        ? "SELECT metric, value FROM improve_scores WHERE run_id = ?1 AND attempt_id IS NULL"
        : "SELECT metric, value FROM improve_scores WHERE run_id = ?1 AND attempt_id = ?2"
    )
    .bind(...(attemptIdValue === null ? [runIdValue] : [runIdValue, attemptIdValue]))
    .all<{ metric: string; value: number | null }>();
  const map: MetricMap = {};
  for (const row of results) map[row.metric] = row.value;
  return map;
}

function scoreStatements(
  db: D1Database,
  runIdValue: string,
  namespace: string,
  attemptIdValue: string | null,
  metrics: MetricMap
): D1PreparedStatement[] {
  return Object.entries(metrics).map(([metric, value]) =>
    db
      .prepare(
        "INSERT INTO improve_scores (namespace, metric, value, run_id, attempt_id) VALUES (?1, ?2, ?3, ?4, ?5)"
      )
      .bind(namespace, metric, value, runIdValue, attemptIdValue)
  );
}

// ---- opening ----------------------------------------------------------------

export interface OpenOutcome {
  namespace: string;
  opened: boolean;
  runId: string | null;
  note: string;
}

export interface OpenSummary {
  mode: ImproveMode;
  modeNote: string | null;
  outcomes: OpenOutcome[];
}

// The nightly opener. In "off" it records scores and opens nothing. In
// "subscription" it does all the selection and writes a task document for a
// Claude Code session to execute. In "api" it opens a run for the tick to drive.
export async function openRuns(
  env: Env,
  now: Date,
  only?: string,
  condition: RunCondition = DEFAULT_CONDITION
): Promise<OpenSummary> {
  const { mode, reason } = await readMode(env.APP_KV);
  const namespaces = only ? [only] : [...ROSTER];
  const outcomes: OpenOutcome[] = [];

  for (const namespace of namespaces) {
    outcomes.push(await openOne(env, namespace, mode, now, condition));
  }
  return { mode, modeNote: reason, outcomes };
}

async function openOne(
  env: Env,
  namespace: string,
  mode: ImproveMode,
  now: Date,
  condition: RunCondition
): Promise<OpenOutcome> {
  const paused = await pausedReason(env.APP_KV, namespace);
  if (paused) return { namespace, opened: false, runId: null, note: `paused: ${paused}` };

  const existing = await activeRun(env.DB, namespace);
  if (existing) {
    return { namespace, opened: false, runId: existing.id, note: `a run is already active in state '${existing.status}'` };
  }

  const { doc, refusal } = await loadScores(env, namespace);
  if (refusal) {
    // A refusal is written where a human will see it in the morning, not only
    // logged. capsid/conventions.md: where a check cannot run, block and NAME the
    // reason.
    await writeTaskDoc(env, namespace, now, `# improve is blocked in ${namespace}\n\n${refusal}\n`);
    await env.DB.batch([improveAudit(env.DB, "improve-refused", namespace, { refusal })]);
    return { namespace, opened: false, runId: null, note: refusal };
  }

  if (mode === "off") {
    return { namespace, opened: false, runId: null, note: "improve_mode is off; scores document verified, nothing run" };
  }

  const best = await readBest(env.APP_KV, namespace);
  const history = await recentAttempts(env.DB, namespace, 50);
  let defaultSha: string | null = null;
  try {
    const tree = await listRepoTree(env, namespace);
    defaultSha = (tree as { sha?: string }).sha ?? null;
  } catch {
    defaultSha = null;
  }
  const choice = selectBase(best, history, defaultSha);

  if (mode === "subscription") {
    const skills = await candidateSkills(env.DB, namespace, 3);
    await writeTaskDoc(env, namespace, now, renderSubscriptionTask(namespace, now, doc, choice.why, choice.sha, skills));
    await env.DB.batch([improveAudit(env.DB, "improve-task-written", namespace, { mode, base: choice.sha })]);
    return { namespace, opened: false, runId: null, note: "subscription mode: task document written for a session to execute" };
  }

  // api mode.
  const runIdValue = makeRunId(namespace, now);
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO improve_runs (id, namespace, mode, status, base_sha, condition)
         VALUES (?1, ?2, ?3, 'opening', ?4, ?5)`
      )
      .bind(runIdValue, namespace, mode, choice.sha || null, condition),
    // THE CONDITION IS IN THE AUDIT ROW, not only in the row it describes. The
    // ruling is that an ablation should be a query, and `improve_runs` is pruned
    // by nothing while `audit_log` is the one place a single query answers "what
    // did the loop do and under what condition".
    improveAudit(env.DB, "improve-run-opened", namespace, {
      run_id: runIdValue,
      base: choice.sha,
      why: choice.why,
      condition,
    }),
  ]);
  return { namespace, opened: true, runId: runIdValue, note: choice.why };
}

async function recentAttempts(db: D1Database, namespace: string, limit: number): Promise<AttemptRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, namespace, run_id, change_summary, diff_ref, score_before, score_after, kept, reason,
              lineage_parent, status, branch, head_sha, base_sha, flagged, flag_reason, skill_id,
              anchors_json, secondary_json, dispatched_at, ts
       FROM improve_attempts WHERE namespace = ?1 ORDER BY ts DESC LIMIT ?2`
    )
    .bind(namespace, limit)
    .all<AttemptRow>();
  return results;
}

// ---- the tick ---------------------------------------------------------------

export interface TickOutcome {
  runId: string;
  namespace: string;
  from: string;
  to: string;
  note: string;
}

export async function tickRuns(env: Env, now: Date): Promise<TickOutcome[]> {
  const runs = await advanceableRuns(env.DB, RUNS_PER_TICK);
  const outcomes: TickOutcome[] = [];
  for (const run of runs) {
    try {
      outcomes.push(await advanceOne(env, run, now));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`IMPROVE_TICK_THREW ${run.id} in '${run.status}': ${message}`);
      // A throwing step does NOT wedge the run: it is finalized with the error
      // recorded. The alternative is a namespace whose one active-run slot is
      // held forever by a run nothing can advance.
      await advanceRun(env.DB, {
        runId: run.id,
        expected: run.status,
        next: "finalizing",
        patch: { note: `a step threw in '${run.status}': ${message.slice(0, 400)}` },
      });
      outcomes.push({ runId: run.id, namespace: run.namespace, from: run.status, to: "finalizing", note: message });
    }
  }
  return outcomes;
}

async function advanceOne(env: Env, run: RunRow, now: Date): Promise<TickOutcome> {
  const age = now.getTime() - Date.parse(`${run.started.replace(" ", "T")}Z`);
  if (age > RUN_MAX_AGE_MS && run.status !== "finalizing") {
    const moved = await advanceRun(env.DB, {
      runId: run.id,
      expected: run.status,
      next: "finalizing",
      patch: { note: `run exceeded its ${RUN_MAX_AGE_MS / 3_600_000} hour ceiling in state '${run.status}'` },
    });
    return { runId: run.id, namespace: run.namespace, from: run.status, to: moved ? "finalizing" : run.status, note: "aged out" };
  }

  switch (run.status) {
    case "opening":
      return dispatchBaseline(env, run);
    case "attempting":
      return startAttempt(env, run, now);
    case "awaiting-score":
      return checkStaleScore(env, run, now);
    case "judging":
      // Only ever held inside an HTTP score ingest. A run found here by a tick
      // means that request died mid-decision; putting it back to awaiting-score
      // lets the stale guard resolve it rather than leaving it stuck.
      await advanceRun(env.DB, { runId: run.id, expected: "judging", next: "awaiting-score" });
      return { runId: run.id, namespace: run.namespace, from: "judging", to: "awaiting-score", note: "a score ingest did not finish; returned to awaiting-score" };
    case "finalizing":
      return finalizeRun(env, run, now);
    default:
      return { runId: run.id, namespace: run.namespace, from: run.status, to: run.status, note: "no transition defined" };
  }
}

async function dispatchBaseline(env: Env, run: RunRow): Promise<TickOutcome> {
  if (!run.base_sha) {
    await advanceRun(env.DB, { runId: run.id, expected: "opening", next: "finalizing", patch: { note: "no base commit could be resolved" } });
    return { runId: run.id, namespace: run.namespace, from: "opening", to: "finalizing", note: "no base commit" };
  }
  const id = baselineId(run.id);
  const branch = branchName(id);
  // An empty push: the branch is created at the base commit and nothing is
  // written to it, which is exactly what "measure the base" means.
  await pushAttempt(env, { namespace: run.namespace, branch, baseSha: run.base_sha, summary: "baseline", files: [] });
  await dispatchScorer(env, run.namespace, { branch, run_id: run.id, attempt_id: id });
  await advanceRun(env.DB, {
    runId: run.id,
    expected: "opening",
    next: "awaiting-score",
    patch: { current_attempt: id },
  });
  return { runId: run.id, namespace: run.namespace, from: "opening", to: "awaiting-score", note: `baseline dispatched on ${branch}` };
}

async function startAttempt(env: Env, run: RunRow, now: Date): Promise<TickOutcome> {
  if (run.attempts >= MAX_ATTEMPTS_PER_RUN) {
    await advanceRun(env.DB, {
      runId: run.id,
      expected: "attempting",
      next: "finalizing",
      patch: { note: `reached the ${MAX_ATTEMPTS_PER_RUN} attempt ceiling` },
    });
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "finalizing", note: "attempt ceiling reached" };
  }

  const { doc, refusal } = await loadScores(env, run.namespace);
  if (refusal) {
    await advanceRun(env.DB, { runId: run.id, expected: "attempting", next: "finalizing", patch: { note: refusal } });
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "finalizing", note: refusal };
  }

  const index = run.attempts + 1;
  const id = attemptId(run.id, index);
  const branch = branchName(id);
  const priorAttempts = await attemptsForRun(env.DB, run.id);
  const best = await readBest(env.APP_KV, run.namespace);
  // CONDITION 'no-memory': lineage history is withheld from base selection, so the
  // run branches from the best record alone and cannot follow a fertile branch.
  // That is the ablation the column exists to record, and withholding the input is
  // the only way the recorded condition means anything.
  const lineage = run.condition === "no-memory" ? [] : await recentAttempts(env.DB, run.namespace, 50);
  const choice = selectBase(best, lineage, run.base_sha);
  const baseSha = choice.sha || run.base_sha || "";

  // A transferred skill is offered on the FIRST attempt of a run only. Later
  // attempts explore from what this run has already learned, and spending every
  // attempt on another project's ideas would leave no room for the loop to
  // follow its own thread.
  // CONDITION 'no-transfer': no cross-project skill is offered, so the run can
  // only propose from scratch.
  const skills = index === 1 && run.condition !== "no-transfer" ? await candidateSkills(env.DB, run.namespace, 1) : [];
  const skill = skills[0]
    ? { id: skills[0].id, title: skills[0].title, body: await readSkillBody(env.DB, skills[0]) }
    : undefined;

  const runPrompt = (await readDoc(env.DB, "capsid", RUN_PROMPT_PATH)) ?? DEFAULT_RUN_PROMPT;
  const proposal = await proposeChange(env, {
    namespace: run.namespace,
    runPrompt,
    objective: renderObjective(doc),
    context: await gatherContext(env, run.namespace),
    history: priorAttempts
      .map((a) => `- ${a.status}: ${a.change_summary ?? "(no summary)"}${a.reason ? ` [${a.reason}]` : ""}`)
      .join("\n"),
    skill,
  });

  if (proposal.refused || proposal.files.length === 0) {
    const note = proposal.refused ? "the model declined to propose a change" : "the model proposed no file changes";
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO improve_attempts (id, namespace, run_id, change_summary, reason, lineage_parent, status, base_sha, skill_id, kept)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'reverted', ?7, ?8, 0)`
        )
        .bind(id, run.namespace, run.id, proposal.summary || null, note, choice.attemptId, baseSha, skill?.id ?? null),
      ...(skill ? recordSkillOutcome(env.DB, skill.id, false) : []),
    ]);
    await advanceRun(env.DB, {
      runId: run.id,
      expected: "attempting",
      next: run.consecutive_reverts + 1 >= MAX_CONSECUTIVE_REVERTS ? "finalizing" : "attempting",
      patch: {
        attempts: run.attempts + 1,
        reverts: run.reverts + 1,
        consecutive_reverts: run.consecutive_reverts + 1,
        cost_usd: run.cost_usd + proposal.costUsd,
      },
    });
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "attempting", note };
  }

  const pushed = await pushAttempt(env, {
    namespace: run.namespace,
    branch,
    baseSha,
    summary: proposal.summary,
    files: proposal.files,
  });

  // The archive document is written BEFORE the score arrives, so a change that is
  // never scored still leaves a record of what was tried. "Never delete" in the
  // arc means the record survives the outcome, including the outcome "nothing
  // came back".
  const archive = archivePath(run.id, id);
  const prior = await priorDoc(env.DB, run.namespace, archive);
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO improve_attempts
           (id, namespace, run_id, change_summary, diff_ref, lineage_parent, status, branch, head_sha, base_sha, skill_id, dispatched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'awaiting-score', ?7, ?8, ?9, ?10, datetime('now'))`
      )
      .bind(id, run.namespace, run.id, proposal.summary, archive, choice.attemptId, branch, pushed.headSha, baseSha, skill?.id ?? null),
    ...(await improveDocStatements(env.DB, {
      namespace: run.namespace,
      path: archive,
      title: `improve attempt ${id}`,
      type: "reference",
      action: "improve-attempt",
      prior,
      body: renderAttemptDoc({ id, run, proposal, pushed, baseWhy: choice.why, skill, now }),
    })),
  ]);

  await dispatchScorer(env, run.namespace, { branch, run_id: run.id, attempt_id: id });
  await advanceRun(env.DB, {
    runId: run.id,
    expected: "attempting",
    next: "awaiting-score",
    patch: { current_attempt: id, attempts: run.attempts + 1, cost_usd: run.cost_usd + proposal.costUsd },
  });
  return { runId: run.id, namespace: run.namespace, from: "attempting", to: "awaiting-score", note: `attempt ${index} dispatched on ${branch}` };
}

// THE STALE GUARD. A dispatched scorer that has not reported in 20 minutes is
// treated as a revert, and the run continues. Never a wedge: the arc's ruling is
// that a missing score is a revert, and this is where "missing" is decided.
async function checkStaleScore(env: Env, run: RunRow, now: Date): Promise<TickOutcome> {
  const id = run.current_attempt;
  if (!id) {
    await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "attempting" });
    return { runId: run.id, namespace: run.namespace, from: "awaiting-score", to: "attempting", note: "no attempt was recorded as in flight" };
  }

  const isBaseline = id === baselineId(run.id);
  const attempt = isBaseline ? null : await attemptById(env.DB, id);
  const dispatchedAt = isBaseline ? run.advanced_at : (attempt?.dispatched_at ?? run.advanced_at);
  const waited = now.getTime() - Date.parse(`${dispatchedAt.replace(" ", "T")}Z`);
  if (waited < SCORE_TIMEOUT_MS) {
    return { runId: run.id, namespace: run.namespace, from: "awaiting-score", to: "awaiting-score", note: `waiting (${Math.round(waited / 1000)}s of ${SCORE_TIMEOUT_MS / 1000}s)` };
  }

  const note = `no score report after ${Math.round(waited / 60_000)} minutes; treated as a revert`;
  if (isBaseline) {
    // A baseline that never scores means every later comparison is unprovable,
    // so the run ends here rather than making ten attempts that must all revert.
    await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "finalizing", patch: { note: `the baseline scoring job never reported: ${note}` } });
    return { runId: run.id, namespace: run.namespace, from: "awaiting-score", to: "finalizing", note };
  }

  await env.DB.batch([
    ...(attempt
      ? [
          env.DB
            .prepare("UPDATE improve_attempts SET status = 'timed-out', kept = 0, reason = ?2 WHERE id = ?1 AND status = 'awaiting-score'")
            .bind(id, note),
        ]
      : []),
    ...(attempt?.skill_id ? recordSkillOutcome(env.DB, attempt.skill_id, false) : []),
    improveAudit(env.DB, "improve-score-timeout", run.namespace, { run_id: run.id, attempt_id: id, waited_ms: waited }),
  ]);

  const consecutive = run.consecutive_reverts + 1;
  await advanceRun(env.DB, {
    runId: run.id,
    expected: "awaiting-score",
    next: consecutive >= MAX_CONSECUTIVE_REVERTS || run.attempts >= MAX_ATTEMPTS_PER_RUN ? "finalizing" : "attempting",
    patch: {
      reverts: run.reverts + 1,
      consecutive_reverts: consecutive,
      current_attempt: null,
      ...(consecutive >= MAX_CONSECUTIVE_REVERTS ? { note: `${consecutive} consecutive reverts; restored to the best known commit and stopped` } : {}),
    },
  });
  return { runId: run.id, namespace: run.namespace, from: "awaiting-score", to: "attempting", note };
}

// ---- ingest -----------------------------------------------------------------

export interface IngestResult {
  ok: boolean;
  message: string;
  kept?: boolean;
}

// Called from the /improve/score endpoint after the signature has verified.
// Runs in an HTTP request rather than in a tick, so it has room to decide.
export async function ingestScore(env: Env, report: ScoreReport, now: Date): Promise<IngestResult> {
  const run = await runById(env.DB, report.run_id);
  if (!run) return { ok: false, message: `unknown run ${report.run_id}` };
  if (run.namespace !== report.namespace) {
    return { ok: false, message: `report namespace '${report.namespace}' does not match run ${run.id} ('${run.namespace}')` };
  }

  // THE HOLDOUT CHECK, before anything is believed. A report that disagrees with
  // the manifest about how many hidden tests exist is refused outright.
  const manifest = await readHoldoutManifest(env, run.namespace);
  const holdout = checkHoldout(manifest, report);

  const anchors: MetricMap = { ...report.anchors, holdout_pass_rate: holdout.passRate };
  const isBaseline = report.attempt_id === baselineId(run.id);

  if (isBaseline) {
    const moved = await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "judging" });
    if (!moved) return { ok: true, message: "baseline already ingested; nothing to do" };
    await env.DB.batch([
      ...scoreStatements(env.DB, run.id, run.namespace, null, { ...anchors, ...report.secondary }),
      improveAudit(env.DB, "improve-baseline", run.namespace, { run_id: run.id, anchors, holdout: holdout.refusal }),
    ]);
    const verdict = anchorVerdict((await loadScores(env, run.namespace)).doc.anchors, anchors);
    if (!verdict.passed) {
      // The BASE does not pass its own anchors. Nothing the loop does tonight can
      // be judged, and the honest response is to stop and say so rather than to
      // measure ten attempts against a broken floor.
      await advanceRun(env.DB, {
        runId: run.id,
        expected: "judging",
        next: "finalizing",
        patch: { note: `the base commit fails its own anchors: ${verdict.reasons.join("; ")}`, ci_minutes: run.ci_minutes + report.ci_minutes },
      });
      return { ok: true, message: "baseline recorded; the base fails its own anchors, so the run stops" };
    }
    await advanceRun(env.DB, { runId: run.id, expected: "judging", next: "attempting", patch: { current_attempt: null, ci_minutes: run.ci_minutes + report.ci_minutes } });
    return { ok: true, message: "baseline recorded" };
  }

  const attempt = await attemptById(env.DB, report.attempt_id);
  if (!attempt) return { ok: false, message: `unknown attempt ${report.attempt_id}` };

  const moved = await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "judging" });
  if (!moved) return { ok: true, message: `run ${run.id} is not awaiting a score; this report is a duplicate and was ignored` };

  const { doc } = await loadScores(env, run.namespace);
  const baseline = await metricsFor(env.DB, run.id, null);
  const comparison = compare(doc.secondary, baseline, report.secondary);
  const anchorsVerdict = anchorVerdict(doc.anchors, anchors);

  // THE MONITOR RUNS BEFORE THE SCORE IS BELIEVED, and its verdict outranks it. A
  // flagged attempt is reverted regardless of how well it scored, which is the
  // whole point: a change that games the scorer scores WELL.
  const change = (await readDoc(env.DB, run.namespace, attempt.diff_ref ?? "")) ?? "";
  const monitor = await monitorAttempt(env, {
    changedPaths: changedPathsFrom(change),
    changeSummary: attempt.change_summary ?? "",
    reasoning: change,
    diff: change,
  });

  const holdoutFailed = !holdout.ok;
  const keep = !monitor.flagged && !holdoutFailed && anchorsVerdict.passed && comparison.improved;
  const reason = monitor.flagged
    ? `reverted by the reward-hacking monitor (${monitor.source}): ${monitor.reason}`
    : holdoutFailed
      ? `reverted: ${holdout.refusal}`
      : !anchorsVerdict.passed
        ? `reverted on an anchor: ${anchorsVerdict.reasons.join("; ")}`
        : comparison.improved
          ? `kept: ${comparison.reason}`
          : `reverted: ${comparison.reason}`;

  const consecutive = keep ? 0 : run.consecutive_reverts + 1;
  const archive = attempt.diff_ref;

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE improve_attempts
         SET status = ?2, kept = ?3, reason = ?4, score_before = ?5, score_after = ?6,
             flagged = ?7, flag_reason = ?8, anchors_json = ?9, secondary_json = ?10
         WHERE id = ?1`
      )
      .bind(
        attempt.id,
        monitor.flagged ? "flagged" : keep ? "kept" : "reverted",
        keep ? 1 : 0,
        reason,
        comparison.scoreBefore,
        comparison.scoreAfter,
        monitor.flagged ? 1 : 0,
        monitor.reason,
        JSON.stringify(anchors),
        JSON.stringify(report.secondary)
      ),
    ...scoreStatements(env.DB, run.id, run.namespace, attempt.id, { ...anchors, ...report.secondary }),
    ...(attempt.skill_id ? recordSkillOutcome(env.DB, attempt.skill_id, keep) : []),
    ...(archive
      ? await improveDocStatements(env.DB, {
          namespace: run.namespace,
          path: archive,
          title: `improve attempt ${attempt.id}`,
          type: "reference",
          action: "improve-attempt-scored",
          prior: await priorDoc(env.DB, run.namespace, archive),
          body: `${(await readDoc(env.DB, run.namespace, archive)) ?? ""}\n\n${renderOutcome({ keep, reason, monitor, comparison, anchors, report, now })}`,
        })
      : []),
    improveAudit(env.DB, keep ? "improve-kept" : "improve-reverted", run.namespace, {
      run_id: run.id,
      attempt_id: attempt.id,
      reason,
      delta: comparison.delta,
      flagged: monitor.flagged,
    }),
  ]);

  if (keep) {
    const record: BestRecord = {
      sha: attempt.head_sha ?? run.base_sha ?? "",
      run_id: run.id,
      attempt_id: attempt.id,
      recorded_at: now.toISOString(),
      anchors,
      secondary: report.secondary,
      score: comparison.scoreAfter,
    };
    await writeBest(env.APP_KV, run.namespace, record);
    // A kept change is the only thing worth abstracting into a skill.
    await maybeAbstract(env, run, attempt, change, comparison.delta);
  }

  const ceiling = run.attempts >= MAX_ATTEMPTS_PER_RUN;
  const exhausted = consecutive >= MAX_CONSECUTIVE_REVERTS;
  await advanceRun(env.DB, {
    runId: run.id,
    expected: "judging",
    next: ceiling || exhausted ? "finalizing" : "attempting",
    patch: {
      kept: run.kept + (keep ? 1 : 0),
      reverts: run.reverts + (keep ? 0 : 1),
      consecutive_reverts: consecutive,
      current_attempt: null,
      cost_usd: run.cost_usd + monitor.costUsd,
      ci_minutes: run.ci_minutes + report.ci_minutes,
      ...(exhausted
        ? { note: `${consecutive} consecutive reverts; restored to the best known commit and stopped` }
        : ceiling
          ? { note: `reached the ${MAX_ATTEMPTS_PER_RUN} attempt ceiling` }
          : {}),
    },
  });

  return { ok: true, message: reason, kept: keep };
}

async function maybeAbstract(env: Env, run: RunRow, attempt: AttemptRow, change: string, delta: number): Promise<void> {
  try {
    const abstracted = await abstractSkill(env, {
      namespace: run.namespace,
      summary: attempt.change_summary ?? "",
      reasoning: change,
      change,
      delta,
    });
    if (!abstracted.transferable) return;
    await recordSkill(env, {
      id: `${attempt.id}-skill`,
      sourceNamespace: run.namespace,
      sourceAttempt: attempt.id,
      title: abstracted.title,
      body: abstracted.body,
    });
  } catch (err) {
    // Abstraction is an enhancement, not a gate. A failure here must not undo a
    // change that was already kept on its own merits.
    console.error(`IMPROVE_ABSTRACT_FAILED ${attempt.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// A changed-path list recovered from the archive document's rendering. The
// document is the durable copy of the change, so a monitor running at ingest time
// reads the same bytes a human would.
function changedPathsFrom(change: string): string[] {
  return [...change.matchAll(/^=== (.+?) \(\d+ bytes, complete new contents\) ===$/gm)].map((m) => m[1]);
}

// ---- finalizing -------------------------------------------------------------

async function finalizeRun(env: Env, run: RunRow, now: Date): Promise<TickOutcome> {
  const attempts = await attemptsForRun(env.DB, run.id);
  const kept = attempts.filter((a) => a.kept === 1);
  let prUrl: string | null = run.pr_url;

  // NEVER AUTO-MERGE. The PR is opened and left. For germomics that is already
  // the norm; for the others this is the one exception to direct-to-main, and it
  // is an exception in the safe direction.
  if (!prUrl && kept.length > 0) {
    const head = kept[kept.length - 1];
    try {
      const pr = await openPr(
        env,
        run.namespace,
        `improve: ${run.namespace} ${chicagoDay(now)}`,
        head.branch ?? "",
        undefined,
        renderPrBody(run, attempts)
      );
      prUrl = pr.url;
    } catch (err) {
      console.error(`IMPROVE_PR_FAILED ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The drift gate runs at the END of a run, on the run's own recorded numbers
  // plus the two before it.
  const { results: recent } = await env.DB
    .prepare(
      `SELECT id, namespace, mode, started, finished, attempts, kept, reverts, cost_usd, ci_minutes, status,
              consecutive_reverts, current_attempt, base_sha, pr_url, note, condition, advanced_at
       FROM improve_runs WHERE namespace = ?1 ORDER BY started DESC LIMIT 3`
    )
    .bind(run.namespace)
    .all<RunRow>();

  const drift = driftVerdict(recent);
  const { doc } = await loadScores(env, run.namespace);
  const best = await readBest(env.APP_KV, run.namespace);
  const latestAnchors = await metricsFor(env.DB, run.id, kept.length > 0 ? kept[kept.length - 1].id : null);
  const anchorDrift = best ? anchorDriftVerdict(doc.anchors, best.anchors, latestAnchors) : { pause: false, reason: null };
  const pauseReason = anchorDrift.pause ? anchorDrift.reason : drift.pause ? drift.reason : null;

  if (pauseReason) {
    await pauseNamespace(env.APP_KV, run.namespace, pauseReason);
    await writeTaskDoc(env, run.namespace, now, renderPauseTask(run.namespace, pauseReason, drift));
  }

  const summaryPath = archivePath(run.id, "run-summary");
  await env.DB.batch([
    ...(await improveDocStatements(env.DB, {
      namespace: run.namespace,
      path: summaryPath,
      title: `improve run ${run.id}`,
      type: "reference",
      action: "improve-run-summary",
      prior: await priorDoc(env.DB, run.namespace, summaryPath),
      body: renderRunDoc(run, attempts, prUrl, pauseReason, now),
    })),
    improveAudit(env.DB, "improve-run-finished", run.namespace, {
      run_id: run.id,
      condition: run.condition,
      attempts: run.attempts,
      kept: run.kept,
      reverts: run.reverts,
      pr: prUrl,
      paused: pauseReason,
    }),
  ]);

  await advanceRun(env.DB, {
    runId: run.id,
    expected: "finalizing",
    next: pauseReason ? "paused" : "done",
    patch: { finished: now.toISOString(), pr_url: prUrl, note: pauseReason ?? run.note },
  });

  // The meta-loop runs after a run finishes, not on its own schedule, so it
  // never competes with a run for the invocation budget. It is weekly on its own
  // marker and returns immediately on every other night.
  try {
    await runMetaLoop(env, now);
  } catch (err) {
    console.error(`IMPROVE_META_FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    runId: run.id,
    namespace: run.namespace,
    from: "finalizing",
    to: pauseReason ? "paused" : "done",
    note: pauseReason ?? `${run.kept} kept, ${run.reverts} reverted${prUrl ? `, PR ${prUrl}` : ""}`,
  };
}

// ---- context and rendering --------------------------------------------------

async function gatherContext(env: Env, namespace: string): Promise<string> {
  const parts: string[] = [];
  try {
    const repo = await resolveRepo(env, namespace);
    parts.push(`Repository: ${repo.full}`);
    const tree = await listRepoTree(env, namespace);
    parts.push("Top level:", JSON.stringify(tree).slice(0, 4_000));
  } catch (err) {
    parts.push(`(repository listing unavailable: ${err instanceof Error ? err.message : String(err)})`);
  }
  const core = await readDoc(env.DB, namespace, "core.md");
  if (core) parts.push("Project core.md:", core.slice(0, 12_000));
  return parts.join("\n\n");
}

function renderObjective(doc: ScoresDoc): string {
  return [
    "Anchors (must never regress; an anchor CI did not report counts as failed):",
    ...doc.anchors.map((a) => `- ${a.metric}: ${a.kind}${a.bound === null ? "" : ` ${a.bound}`}`),
    "",
    "Secondary (what you are optimising; a tie or a loss reverts the attempt):",
    ...doc.secondary.map(
      (s) => `- ${s.metric}: ${s.direction}, weight ${s.weight}${s.stub ? " (STUB, not scored yet)" : ""}`
    ),
  ].join("\n");
}

function renderAttemptDoc(input: {
  id: string;
  run: RunRow;
  proposal: { summary: string; reasoning: string; files: Array<{ path: string; content: string }> };
  pushed: { branch: string; headSha: string };
  baseWhy: string;
  skill?: { id: string; title: string };
  now: Date;
}): string {
  return [
    `# improve attempt ${input.id}`,
    "",
    `- namespace: ${input.run.namespace}`,
    `- run: ${input.run.id}`,
    `- branch: ${input.pushed.branch}`,
    `- head: ${input.pushed.headSha}`,
    `- base selection: ${input.baseWhy}`,
    input.skill ? `- from skill: ${input.skill.id} (${input.skill.title})` : "- from skill: none, proposed fresh",
    `- dispatched: ${input.now.toISOString()}`,
    "",
    "## Summary",
    "",
    input.proposal.summary,
    "",
    "## Reasoning",
    "",
    input.proposal.reasoning,
    "",
    "## Change",
    "",
    renderChange(input.proposal.files),
    "",
  ].join("\n");
}

function renderOutcome(input: {
  keep: boolean;
  reason: string;
  monitor: { flagged: boolean; reason: string | null; source: string };
  comparison: { delta: number; compared: number; details: Array<{ metric: string; before: number | null; after: number | null; contribution: number | null; why?: string }> };
  anchors: MetricMap;
  report: ScoreReport;
  now: Date;
}): string {
  return [
    "## Outcome",
    "",
    `**${input.keep ? "KEPT" : "REVERTED"}** at ${input.now.toISOString()}.`,
    "",
    input.reason,
    "",
    `Monitor: ${input.monitor.flagged ? `FLAGGED (${input.monitor.source}) ${input.monitor.reason}` : "clean"}`,
    "",
    "| metric | before | after | contribution |",
    "| --- | --- | --- | --- |",
    ...input.comparison.details.map(
      (d) =>
        `| ${d.metric} | ${d.before ?? "-"} | ${d.after ?? "-"} | ${d.contribution === null ? `excluded (${d.why ?? "no reason"})` : d.contribution.toFixed(4)} |`
    ),
    "",
    `Anchors: ${Object.entries(input.anchors).map(([k, v]) => `${k}=${v ?? "not reported"}`).join(", ")}`,
    `Weighted delta: ${input.comparison.delta.toFixed(4)} over ${input.comparison.compared} comparable metric(s).`,
    `CI minutes: ${input.report.ci_minutes}`,
    "",
  ].join("\n");
}

function renderRunDoc(run: RunRow, attempts: AttemptRow[], prUrl: string | null, paused: string | null, now: Date): string {
  return [
    `# improve run ${run.id}`,
    "",
    `- namespace: ${run.namespace}`,
    `- mode: ${run.mode}`,
    `- condition: ${run.condition}`,
    `- started: ${run.started}`,
    `- finished: ${now.toISOString()}`,
    `- attempts: ${run.attempts}, kept: ${run.kept}, reverted: ${run.reverts}`,
    `- estimated model cost: $${run.cost_usd.toFixed(4)} (an estimate, not a bill)`,
    `- CI minutes: ${run.ci_minutes}`,
    `- PR: ${prUrl ?? "none opened (nothing was kept)"}`,
    paused ? `- **PAUSED**: ${paused}` : "",
    run.note ? `- note: ${run.note}` : "",
    "",
    "## Attempts",
    "",
    "| attempt | status | summary | reason |",
    "| --- | --- | --- | --- |",
    ...attempts.map(
      (a) => `| ${a.id} | ${a.status} | ${(a.change_summary ?? "").replace(/\|/g, "\\|")} | ${(a.reason ?? "").replace(/\|/g, "\\|")} |`
    ),
    "",
  ].join("\n");
}

function renderPrBody(run: RunRow, attempts: AttemptRow[]): string {
  return [
    `Automated improvement run \`${run.id}\`.`,
    "",
    "**Not auto-merged, and never will be.** Review it like any other PR.",
    "",
    "Kept changes:",
    ...attempts.filter((a) => a.kept === 1).map((a) => `- ${a.change_summary ?? a.id} (\`${a.id}\`)`),
    "",
    `Reverted or flagged: ${attempts.filter((a) => a.kept !== 1).length}.`,
    "",
    `Full record: \`${run.namespace}/improve/archive/${run.id}/\` in Capsid.`,
  ].join("\n");
}

function renderPauseTask(namespace: string, reason: string, drift: { attempts: number; reverts: number; runsConsidered: number }): string {
  return [
    `# improve is PAUSED in ${namespace}`,
    "",
    "type: task",
    "",
    "## Why",
    "",
    reason,
    "",
    `Measured over the last ${drift.runsConsidered} run(s): ${drift.reverts} reverts out of ${drift.attempts} attempts.`,
    "",
    "## What to do",
    "",
    `1. Read the run summaries under \`${namespace}/improve/archive/\`.`,
    "2. Decide whether the loop is failing to find good changes, or the scoring is wrong.",
    `3. To resume, delete the KV key \`improve:paused:${namespace}\`. Nothing else clears it, and nothing expires it.`,
    "",
  ].join("\n");
}

async function writeTaskDoc(env: Env, namespace: string, now: Date, body: string): Promise<void> {
  const path = runTaskPath(chicagoDay(now));
  const prior = await priorDoc(env.DB, namespace, path);
  await env.DB.batch(
    await improveDocStatements(env.DB, {
      namespace,
      path,
      title: `improve run ${chicagoDay(now)}`,
      type: "task",
      status: "ready",
      action: "improve-task",
      prior,
      body,
    })
  );
}

function renderSubscriptionTask(
  namespace: string,
  now: Date,
  doc: ScoresDoc,
  baseWhy: string,
  baseSha: string,
  skills: Array<{ id: string; title: string; winRate: number }>
): string {
  return [
    `# improve run ${chicagoDay(now)} - ${namespace}`,
    "",
    "type: task",
    "",
    "**Subscription mode.** The Worker did the selection; a Claude Code session does the work.",
    "It gathered the scores, verified the anchor checksum, and chose the base. Nothing has been",
    "changed in the repo. Execute the attempt list below with the ordinary Capsid tools.",
    "",
    "## Base",
    "",
    `- commit: \`${baseSha || "(none resolved; branch from the default branch)"}\``,
    `- why: ${baseWhy}`,
    "",
    "## What is measured",
    "",
    renderObjective(doc),
    "",
    "## Attempt list",
    "",
    `Up to ${MAX_ATTEMPTS_PER_RUN} attempts. One scoped change each, on its own branch off the base above.`,
    "After each one, run the scorer and keep it only if no anchor regressed and the weighted",
    "secondary score improved. Revert otherwise. Stop after five consecutive reverts.",
    "",
    ...(skills.length > 0
      ? [
          "Candidate skills transferred from other projects, best first. Try one; do not force a fit:",
          ...skills.map((s) => `- \`${s.id}\` ${s.title} (win rate ${(s.winRate * 100).toFixed(0)}%)`),
        ]
      : ["No transferred skills are pending for this namespace."]),
    "",
    "## What you may not touch",
    "",
    "Tests, CI workflows, lint or compiler configuration, lockfiles, package manifests, anything",
    "under `improve/`, and this namespace's `improve/scores.md`. Those are what measure the work.",
    "",
  ].join("\n");
}

// The prompt used when capsid/improve/prompts/run.md is missing. Not a
// substitute for that document: it exists so a missing prompt degrades to a
// sensible default rather than to an empty system prompt, and the run document
// records which one was used.
export const DEFAULT_RUN_PROMPT = [
  "You are improving one project in a small portfolio, one scoped change at a time.",
  "",
  "Your change is measured by CI: a build, a test suite, a hidden holdout suite, a lint count, an error count, a latency figure and a bundle size. A change is kept only if no anchor regresses and the weighted secondary score strictly improves. A tie reverts.",
  "",
  "Prefer changes whose effect the scorer can actually see. Prefer small. A change you cannot explain the measured effect of is a change that will be reverted.",
].join("\n");

// ---- status -----------------------------------------------------------------

export interface NamespaceStatus {
  namespace: string;
  paused: string | null;
  anchor_pinned: boolean;
  anchor_problem: string | null;
  best: { sha: string; score: number; recorded_at: string } | null;
  last_run: {
    id: string;
    status: string;
    started: string;
    finished: string | null;
    attempts: number;
    kept: number;
    reverts: number;
    cost_usd: number;
    ci_minutes: number;
    condition: string;
    pr_url: string | null;
    note: string | null;
  } | null;
  totals: { runs: number; attempts: number; kept: number; reverts: number; cost_usd: number; ci_minutes: number };
}

export interface StatusReport {
  mode: ImproveMode;
  mode_note: string | null;
  // Named as an estimate everywhere it appears. See the RATES comment in
  // src/improve-anthropic.ts for why a number here is not a bill.
  cost_note: string;
  namespaces: NamespaceStatus[];
}

export async function improveStatus(env: Env, only?: string): Promise<StatusReport> {
  const { mode, reason } = await readMode(env.APP_KV);
  const namespaces = only ? [only] : [...ROSTER];
  const out: NamespaceStatus[] = [];

  for (const namespace of namespaces) {
    const { doc, refusal } = await loadScores(env, namespace);
    const verification = await verifyAnchors(env.APP_KV, namespace, doc);
    const best = await readBest(env.APP_KV, namespace);
    const last = await env.DB
      .prepare(
        `SELECT id, status, started, finished, attempts, kept, reverts, cost_usd, ci_minutes, condition, pr_url, note
         FROM improve_runs WHERE namespace = ?1 ORDER BY started DESC LIMIT 1`
      )
      .bind(namespace)
      .first<NonNullable<NamespaceStatus["last_run"]>>();
    const totals = await env.DB
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(attempts),0) AS attempts, COALESCE(SUM(kept),0) AS kept,
                COALESCE(SUM(reverts),0) AS reverts, COALESCE(SUM(cost_usd),0) AS cost_usd,
                COALESCE(SUM(ci_minutes),0) AS ci_minutes
         FROM improve_runs WHERE namespace = ?1`
      )
      .bind(namespace)
      .first<NamespaceStatus["totals"]>();

    out.push({
      namespace,
      paused: await pausedReason(env.APP_KV, namespace),
      anchor_pinned: Boolean(verification.pinned),
      anchor_problem: refusal,
      best: best ? { sha: best.sha, score: best.score, recorded_at: best.recorded_at } : null,
      last_run: last ?? null,
      totals: totals ?? { runs: 0, attempts: 0, kept: 0, reverts: 0, cost_usd: 0, ci_minutes: 0 },
    });
  }

  return {
    mode,
    mode_note: reason,
    cost_note:
      "cost_usd is an ESTIMATE computed from token counts and published rates, including cache read and write multipliers. It is for sanity-checking, not accounting.",
    namespaces: out,
  };
}

// ---- the manual entry point -------------------------------------------------

export interface ManualResult {
  mode: ImproveMode;
  mode_note: string | null;
  condition: RunCondition;
  dry_run: boolean;
  opened: OpenOutcome[];
  advanced: TickOutcome[];
}

// What Capsid:improve_run calls. dry_run reports exactly what a real run would do
// and changes nothing: no branch, no dispatch, no row, no document.
export async function improveRunManual(
  env: Env,
  now: Date,
  opts: { namespace?: string; dryRun: boolean; condition?: string }
): Promise<ManualResult> {
  const { mode, reason } = await readMode(env.APP_KV);
  // An unrecognised condition is REFUSED rather than silently defaulted: a run
  // labelled 'full' that was asked to be an ablation is a row that lies, and the
  // whole point of the column is that the label is trustworthy.
  if (opts.condition !== undefined && !isRunCondition(opts.condition)) {
    throw new Error(
      `unknown condition '${opts.condition}'. Valid conditions: ${RUN_CONDITIONS.join(", ")}. Nothing was opened.`
    );
  }
  const condition: RunCondition = opts.condition ?? DEFAULT_CONDITION;
  if (opts.dryRun) {
    return { mode, mode_note: reason, condition, dry_run: true, opened: await dryRun(env, opts.namespace), advanced: [] };
  }
  const summary = await openRuns(env, now, opts.namespace, condition);
  // One tick immediately, so a hand-run does something visible rather than only
  // creating a row and waiting five minutes for the cron.
  const advanced = await tickRuns(env, now);
  return { mode: summary.mode, mode_note: summary.modeNote, condition, dry_run: false, opened: summary.outcomes, advanced };
}

// READ ONLY. Every branch in here is a read: the scores document, the anchor pin,
// the pause key, the best record, the attempt history and the repo tree. Nothing
// is written, and test/improve-tools.test.ts asserts that by driving it against a
// fake D1 and checking nothing was recorded.
async function dryRun(env: Env, only?: string): Promise<OpenOutcome[]> {
  const namespaces = only ? [only] : [...ROSTER];
  const outcomes: OpenOutcome[] = [];
  for (const namespace of namespaces) {
    const paused = await pausedReason(env.APP_KV, namespace);
    if (paused) {
      outcomes.push({ namespace, opened: false, runId: null, note: `would skip: paused (${paused})` });
      continue;
    }
    const existing = await activeRun(env.DB, namespace);
    if (existing) {
      outcomes.push({ namespace, opened: false, runId: existing.id, note: `would skip: run ${existing.id} is active in '${existing.status}'` });
      continue;
    }
    const { refusal } = await loadScores(env, namespace);
    if (refusal) {
      outcomes.push({ namespace, opened: false, runId: null, note: `would refuse: ${refusal}` });
      continue;
    }
    const best = await readBest(env.APP_KV, namespace);
    const choice = selectBase(best, await recentAttempts(env.DB, namespace, 50), null);
    outcomes.push({
      namespace,
      opened: false,
      runId: null,
      note: `would open a run and baseline ${choice.sha || "(no base resolved)"}: ${choice.why}`,
    });
  }
  return outcomes;
}
