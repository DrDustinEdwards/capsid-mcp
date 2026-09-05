// The meta-loop: the system proposing an edit to its own instructions.
//
// THE ONE THING TO UNDERSTAND ABOUT THIS FILE IS WHAT IT CANNOT DO.
//
// It cannot edit the run prompt. It cannot edit any scores document. It cannot
// touch the holdout bucket, the anchor pins, or the gate logic. Its entire write
// surface is one prefix, capsid improve/proposals/, and `assertProposalTarget`
// below is the function that enforces it. Every write this module makes goes
// through that check, and test/improve-meta.test.ts drives it against the paths
// it must refuse.
//
// The reason is not that the meta-loop is expected to misbehave. It is that a
// system which can edit its own objective has no objective, and the distinction
// between "proposes an edit" and "applies an edit" is the entire safety property.
// A human reads the proposal and applies it, or does not.

import { callModel } from "./improve-anthropic";
import type { Env } from "./env";
import {
  chicagoDay,
  META_INTERVAL_MS,
  META_LAST_KEY,
  PROPOSAL_PREFIX,
  proposalPath,
  RUN_PROMPT_PATH,
  SCORES_PATH,
} from "./improve-schema";
import { improveDocStatements, priorDoc } from "./improve-state";

// WHAT THE META-LOOP MAY NEVER WRITE, by path, whatever namespace it is in.
// Listed by name as well as covered by the prefix rule, so the refusal message
// can say which protected thing was aimed at rather than only that the path was
// not a proposal.
export const META_PROTECTED_PATHS = [SCORES_PATH, RUN_PROMPT_PATH];

export interface ProposalTarget {
  namespace: string;
  path: string;
}

// Returns null when the write is allowed, or the refusal.
//
// THREE CONDITIONS, ALL REQUIRED: the capsid namespace, the proposals prefix, and
// not one of the named protected documents. The third is redundant against the
// second today and is kept anyway, because the redundancy is what survives
// someone later deciding a scores document should live under improve/proposals/.
export function assertProposalTarget(target: ProposalTarget): string | null {
  if (META_PROTECTED_PATHS.includes(target.path)) {
    return `the meta-loop may not write ${target.namespace}/${target.path}: it is one of the documents the loop is measured against. It may only propose, under ${PROPOSAL_PREFIX}.`;
  }
  if (target.namespace !== "capsid") {
    return `the meta-loop may only write to the capsid namespace, not '${target.namespace}'. Its entire write surface is capsid/${PROPOSAL_PREFIX}.`;
  }
  if (!target.path.startsWith(PROPOSAL_PREFIX)) {
    return `the meta-loop may only write under ${PROPOSAL_PREFIX}, not '${target.path}'. It proposes; a human applies.`;
  }
  // A proposal path that climbs back out of its own prefix is the obvious
  // evasion, and docPath's grammar refuses "..' on the write tool. This module
  // does not go through that grammar, so it checks here too.
  if (target.path.includes("..")) {
    return `the meta-loop may not write a path containing '..': '${target.path}'`;
  }
  return null;
}

// Once per week. The marker is a KV key holding an ISO timestamp; an unreadable
// or unparseable marker means "due", because the failure mode of running the
// meta-loop twice is a duplicate proposal document nobody has to act on, and the
// failure mode of never running it is that the run prompt never improves.
export async function metaIsDue(kv: KVNamespace, now: Date): Promise<boolean> {
  try {
    const raw = await kv.get(META_LAST_KEY);
    if (!raw) return true;
    const last = Date.parse(raw);
    if (Number.isNaN(last)) return true;
    return now.getTime() - last >= META_INTERVAL_MS;
  } catch {
    return true;
  }
}

export interface AggregateRow {
  namespace: string;
  runs: number;
  attempts: number;
  kept: number;
  reverts: number;
  flagged: number;
  cost_usd: number;
}

// The evidence the proposal is built from. Aggregate only: the meta-loop reasons
// about the loop's behaviour across namespaces, not about any one diff.
export async function aggregate(db: D1Database, sinceDays: number): Promise<AggregateRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.namespace,
              COUNT(DISTINCT r.id) AS runs,
              COALESCE(SUM(r.attempts), 0) AS attempts,
              COALESCE(SUM(r.kept), 0) AS kept,
              COALESCE(SUM(r.reverts), 0) AS reverts,
              COALESCE(SUM(r.cost_usd), 0) AS cost_usd,
              (SELECT COUNT(*) FROM improve_attempts a WHERE a.namespace = r.namespace AND a.flagged = 1
                 AND a.ts > datetime('now', ?1)) AS flagged
       FROM improve_runs r
       WHERE r.started > datetime('now', ?1)
       GROUP BY r.namespace
       ORDER BY r.namespace`
    )
    .bind(`-${sinceDays} days`)
    .all<AggregateRow>();
  return results;
}

const META_SYSTEM = [
  "You are reviewing the instructions given to an automated self-improvement loop, and proposing one edit to them.",
  "",
  "You are given the current instructions and aggregate outcomes across several projects: how many attempts were made, how many were kept, how many were reverted, how many were flagged as reward hacking, and what it cost.",
  "",
  "Propose ONE change to the instructions, with the evidence for it. Good proposals are specific and small: a constraint that is being ignored and should be restated, guidance that is producing a failure mode visible in the numbers, an instruction that is causing over-cautious or over-broad changes.",
  "",
  "You may NOT propose changes to what is measured, to the anchor metrics, to the scoring thresholds, or to the gates that revert an attempt. Those are outside your remit and a proposal touching them will be discarded. If the numbers suggest the problem is the scoring rather than the instructions, say that in the rationale rather than proposing a scoring change.",
  "",
  "If the evidence does not support any change, say so. A week with no proposal is a normal outcome and is better than a proposal invented to fill a slot.",
].join("\n");

const META_SCHEMA = {
  type: "object",
  properties: {
    propose: { type: "boolean", description: "False when the evidence does not support a change this week." },
    rationale: { type: "string", description: "The evidence, in two or three sentences, citing the numbers." },
    revised_prompt: {
      type: "string",
      description: "The complete proposed new run prompt. Empty string when propose is false.",
    },
  },
  required: ["propose", "rationale", "revised_prompt"],
  additionalProperties: false,
} as const;

export interface MetaResult {
  ran: boolean;
  proposed: boolean;
  path: string | null;
  note: string;
  costUsd: number;
}

export async function runMetaLoop(env: Env, now: Date): Promise<MetaResult> {
  if (!(await metaIsDue(env.APP_KV, now))) {
    return { ran: false, proposed: false, path: null, note: "not due; the meta-loop runs weekly", costUsd: 0 };
  }

  const rows = await aggregate(env.DB, 14);
  const totalAttempts = rows.reduce((n, r) => n + r.attempts, 0);
  if (totalAttempts === 0) {
    // Marker still written: "there was nothing to reason about" is a completed
    // weekly run, and not writing it would make the loop retry every tick.
    await env.APP_KV.put(META_LAST_KEY, now.toISOString());
    return { ran: true, proposed: false, path: null, note: "no attempts in the last 14 days; nothing to reason about", costUsd: 0 };
  }

  const current = await env.DB.prepare("SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1")
    .bind(RUN_PROMPT_PATH)
    .first<{ body: string | null }>();

  const result = await callModel(env, {
    stage: "meta",
    system: META_SYSTEM,
    schema: META_SCHEMA as unknown as Record<string, unknown>,
    user: [
      "## Current instructions",
      current?.body ?? "(the run prompt document is missing)",
      "",
      "## Aggregate outcomes, last 14 days",
      "namespace | runs | attempts | kept | reverted | flagged | cost_usd",
      ...rows.map(
        (r) =>
          `${r.namespace} | ${r.runs} | ${r.attempts} | ${r.kept} | ${r.reverts} | ${r.flagged} | ${r.cost_usd.toFixed(2)}`
      ),
      "",
      `Portfolio kept rate: ${((rows.reduce((n, r) => n + r.kept, 0) / totalAttempts) * 100).toFixed(0)}% of ${totalAttempts} attempts.`,
    ].join("\n"),
  });

  await env.APP_KV.put(META_LAST_KEY, now.toISOString());

  if (result.refused || !result.parsed) {
    return { ran: true, proposed: false, path: null, note: "the meta-loop produced no usable answer", costUsd: result.costUsd };
  }
  const parsed = result.parsed as { propose?: unknown; rationale?: unknown; revised_prompt?: unknown };
  if (parsed.propose !== true || typeof parsed.revised_prompt !== "string" || parsed.revised_prompt.trim().length === 0) {
    return {
      ran: true,
      proposed: false,
      path: null,
      note: `no proposal this week: ${typeof parsed.rationale === "string" ? parsed.rationale : "no rationale given"}`,
      costUsd: result.costUsd,
    };
  }

  const path = proposalPath("run-prompt", chicagoDay(now));
  // THE GATE. Every write from this module passes through it, including this one,
  // which is constructed from a constant and could not fail. It is checked anyway
  // so the guard has exactly one bypass count: zero.
  const refusal = assertProposalTarget({ namespace: "capsid", path });
  if (refusal) {
    return { ran: true, proposed: false, path: null, note: `refused by the proposal gate: ${refusal}`, costUsd: result.costUsd };
  }

  const prior = await priorDoc(env.DB, "capsid", path);
  await env.DB.batch(
    await improveDocStatements(env.DB, {
      namespace: "capsid",
      path,
      title: `Proposal: run prompt, ${chicagoDay(now)}`,
      type: "spec",
      // draft, not published. A proposal is not in force and its status says so.
      status: "draft",
      action: "improve-meta-proposal",
      prior,
      body: [
        `# Proposal: run prompt, ${chicagoDay(now)}`,
        "",
        "**NOT APPLIED.** The meta-loop proposes; a human applies. To accept this, copy the",
        `revised prompt below over \`capsid/${RUN_PROMPT_PATH}\` yourself. Nothing automated will.`,
        "",
        "## Rationale",
        "",
        typeof parsed.rationale === "string" ? parsed.rationale : "(none given)",
        "",
        "## Evidence",
        "",
        "| namespace | runs | attempts | kept | reverted | flagged | cost (usd) |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...rows.map(
          (r) =>
            `| ${r.namespace} | ${r.runs} | ${r.attempts} | ${r.kept} | ${r.reverts} | ${r.flagged} | ${r.cost_usd.toFixed(2)} |`
        ),
        "",
        "## Proposed run prompt",
        "",
        "```markdown",
        parsed.revised_prompt.trim(),
        "```",
        "",
      ].join("\n"),
    })
  );

  return { ran: true, proposed: true, path, note: "proposal written; apply it by hand or ignore it", costUsd: result.costUsd };
}
