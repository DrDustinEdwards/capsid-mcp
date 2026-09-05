// The one place this Worker talks to a model.
//
// Only reached in improve_mode "api". In "subscription" the Worker writes a task
// doc and a Claude Code session does the reasoning; in "off" nothing here runs at
// all. So every function below is behind a mode check made by its caller, and the
// key is optional in Env for exactly that reason.
//
// THE OFFICIAL SDK, NOT fetch. Every other outbound call in this Worker is raw
// fetch (GitHub), and this one deliberately is not: the request surface here
// carries model-specific rules that move (thinking config, effort, the fallback
// beta, structured outputs), and hand-rolling it means re-deriving those rules
// from memory every time one changes. The SDK is the contract.
//
// WHY NO BATCH API, recorded because "batch where possible" was the instruction
// and this is the honest answer. The Batches API is asynchronous: results arrive
// out of order keyed by custom_id, most batches finish within the hour and the
// ceiling is 24. Attempts inside a run are STRICTLY SEQUENTIAL by construction:
// attempt N+1 branches from a base chosen by lineage weighting over attempt N's
// recorded outcome, so there is never more than one attempt in flight per
// namespace to batch WITH. The one genuinely parallel stage is skill triage
// across namespaces, and that is already one request scoring N skills rather than
// N requests scoring one, which buys the same saving without a second async
// lifecycle to carry across cron invocations. If attempts are ever made
// independent, revisit this.

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { MODEL_FOR, type ModelStage } from "./improve-schema";

// THE NARROWEST ENV THIS MODULE CAN TAKE: the key and nothing else.
//
// It matters because src/improve-attempt.ts holds AttemptEnv (Env without the
// holdout bucket) and has to be able to call these without a cast. A cast at that
// boundary would erase exactly the guarantee AttemptEnv exists to provide, so the
// callee is narrowed instead. Env and AttemptEnv both satisfy this.
export type ModelEnv = Pick<Env, "ANTHROPIC_API_KEY">;


// Per million tokens, from the published rates. A cache read is roughly a tenth
// of the input rate and a cache write roughly 1.25x, applied below.
//
// THIS IS AN ESTIMATE AND IS LABELLED AS ONE wherever it surfaces. It is here so
// improve_runs.cost_usd is populated with something a human can sanity-check
// against a bill, not so it can replace the bill. A model whose price is not
// listed is costed at the highest rate in the table rather than at zero: an
// unknown model quietly costing nothing is how a budget gets blown.
const RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // The documented fallback target for a policy decline on Opus 5.
  "claude-opus-4-8": { input: 5, output: 25 },
};

const HIGHEST_RATE = { input: 5, output: 25 };

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costOf(model: string, usage: UsageLike): number {
  const rate = RATES[model] ?? HIGHEST_RATE;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (input * rate.input + cacheWrite * rate.input * 1.25 + cacheRead * rate.input * 0.1 + output * rate.output) /
    1_000_000
  );
}

export interface ModelCall {
  stage: ModelStage;
  system: string;
  user: string;
  // A JSON Schema. When present the response is constrained to it and `parsed`
  // carries the object. Constraint rather than instruction: "reply with JSON"
  // in a prompt is a request, output_config.format is a guarantee, and the
  // difference matters most on the monitor, whose whole job is to be parseable.
  schema?: Record<string, unknown>;
  maxTokens?: number;
  // THE STABLE PREFIX, cached. Large content that does not change between calls
  // in a run: the repository context an attempt is proposed against.
  //
  // It is a SEPARATE FIELD rather than part of `user` because prompt caching is a
  // PREFIX match, so the stable bytes have to physically precede the volatile
  // ones. Concatenating it into `user` and hoping is how a cache reports 0 reads
  // forever: the attempt history grows every attempt, so anything after it is a
  // new prefix every time. See shared prompt-caching guidance and the ordering
  // note in src/improve-attempt.ts.
  cachedPrefix?: string;
}

export interface ModelResult {
  model: string;
  text: string;
  parsed: unknown;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  // SURFACED SO THE CACHE IS OBSERVABLE. A cache that silently stops working
  // looks exactly like one that never worked, and the only signal is that
  // cacheReadTokens stays 0 across repeated calls with the same prefix. Logged by
  // the attempt path for that reason.
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // A policy decline is NOT an error and NOT an empty answer. It is a third
  // outcome, and every caller has to decide what it means for the attempt it was
  // asking about. Surfaced as a field so no caller can read `text` and get an
  // empty string it mistakes for "the model had nothing to say".
  refused: boolean;
  refusalCategory: string | null;
}

// The stages that reason about the system rather than about one change run on
// Opus 5, which carries safety classifiers that can decline a request. Fallbacks
// are opt-in: without them a declined request simply stops. "default" rather than
// a pinned model, so the routing follows the refusal category and there is no
// second migration owed when a pinned fallback is retired.
const OPUS_STAGES = new Set<ModelStage>(["abstract", "meta"]);
// Haiku 4.5 predates the effort parameter and adaptive thinking. Sending either
// is a 400, so the request is built without them rather than with them defaulted.
const NO_EFFORT_STAGES = new Set<ModelStage>(["triage", "monitor"]);

export function clientFor(env: ModelEnv): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "improve_mode is 'api' but ANTHROPIC_API_KEY is not set. Set it with `wrangler secret put ANTHROPIC_API_KEY`, or switch the mode to 'subscription' or 'off'."
    );
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export async function callModel(env: ModelEnv, call: ModelCall): Promise<ModelResult> {
  const client = clientFor(env);
  const model = MODEL_FOR[call.stage];
  const isOpus = OPUS_STAGES.has(call.stage);
  const noEffort = NO_EFFORT_STAGES.has(call.stage);

  // 16,000 non-streaming keeps every request comfortably under the SDK's HTTP
  // timeout. The attempt stage streams instead (see callModelStreaming) because
  // a code change plus its reasoning wants far more room than that.
  const maxTokens = call.maxTokens ?? 16_000;

  const outputConfig: Record<string, unknown> = {};
  // xhigh is the documented setting for coding and agentic work, and every stage
  // here that supports effort is one or the other.
  if (!noEffort) outputConfig.effort = "xhigh";
  if (call.schema) outputConfig.format = { type: "json_schema", schema: call.schema };

  const response = await client.beta.messages.create({
    model,
    max_tokens: maxTokens,
    system: call.system,
    messages: [{ role: "user", content: call.user }],
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    ...(isOpus ? { betas: ["server-side-fallback-2026-07-01" as const], fallbacks: "default" as const } : {}),
  });

  return readResponse(model, response);
}

// The attempt stage, streamed. A code change is the one output here that can run
// long, and a non-streaming request at this size is how an SDK HTTP timeout gets
// discovered in production at 03:00 rather than in a test.
export async function callModelStreaming(env: ModelEnv, call: ModelCall): Promise<ModelResult> {
  const client = clientFor(env);
  const model = MODEL_FOR[call.stage];

  // TWO CACHE BREAKPOINTS, placed at the two stability boundaries.
  //
  // Render order is tools, then system, then messages. The system prompt is fixed
  // for a whole run (the run prompt plus that namespace's objective), and the
  // cached prefix is fixed for a whole run too (the repository context). The
  // volatile part, the attempt history and any transferred skill, goes after both.
  //
  // A run makes up to ten attempts against that identical prefix, so this is nine
  // reads at roughly a tenth of the input rate instead of nine full-price
  // reprocessings, against a one-off write premium on the first. The breakpoints
  // are NOT placed at the end of the whole prompt, which is the mistake that turns
  // every request into its own cache entry that nothing ever reads.
  const cache = { type: "ephemeral" as const };
  const messages = call.cachedPrefix
    ? [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: call.cachedPrefix, cache_control: cache },
            { type: "text" as const, text: call.user },
          ],
        },
      ]
    : [{ role: "user" as const, content: call.user }];

  const stream = client.beta.messages.stream({
    model,
    max_tokens: call.maxTokens ?? 64_000,
    system: [{ type: "text", text: call.system, cache_control: cache }],
    messages,
    output_config: {
      effort: "xhigh",
      ...(call.schema ? { format: { type: "json_schema", schema: call.schema } } : {}),
    },
  });
  return readResponse(model, await stream.finalMessage());
}

// One reader for both paths, so the refusal check and the cost arithmetic cannot
// diverge between the streaming and non-streaming call sites.
function readResponse(requestedModel: string, response: Anthropic.Beta.BetaMessage): ModelResult {
  // CHECKED BEFORE content IS READ. On a decline `content` is empty (declined
  // before output) or partial (declined mid-stream), and code that indexes
  // content[0] unconditionally breaks on exactly the responses it most needs to
  // handle deliberately.
  const refused = response.stop_reason === "refusal";
  const refusalCategory = refused ? (response.stop_details?.category ?? null) : null;

  const text = response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // With structured outputs the text IS the JSON, so parse it here rather than
  // making every caller remember to. A parse failure returns null rather than
  // throwing: a caller that asked for a schema and got prose needs to treat that
  // as "the model did not answer", which is a decision, not an exception.
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  // COST IS SUMMED OVER ITERATIONS WHEN THERE ARE ANY. Top-level usage covers
  // only the attempt that produced the returned message, so a request that was
  // declined by Opus and served by the fallback reports the fallback's tokens at
  // the top level and says nothing about the declined attempt. The iterations
  // list is the per-attempt record; a declined-before-output attempt is reported
  // there and is not billed, which the rate arithmetic handles on its own
  // because its token counts are zero.
  const iterations = (response.usage as { iterations?: Array<{ usage?: UsageLike; model?: string }> }).iterations;
  const costUsd =
    Array.isArray(iterations) && iterations.length > 0
      ? iterations.reduce((sum, entry) => sum + costOf(entry.model ?? response.model ?? requestedModel, entry.usage ?? {}), 0)
      : costOf(response.model ?? requestedModel, response.usage);

  return {
    // The model that actually produced the message, which is not always the one
    // asked for once fallbacks are on.
    model: response.model ?? requestedModel,
    text,
    parsed,
    costUsd,
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    refused,
    refusalCategory,
  };
}
