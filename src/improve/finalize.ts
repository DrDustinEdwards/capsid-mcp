import type { Env } from "../env";
import { listRepoTree, openPr, resolveRepo } from "../github";
import { renderChange } from "../improve-attempt";
import { anchorDriftVerdict, driftVerdict } from "../improve-gates";
import { runMetaLoop } from "../improve-meta";
import { archivePath, chicagoDay } from "../improve-schema";
import type { ScoreReport } from "../improve-scorer";
import type { MetricMap } from "../improve-scores";
import {
  advanceRun,
  attemptsForRun,
  improveAudit,
  improveDocStatements,
  pauseNamespace,
  priorDoc,
  readBest,
  type AttemptRow,
  type RunRow,
} from "../improve-state";
import { loadScores, metricsFor, readDoc, writeTaskDoc } from "./open";

export { renderObjective } from "./open";

// A changed-path list recovered from the archive document's rendering. The
// document is the durable copy of the change, so a monitor running at ingest time
// reads the same bytes a human would.
export function changedPathsFrom(change: string): string[] {
  return [...change.matchAll(/^=== (.+?) \(\d+ bytes, complete new contents\) ===$/gm)].map((m) => m[1]);
}

// ---- finalizing -------------------------------------------------------------

export async function finalizeRun(
  env: Env,
  run: RunRow,
  now: Date
): Promise<{ runId: string; namespace: string; from: string; to: string; note: string }> {
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

export async function gatherContext(env: Env, namespace: string): Promise<string> {
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

export function renderAttemptDoc(input: {
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

export function renderOutcome(input: {
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
