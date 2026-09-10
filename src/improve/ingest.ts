import type { Env } from "../env";
import { monitorAttempt } from "../improve-gates";
import { MAX_ATTEMPTS_PER_RUN, MAX_CONSECUTIVE_REVERTS, type BestRecord } from "../improve-schema";
import { checkHoldout, readHoldoutManifest, type ScoreReport } from "../improve-scorer";
import { anchorVerdict, compare, type MetricMap } from "../improve-scores";
import { abstractSkill, recordSkill, recordSkillOutcome } from "../improve-skills";
import {
  advanceRun,
  attemptById,
  improveAudit,
  improveDocStatements,
  pausedReason,
  priorDoc,
  readMode,
  runById,
  writeBest,
  type AttemptRow,
  type RunRow,
} from "../improve-state";
import { changedPathsFrom, renderOutcome } from "./finalize";
import { baselineId, checkBudget, loadScores, metricsFor, readDoc, scoreStatements } from "./open";

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

  // THE THREE STOPS APPLY HERE TOO (audit 2026-09-07, Grok MAJOR 6, Opus section
  // 5 budget note). Pause was checked in openOne, mode in openOne, budget in the
  // opener and the tick. None of them was checked at ingest, so a score POST
  // still kept the change, wrote improve:best, abstracted a skill and advanced
  // the run in a namespace a human had explicitly paused, or after the mode was
  // switched off, or past the spend cap. A stop that only stops new work is not
  // a stop: the in-flight attempt is the one someone paused the namespace to
  // stop. Ingest is the last gate an attempt passes, so it is the one that has to
  // hold.
  const paused = await pausedReason(env.APP_KV, run.namespace);
  if (paused) {
    return { ok: false, message: `${run.namespace} is paused (${paused}); this score is not ingested and the attempt is not kept. Delete the pause key to resume.` };
  }
  const { mode: currentMode } = await readMode(env.APP_KV);
  if (currentMode === "off") {
    return { ok: false, message: `improve_mode is off; this score is not ingested and the attempt is not kept.` };
  }
  const budget = await checkBudget(env, now);
  if (budget.exceeded) {
    return { ok: false, message: `${budget.reason}; this score is not ingested and the attempt is not kept.` };
  }

  // THE HOLDOUT CHECK, before anything is believed. A report that disagrees with
  // the manifest about how many hidden tests exist is refused outright.
  const manifest = await readHoldoutManifest(env, run.namespace);
  const holdout = checkHoldout(manifest, report);

  const anchors: MetricMap = { ...report.anchors, holdout_pass_rate: holdout.passRate };
  const isBaseline = report.attempt_id === baselineId(run.id);

  if (isBaseline) {
    // BIND THE BASELINE LIKE AN ATTEMPT (audit 2026-09-07, Grok MAJOR 5). Until
    // now the baseline branch only had to name `<run>-baseline` and win the CAS.
    // It was not checked against the run's in-flight attempt or against the
    // commit it claimed to measure, so a rerun of the baseline Actions job after
    // the run had moved on, or a hand dispatch naming that attempt_id with a
    // chosen branch, would overwrite the run's baseline metrics with a
    // measurement of something else. Every later comparison is against those
    // numbers, so this is the one row that silently changes every verdict.
    //
    // The baseline branch is created at base_sha and nothing is committed to it,
    // so its head IS base_sha. That is what the report must carry.
    if (run.current_attempt !== report.attempt_id) {
      return {
        ok: true,
        message: `run ${run.id} is not awaiting its baseline (current attempt: ${run.current_attempt ?? "none"}); ignored as a duplicate or stale baseline report`,
      };
    }
    if ((run.base_sha ?? "") !== report.head_sha) {
      return {
        ok: false,
        message: `baseline report head_sha ${report.head_sha} does not match run ${run.id} base_sha ${run.base_sha ?? "(none)"}: the report measured a different commit`,
      };
    }
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
      // Checked (audit 2026-09-06): a lost judging CAS means a tick's stale
      // guard reclaimed the run mid-ingest, and pretending the stop landed would
      // report a state the row does not hold.
      const stopped = await advanceRun(env.DB, {
        runId: run.id,
        expected: "judging",
        next: "finalizing",
        patch: { note: `the base commit fails its own anchors: ${verdict.reasons.join("; ")}`, ci_minutes: run.ci_minutes + report.ci_minutes },
      });
      return {
        ok: true,
        message: stopped
          ? "baseline recorded; the base fails its own anchors, so the run stops"
          : "baseline recorded; the base fails its own anchors, but the run moved out of judging mid-ingest and was not transitioned here",
      };
    }
    const resumed = await advanceRun(env.DB, { runId: run.id, expected: "judging", next: "attempting", patch: { current_attempt: null, ci_minutes: run.ci_minutes + report.ci_minutes } });
    return {
      ok: true,
      message: resumed ? "baseline recorded" : "baseline recorded, but the run moved out of judging mid-ingest and was not transitioned here",
    };
  }

  const attempt = await attemptById(env.DB, report.attempt_id);
  if (!attempt) return { ok: false, message: `unknown attempt ${report.attempt_id}` };

  // BIND THE REPORT TO THE RUN'S IN-FLIGHT ATTEMPT (audit 2026-09-06). Before this,
  // ingest looked the attempt up by id alone and moved on: a signed report minted by
  // ci_dispatch of the scorer against an arbitrary ref, or a captured report
  // replayed, could score a DIFFERENT attempt (or the same run's stale attempt, or
  // the attempt's code at a different commit) than the one the run is waiting on.
  // Three checks close that:
  //   1. the attempt belongs to this run,
  //   2. the run is still awaiting a score for THIS attempt (else it is a
  //      duplicate, a replay, or a report for an attempt already decided), and
  //   3. the report scored the commit the attempt actually pushed, not some other
  //      ref (this is the ci_dispatch-against-master defeat).
  if (attempt.run_id !== run.id) {
    return { ok: false, message: `attempt ${attempt.id} belongs to run ${attempt.run_id}, not ${run.id}` };
  }
  if (run.status !== "awaiting-score" || run.current_attempt !== report.attempt_id) {
    return {
      ok: true,
      message: `run ${run.id} is not awaiting a score for ${report.attempt_id}; ignored as a duplicate or stale report`,
    };
  }
  if ((attempt.head_sha ?? "") !== report.head_sha) {
    return {
      ok: false,
      message: `report head_sha ${report.head_sha} does not match attempt ${attempt.id} head_sha ${attempt.head_sha ?? "(none)"}: the report scored a different commit`,
    };
  }

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
        // STATUS-KEYED with RETURNING (audit 2026-09-06). The run-level judging CAS
        // above already serialises ingest, but keying the attempt write on its own
        // awaiting-score status makes a late or duplicated write unable to flip an
        // attempt that a timeout already marked timed-out, or score one twice.
        `UPDATE improve_attempts
         SET status = ?2, kept = ?3, reason = ?4, score_before = ?5, score_after = ?6,
             flagged = ?7, flag_reason = ?8, anchors_json = ?9, secondary_json = ?10
         WHERE id = ?1 AND status = 'awaiting-score'
         RETURNING id`
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
  // Checked (audit 2026-09-06): the verdict above is already committed on the
  // attempt row; if a tick's stale guard reclaimed the run while it was being
  // judged, the counters were not advanced here and the caller is told so.
  const advanced = await advanceRun(env.DB, {
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

  return {
    ok: true,
    message: advanced ? reason : `${reason} (the run moved out of judging mid-ingest; its counters were not updated here)`,
    kept: keep,
  };
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
