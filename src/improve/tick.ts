import type { Env } from "../env";
import { dispatchWorkflow } from "../github";
import { autoMergeTick } from "../auto-merge";
import { runEvaluationCycle } from "../skills-evaluate";
import { sweepIfDue } from "../outcome-prs";
import { expireJobLeases } from "../jobs";
import { gatherFindings, watcherTick } from "../watcher";
import { proposeChange, pushAttempt } from "../improve-attempt";
import { pathMonitor } from "../improve-gates";
import {
  MAX_ATTEMPTS_PER_RUN,
  MAX_CONSECUTIVE_REVERTS,
  RUN_MAX_AGE_MS,
  SCORE_TIMEOUT_MS,
  SCORER_WORKFLOW,
  archivePath,
  attemptId,
  branchName,
  RUN_PROMPT_PATH,
  type RunStatus,
} from "../improve-schema";
import { selectBase } from "../improve-select";
import { candidateSkills, readSkillBody, recordSkillOutcome } from "../improve-skills";
import {
  activeRun,
  advanceableRuns,
  advanceRun,
  attemptById,
  attemptsForRun,
  improveAudit,
  improveDocStatements,
  priorDoc,
  readBest,
  type RunRow,
} from "../improve-state";
import { finalizeRun, gatherContext, renderAttemptDoc, renderObjective } from "./finalize";
import { baselineId, enforceBudget, loadScores, readDoc, recentAttempts } from "./open";

// How many runs one tick will advance. Bounded so a tick cannot exceed its
// invocation budget when every namespace is mid-run; the ones not reached this
// tick are reached five minutes later, ordered oldest-advanced-first.
const RUNS_PER_TICK = 3;

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

// ---- the tick ---------------------------------------------------------------

export interface TickOutcome {
  runId: string;
  namespace: string;
  from: string;
  to: string;
  note: string;
}

export async function tickRuns(env: Env, now: Date): Promise<TickOutcome[]> {
  // THE WORK QUEUE'S LEASE SWEEP RIDES THIS TICK, before anything else and outside
  // the budget check. It spends nothing: no model call, no GitHub call, one keyed
  // UPDATE. Gating it on the budget would leave a job held by a session that died
  // for as long as the caps were exceeded, which is the state the sweep exists to
  // clear, and an exhausted budget is exactly when nobody is watching.
  //
  // Reported through console rather than in TickOutcome, which describes improve
  // RUNS. A requeued job is not a run transition and folding it into that shape
  // would make the loop's own outcome list lie about what it advanced.
  const expired = await expireJobLeases(env, now);
  if (expired.requeued.length > 0) {
    console.log(`JOB_LEASE_EXPIRED returned ${expired.requeued.length} job(s) to queued: ${expired.requeued.join(", ")}`);
  }

  // AUTO-MERGE RIDES THIS TICK TOO, on the same reasoning as the lease sweep and with
  // the same placement: before the runs, outside the budget check. It spends no model
  // tokens and no CI minutes, and an exhausted improve budget says nothing about
  // whether a driver's finished pull request should land. The policy document decides
  // whether it does anything at all, and it ships disabled.
  try {
    const merged = await autoMergeTick(env, now);
    if (merged.ran) console.log(`AUTO_MERGE ${merged.note}`);
  } catch (err) {
    // A throwing merge step does not stop the improve runs advancing.
    console.error(`AUTO_MERGE_THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  // THE SKILL EVALUATION CYCLE rides this tick too, and gates itself on its own
  // cadence rather than on the tick's: the tick runs every five minutes and the cycle
  // runs fortnightly, so all but one invocation in four thousand returns immediately
  // after one KV read. Placed with the others, before the budget check, because it
  // spends CI rather than model tokens and an exhausted model budget says nothing
  // about whether a skill is still earning its place.
  try {
    const cycle = await runEvaluationCycle(env, now);
    if (cycle.ran) console.log(`SKILL_CYCLE ${cycle.note}`);
  } catch (err) {
    console.error(`SKILL_CYCLE_THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  // THE WATCHER rides this tick too, on its own half-hourly stamp, and is placed with
  // the others for the same reason: it spends no model tokens and no CI minutes, and
  // an exhausted improve budget is exactly when nobody is looking at the surface. It
  // only ever POSTS A JOB, so the worst a broken pass can do is add a row to a queue.
  try {
    const watched = await watcherTick(env, now, () => gatherFindings(env, now));
    if (watched.ran) console.log(`WATCHER ${watched.note}`);
  } catch (err) {
    console.error(`WATCHER_THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  // THE MERGE-STATE SWEEP, daily, on its own stamp. Every outcome row records a pull
  // request as unmerged because the driver blocks and the seat merges afterwards; the
  // merge path corrects the rows it can see, and this catches the ones it could not:
  // a merge done with gh rather than manage_pr, and every row written before the join
  // table existed. Bounded per sweep, so the cost is fixed however far behind it is.
  try {
    const swept = await sweepIfDue(env, now);
    if (swept) console.log(`OUTCOME_SWEEP checked ${swept.checked}, changed ${swept.changed}, seeded ${swept.seeded}`);
  } catch (err) {
    console.error(`OUTCOME_SWEEP_THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  const runs = await advanceableRuns(env.DB, RUNS_PER_TICK);
  // THE BUDGET COMES FIRST: an exceeded cap advances nothing, dispatches nothing,
  // calls nothing. Active runs are left where they are and reported; the first tick
  // after the caps rise or the month turns resumes them, and RUN_MAX_AGE finalizes any
  // that aged out.
  if (runs.length > 0) {
    const budgetReason = await enforceBudget(env, now);
    if (budgetReason) {
      return runs.map((run) => ({ runId: run.id, namespace: run.namespace, from: run.status, to: run.status, note: budgetReason }));
    }
  }
  const outcomes: TickOutcome[] = [];
  for (const run of runs) {
    // Captured BEFORE the step runs: the claim CAS moves the row's status, so by
    // the time the catch reads it, run.status can already say 'awaiting-score'
    // about work that began in 'attempting'.
    const entered = run.status;
    try {
      outcomes.push(await advanceOne(env, run, now));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`IMPROVE_TICK_THREW ${run.id} in '${entered}': ${message}`);
      // A throwing step does NOT wedge the run: it is finalized with the error
      // recorded. The alternative is a namespace whose one active-run slot is held
      // forever by a run nothing can advance.
      //
      // TWO CAS ATTEMPTS (audit 2026-09-06, Grok MAJOR 21). The steps claim the run
      // (opening/attempting -> awaiting-score) BEFORE their external calls, so a step
      // that throws mid-work has usually already moved the run past the status this
      // loop read. The first CAS covers a throw before the claim; the re-read covers a
      // throw after it. A losing tick returns at the failed claim and cannot reach
      // here, and a run that went terminal has no active row.
      const finalize = (expected: RunStatus) =>
        advanceRun(env.DB, {
          runId: run.id,
          expected,
          next: "finalizing",
          patch: { note: `a step threw in '${entered}': ${message.slice(0, 400)}` },
        });
      if (!(await finalize(entered))) {
        const current = await activeRun(env.DB, run.namespace);
        if (current && current.id === run.id) await finalize(current.status);
      }
      outcomes.push({ runId: run.id, namespace: run.namespace, from: entered, to: "finalizing", note: message });
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
    case "judging": {
      // Only ever held inside an HTTP score ingest. A run found here by a tick may mean
      // that request died mid-decision, or that the ingest is alive right now: the
      // five-minute tick and an HTTP ingest overlap freely, and yanking a live ingest's
      // run back to awaiting-score re-opens it to the duplicate report the judging CAS
      // excludes (audit 2026-09-06, Grok MAJOR 21). Judging is left alone until
      // advanced_at says the ingest is dead: no request lives SCORE_TIMEOUT_MS.
      const heldMs = now.getTime() - Date.parse(`${run.advanced_at.replace(" ", "T")}Z`);
      if (heldMs < SCORE_TIMEOUT_MS) {
        return { runId: run.id, namespace: run.namespace, from: "judging", to: "judging", note: `an ingest holds this run (${Math.round(heldMs / 1000)}s); left alone` };
      }
      await advanceRun(env.DB, { runId: run.id, expected: "judging", next: "awaiting-score" });
      return { runId: run.id, namespace: run.namespace, from: "judging", to: "awaiting-score", note: "a score ingest did not finish; returned to awaiting-score" };
    }
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
  // THE CLAIM COMES BEFORE ANY GITHUB CALL (audit 2026-09-06, Grok MAJOR 21). Two
  // overlapping cron ticks both read this run as 'opening'; without the CAS both
  // pushed the branch and both dispatched the scorer, and the loser's eventual failed
  // transition could not un-run the duplicate CI job. Exactly one tick wins the CAS,
  // the loser returns without spending anything, and a throw AFTER the claim is
  // finalized by the tick loop's catch from the claimed status.
  const claimed = await advanceRun(env.DB, {
    runId: run.id,
    expected: "opening",
    next: "awaiting-score",
    patch: { current_attempt: id },
  });
  if (!claimed) {
    return { runId: run.id, namespace: run.namespace, from: "opening", to: run.status, note: "another tick claimed this run first; nothing dispatched" };
  }
  // An empty push: the branch is created at the base commit and nothing is
  // written to it, which is exactly what "measure the base" means.
  await pushAttempt(env, { namespace: run.namespace, branch, baseSha: run.base_sha, summary: "baseline", files: [] });
  await dispatchWorkflow(env, run.namespace, SCORER_WORKFLOW, { branch, run_id: run.id, attempt_id: id });
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

  const index = run.attempts + 1;
  const id = attemptId(run.id, index);
  const branch = branchName(id);
  // THE CLAIM COMES BEFORE ANY ANTHROPIC OR GITHUB CALL (audit 2026-09-06, Grok MAJOR
  // 21). Two overlapping ticks both read this run as 'attempting'; without the CAS both
  // paid for a model proposal and both pushed and dispatched it. awaiting-score doubles
  // as the working status: the attempt id is claimed as current_attempt, a loser tick
  // arriving during the work sees a young awaiting-score and waits, and a claim owner
  // that dies mid-work is resolved by the stale guard as "no score report".
  const claimed = await advanceRun(env.DB, {
    runId: run.id,
    expected: "attempting",
    next: "awaiting-score",
    patch: { current_attempt: id },
  });
  if (!claimed) {
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: run.status, note: "another tick claimed this run first; nothing spent" };
  }

  const { doc, refusal } = await loadScores(env, run.namespace);
  if (refusal) {
    await advanceRun(env.DB, { runId: run.id, expected: "awaiting-score", next: "finalizing", patch: { note: refusal } });
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "finalizing", note: refusal };
  }

  const priorAttempts = await attemptsForRun(env.DB, run.id);
  const best = await readBest(env.APP_KV, run.namespace);
  // CONDITION 'no-memory': lineage history is withheld from base selection, so the run
  // branches from the best record alone and cannot follow a fertile branch. Withholding
  // the input is the only way the recorded condition means anything.
  const lineage = run.condition === "no-memory" ? [] : await recentAttempts(env.DB, run.namespace, 50);
  const choice = selectBase(best, lineage, run.base_sha);
  const baseSha = choice.sha || run.base_sha || "";

  // A transferred skill is offered on the FIRST attempt of a run only. Later attempts
  // explore from what this run has learned, and spending every attempt on another
  // project's ideas would leave no room for its own thread.
  //
  // CONDITION 'no-transfer': no cross-project skill is offered.
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
      expected: "awaiting-score",
      next: run.consecutive_reverts + 1 >= MAX_CONSECUTIVE_REVERTS ? "finalizing" : "attempting",
      patch: {
        attempts: run.attempts + 1,
        reverts: run.reverts + 1,
        consecutive_reverts: run.consecutive_reverts + 1,
        cost_usd: run.cost_usd + proposal.costUsd,
        current_attempt: null,
      },
    });
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "attempting", note };
  }

  // THE DETERMINISTIC PATH MONITOR RUNS BEFORE THE BRANCH IS PUSHED (audit
  // 2026-09-06). It used to run only at ingest, after pushAttempt and dispatchWorkflow
  // had put the attempt's files on a branch and started CI on them: a change adding a
  // package.json postinstall, or a new .github/workflows/*.yml with `on: push`,
  // executed in CI with secrets in scope before the monitor flagged it, and a revert
  // cannot un-run that. The model half still runs at ingest for cases a pattern cannot
  // name; this is the half decidable with no push and no key.
  const preflight = pathMonitor(proposal.changedPaths);
  if (preflight.flagged) {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO improve_attempts (id, namespace, run_id, change_summary, reason, lineage_parent, status, base_sha, skill_id, kept, flagged, flag_reason)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'flagged', ?7, ?8, 0, 1, ?5)`
        )
        .bind(id, run.namespace, run.id, proposal.summary || null, preflight.reason, choice.attemptId, baseSha, skill?.id ?? null),
      ...(skill ? recordSkillOutcome(env.DB, skill.id, false) : []),
    ]);
    await advanceRun(env.DB, {
      runId: run.id,
      expected: "awaiting-score",
      next: run.consecutive_reverts + 1 >= MAX_CONSECUTIVE_REVERTS ? "finalizing" : "attempting",
      patch: {
        attempts: run.attempts + 1,
        reverts: run.reverts + 1,
        consecutive_reverts: run.consecutive_reverts + 1,
        cost_usd: run.cost_usd + proposal.costUsd,
        current_attempt: null,
      },
    });
    return { runId: run.id, namespace: run.namespace, from: "attempting", to: "attempting", note: `reverted before push: ${preflight.reason}` };
  }

  const pushed = await pushAttempt(env, {
    namespace: run.namespace,
    branch,
    baseSha,
    summary: proposal.summary,
    files: proposal.files,
  });

  // The archive document is written BEFORE the score arrives, so a change that is never
  // scored still leaves a record of what was tried. "Never delete" means the record
  // survives the outcome, including the outcome "nothing came back".
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

  await dispatchWorkflow(env, run.namespace, SCORER_WORKFLOW, { branch, run_id: run.id, attempt_id: id });
  // The status was claimed at the top; this books the attempt and the spend, and
  // refreshes advanced_at so the stale guard measures from the dispatch.
  await advanceRun(env.DB, {
    runId: run.id,
    expected: "awaiting-score",
    next: "awaiting-score",
    patch: { current_attempt: id, attempts: run.attempts + 1, cost_usd: run.cost_usd + proposal.costUsd },
  });
  return { runId: run.id, namespace: run.namespace, from: "attempting", to: "awaiting-score", note: `attempt ${index} dispatched on ${branch}` };
}

// THE STALE GUARD. A dispatched scorer that has not reported in 20 minutes is treated
// as a revert and the run continues. Never a wedge: the arc's ruling is that a missing
// score is a revert, and this is where "missing" is decided.
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
    // A baseline that never scores makes every later comparison unprovable, so the run
    // ends here rather than making ten attempts that must all revert.
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
