// Cross-project transfer: what one project learned, offered to the others.
//
// THE CLAIM BEING TESTED. When an attempt is kept in foxing, the specific diff is
// worthless everywhere else; the reason it worked might not be. So a kept attempt
// is abstracted into a SKILL (a short, codebase-agnostic statement of the idea),
// and on the next run every other namespace gets the applicable skills as
// candidate attempts, scored by its own scorer against its own anchors.
//
// THE SKILL IS NEVER TRUSTED. It is a candidate, not an instruction: it goes
// through the identical attempt path (propose, monitor, score, keep or revert),
// so a skill that does not transfer is reverted like any other bad idea and its
// loss is recorded. Wins and losses accumulate per skill, which is what makes the
// question "does cross-project transfer work at all" answerable rather than
// assumed.

import { callModel } from "./improve-anthropic";
import type { Env } from "./env";
import { skillPath } from "./improve-schema";
import { improveDocStatements, IMPROVE_ACTOR, priorDoc } from "./improve-state";

export interface SkillRow {
  id: string;
  source_namespace: string;
  title: string;
  body_ref: string;
  wins: number;
  losses: number;
  source_attempt: string | null;
  ts: string;
}

const SKILL_SCHEMA = {
  type: "object",
  properties: {
    transferable: {
      type: "boolean",
      description: "False when the change is specific to this codebase and has no general form worth recording.",
    },
    title: { type: "string", description: "Five to ten words naming the idea. Empty when transferable is false." },
    body: {
      type: "string",
      description:
        "The idea in general terms: what pattern to look for, what to change, and what it should improve. No file paths, no framework names unless the idea is genuinely about that framework, no code from the original diff.",
    },
  },
  required: ["transferable", "title", "body"],
  additionalProperties: false,
} as const;

const ABSTRACT_SYSTEM = [
  "A change was made in one codebase, measured, and kept because it improved that codebase's score.",
  "Your job is to decide whether the IDEA behind it generalizes to other, unrelated codebases, and if so to state it in a form another project could act on.",
  "",
  "Most changes do not generalize. A fix to one function, a correction to one config value, a change that depends on a specific library version: these are worth keeping and not worth transferring. Say transferable: false for those. Being wrong in that direction costs one skill; being wrong the other way sends four projects down a path that only made sense in the fifth.",
  "",
  "A transferable skill names a PATTERN to look for and a CHANGE to make when it is found. It does not name files, functions, or the project it came from.",
].join("\n");

export interface AbstractResult {
  transferable: boolean;
  title: string;
  body: string;
  costUsd: number;
}

export async function abstractSkill(
  env: Env,
  input: { namespace: string; summary: string; reasoning: string; change: string; delta: number }
): Promise<AbstractResult> {
  const result = await callModel(env, {
    stage: "abstract",
    system: ABSTRACT_SYSTEM,
    schema: SKILL_SCHEMA as unknown as Record<string, unknown>,
    user: [
      `Project: ${input.namespace}`,
      `Summary: ${input.summary}`,
      `Stated reasoning: ${input.reasoning}`,
      `Measured secondary score delta: ${input.delta.toFixed(4)}`,
      "",
      "The change:",
      input.change.slice(0, 40_000),
    ].join("\n"),
  });

  if (result.refused || !result.parsed) return { transferable: false, title: "", body: "", costUsd: result.costUsd };
  const parsed = result.parsed as { transferable?: unknown; title?: unknown; body?: unknown };
  const transferable = parsed.transferable === true && typeof parsed.body === "string" && parsed.body.trim().length > 0;
  return {
    transferable,
    title: typeof parsed.title === "string" ? parsed.title : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
    costUsd: result.costUsd,
  };
}

// Record a skill: a row in improve_skills and a document in the capsid namespace.
// Both, in one batch, for the same reason every other write here does it: a row
// pointing at a document that does not exist is a dangling reference nothing
// repairs.
export async function recordSkill(
  env: Env,
  skill: { id: string; sourceNamespace: string; sourceAttempt: string; title: string; body: string }
): Promise<void> {
  const path = skillPath(skill.id);
  const prior = await priorDoc(env.DB, "capsid", path);
  const docStatements = await improveDocStatements(env.DB, {
    namespace: "capsid",
    path,
    title: skill.title,
    type: "reference",
    action: "improve-skill",
    prior,
    body: [
      `# ${skill.title}`,
      "",
      `Abstracted from a change kept in **${skill.sourceNamespace}** (attempt \`${skill.sourceAttempt}\`).`,
      "",
      "This is a CANDIDATE, not a rule. Every namespace that receives it runs it through the",
      "ordinary attempt path and keeps it only if its own scorer says so. Wins and losses are",
      "counted in the improve_skills table.",
      "",
      "## The idea",
      "",
      skill.body.trim(),
      "",
    ].join("\n"),
  });

  await env.DB.batch([
    ...docStatements,
    env.DB
      .prepare(
        `INSERT INTO improve_skills (id, source_namespace, title, body_ref, source_attempt)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET title = ?3, body_ref = ?4`
      )
      .bind(skill.id, skill.sourceNamespace, skill.title, path, skill.sourceAttempt),
  ]);
}

// The skills a namespace has not already tried, best first.
//
// ORDERED BY WIN RATE, with the same Laplace smoothing lineage selection uses and
// for the same reason: a skill that is one for one should not outrank one that is
// eight for ten. A skill sourced FROM this namespace is excluded, because
// offering a project its own idea back is not transfer.
export async function candidateSkills(
  db: D1Database,
  namespace: string,
  limit: number
): Promise<Array<SkillRow & { winRate: number }>> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.source_namespace, s.title, s.body_ref, s.wins, s.losses, s.source_attempt, s.ts
       FROM improve_skills s
       WHERE s.source_namespace != ?1
         AND NOT EXISTS (
           SELECT 1 FROM improve_attempts a WHERE a.skill_id = s.id AND a.namespace = ?1
         )
       ORDER BY s.ts DESC
       LIMIT 200`
    )
    .bind(namespace)
    .all<SkillRow>();

  return results
    .map((s) => ({ ...s, winRate: (s.wins + 1) / (s.wins + s.losses + 2) }))
    .sort((a, b) => b.winRate - a.winRate || b.ts.localeCompare(a.ts))
    .slice(0, limit);
}

// A skill's outcome in one namespace. Called once per attempt that carried a
// skill id, when that attempt is finally kept or reverted.
export function recordSkillOutcome(db: D1Database, skillId: string, kept: boolean): D1PreparedStatement[] {
  return [
    db
      .prepare(
        kept
          ? "UPDATE improve_skills SET wins = wins + 1 WHERE id = ?1"
          : "UPDATE improve_skills SET losses = losses + 1 WHERE id = ?1"
      )
      .bind(skillId),
    db
      .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'improve-skill-outcome', ?2, NULL, ?3)")
      .bind(IMPROVE_ACTOR, "capsid", JSON.stringify({ skill_id: skillId, kept })),
  ];
}

export async function readSkillBody(db: D1Database, skill: SkillRow): Promise<string> {
  const row = await db
    .prepare("SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1")
    .bind(skill.body_ref)
    .first<{ body: string | null }>();
  return row?.body ?? "";
}
