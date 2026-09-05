// Generating one scoped change, and putting it on a branch.
//
// THIS MODULE TAKES AttemptEnv, NOT Env.
//
// AttemptEnv is Omit<Env, "HOLDOUT">, so the holdout bucket is not merely unused
// here, it does not exist on the type and `env.HOLDOUT` does not compile. That is
// the type-level third of the isolation the arc asked for. The other two thirds
// are the separate bucket (infrastructure: attempt code holds no binding to it)
// and test/improve-holdout.test.ts (a source scan: no file but the scorer may
// name it). All three are needed, because a type can be cast away, a scan can be
// evaded by an alias, and a shared bucket would defeat both.
//
// The CI runner reads the holdout set with its own read-only R2 token, held as a
// repo secret. That token is never in this Worker's environment at all, so the
// attempt path could not leak it even if it wanted to. The guard test asserts
// that too.

import type { AttemptEnv } from "./env";
import { callModelStreaming } from "./improve-anthropic";
import { createBranchAt, writeRepoFile } from "./github";

// The change the model is constrained to produce. Whole files rather than a
// patch format, deliberately: a unified diff has to apply, and a diff that fails
// to apply is a failure mode with no good recovery inside a cron job. Whole file
// contents always apply. The cost is bandwidth on large files, and the loop is
// told to make scoped changes, so the files it touches should be few.
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

  // THE REPOSITORY CONTEXT IS THE CACHED PREFIX, passed separately rather than
  // concatenated into `user`. It used to be the LAST thing in the user message,
  // after the attempt history, which is the worst possible order for a prefix
  // cache: the history grows by a line every attempt, so every request would have
  // been a fresh prefix and the cache would have read zero forever. Stable content
  // first, volatile content after the breakpoint.
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

// Put the change on its own branch, one commit per file.
//
// ONE COMMIT PER FILE rather than one commit for the change, because the GitHub
// contents API commits a single file at a time and building a multi-file commit
// means constructing a tree and a commit object by hand. That is a second write
// path into these repos, and this repo's rules are explicit that a second write
// path is where the invariants get lost. The cost is a slightly noisier branch
// history on an attempt branch that is either merged as one squashed PR or
// abandoned.
//
// The branch is created at an EXACT SHA, the one lineage selection picked, which
// is frequently not the tip of any branch.
export async function pushAttempt(
  env: AttemptEnv,
  input: { namespace: string; branch: string; baseSha: string; summary: string; files: Array<{ path: string; content: string }> }
): Promise<PushResult> {
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

// A diff-shaped rendering of the change, for the monitor and for the archive
// document. Not a real unified diff: the model returns whole files, so what is
// available is the new contents, and pretending otherwise by synthesising hunk
// headers would produce something that looks like a diff and is not one.
export function renderChange(files: Array<{ path: string; content: string }>): string {
  return files
    .map((f) => `=== ${f.path} (${f.content.length} bytes, complete new contents) ===\n${f.content}`)
    .join("\n\n");
}
