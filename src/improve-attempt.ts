import type { AttemptEnv } from "./env";
import { callModelStreaming } from "./improve-anthropic";
import { createBranchAt, writeRepoFile } from "./github";
import { isImproveBranch } from "./improve-schema";

// Whole files, not a patch: a unified diff that fails to apply has no recovery in a cron job.
const CHANGE_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "One line, imperative mood, saying what the change does. This becomes the commit subject.",
    },
    reasoning: {
      type: "string",
      description: "Why this change should improve the score, and which metric you expect to move.",
    },
    files: {
      type: "array",
      description: "The complete new contents of every file the change touches. Do not include unchanged files.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path." },
          content: { type: "string", description: "The complete new contents of the file." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "reasoning", "files"],
  additionalProperties: false,
} as const;

export interface ProposedChange {
  summary: string;
  reasoning: string;
  files: Array<{ path: string; content: string }>;
  changedPaths: string[];
  costUsd: number;
  refused: boolean;
}

export interface ProposeInput {
  namespace: string;
  // The run prompt, read from capsid improve/prompts/run.md. It is DATA here, not
  // code: this module never edits it, and the meta-loop that proposes edits to it
  // can only write a proposal document a human applies.
  runPrompt: string;
  // What the scorer measures, rendered from the namespace's scores document, so
  // the model is optimising the stated objective rather than a guess at it.
  objective: string;
  // Repository context the caller gathered (file tree, relevant sources).
  context: string;
  // Prior attempts this run, so the model does not re-propose a change that was
  // already tried and reverted. Cheaper and more reliable than expecting it to
  // infer novelty.
  history: string;
  // Set when the attempt is a transferred skill rather than a fresh idea.
  skill?: { id: string; title: string; body: string };
}

export async function proposeChange(env: AttemptEnv, input: ProposeInput): Promise<ProposedChange> {
  const system = [
    input.runPrompt.trim(),
    "",
    "## What is being measured here",
    input.objective.trim(),
    "",
    "## Hard constraints",
    "Make ONE scoped change. Touch as few files as you can.",
    "You may not edit tests, CI workflows, lint or compiler configuration, lockfiles, package manifests, or anything under an improve/ directory. A change that touches any of those is reverted automatically, without being scored, and the attempt is wasted.",
    "Return the COMPLETE new contents of every file you change. A partial file overwrites the whole file and breaks the build.",
    "Do not add features nobody asked for, do not refactor around the change, and do not add error handling for cases that cannot happen.",
  ].join("\n");

  // Cached prefix: stable content first. History used to go first, so every
  // attempt busted the prefix cache.
  const cachedPrefix = ["## Repository context", input.context].join("\n");

  const user = [
    input.skill
      ? [
          "A change kept in another project generalized into the following skill. Apply it here IF AND ONLY IF it genuinely fits this codebase; if it does not fit, say so in the reasoning and return an empty files array.",
          "",
          `Skill: ${input.skill.title}`,
          input.skill.body,
          "",
        ].join("\n")
      : "Propose one scoped change that should improve the measured score.",
    "",
    "## Attempts already made in this run",
    input.history || "(none yet)",
  ].join("\n");

  const result = await callModelStreaming(env, {
    stage: "attempt",
    system,
    user,
    cachedPrefix,
    schema: CHANGE_SCHEMA as unknown as Record<string, unknown>,
  });

  // The cache is only observable through these counters, so they are logged. A
  // second attempt in a run reading 0 here means a silent invalidator got into
  // the system prompt or the repository context between attempts.
  console.log(
    `IMPROVE_ATTEMPT_TOKENS ns=${input.namespace} in=${result.inputTokens} out=${result.outputTokens} ` +
      `cache_read=${result.cacheReadTokens} cache_write=${result.cacheWriteTokens}`
  );

  if (result.refused) {
    return { summary: "", reasoning: "", files: [], changedPaths: [], costUsd: result.costUsd, refused: true };
  }

  const parsed = result.parsed as { summary?: unknown; reasoning?: unknown; files?: unknown } | null;
  const files = Array.isArray(parsed?.files)
    ? (parsed.files as Array<Record<string, unknown>>)
        .filter((f) => typeof f?.path === "string" && typeof f?.content === "string")
        .map((f) => ({ path: f.path as string, content: f.content as string }))
    : [];

  return {
    summary: typeof parsed?.summary === "string" ? parsed.summary : "",
    reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning : "",
    files,
    changedPaths: files.map((f) => f.path),
    costUsd: result.costUsd,
    refused: false,
  };
}

export interface PushResult {
  branch: string;
  headSha: string;
  changedPaths: string[];
}

// One contents-API commit per file, onto a branch created at an exact sha.
export async function pushAttempt(
  env: AttemptEnv,
  input: { namespace: string; branch: string; baseSha: string; summary: string; files: Array<{ path: string; content: string }> }
): Promise<PushResult> {
  // direct mode falls back to the default branch if this is missing.
  if (!input.branch || !isImproveBranch(input.branch)) {
    throw new Error(
      `pushAttempt refuses: '${input.branch}' is not an improve-loop branch. An attempt is only ever committed to its own branch, never to a repo's default branch.`
    );
  }
  await createBranchAt(env, input.namespace, input.branch, input.baseSha);

  let headSha = input.baseSha;
  for (const file of input.files) {
    const written = (await writeRepoFile(
      env,
      input.namespace,
      file.path,
      file.content,
      `improve: ${input.summary}`,
      "direct",
      input.branch
    )) as { commitSha?: string };
    if (written.commitSha) headSha = written.commitSha;
  }

  return { branch: input.branch, headSha, changedPaths: input.files.map((f) => f.path) };
}

export function renderChange(files: Array<{ path: string; content: string }>): string {
  return files
    .map((f) => `=== ${f.path} (${f.content.length} bytes, complete new contents) ===\n${f.content}`)
    .join("\n\n");
}
