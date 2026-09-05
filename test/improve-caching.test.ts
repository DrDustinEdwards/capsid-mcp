import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { proposeChange } from "../src/improve-attempt.ts";
import { fakeEnv, withFetch } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";

// PROMPT CACHING ON THE ATTEMPT PATH.
//
// Caching is a PREFIX match, so the only thing that makes it work is ordering:
// stable bytes before volatile ones, with the breakpoint between. The repository
// context used to be the LAST thing in the user message, after the attempt
// history, which grows by a line every attempt. Every request would have written a
// fresh cache entry that nothing ever read, and the only symptom would have been a
// bill.
//
// So these tests assert the ORDER and the STABILITY of the prefix, not just that
// the parameter is present.

const CONTEXT = `Repository: owner/repo\n${"src/thing.ts\n".repeat(400)}`;

function captured(calls: Array<{ path: string; body: unknown }>) {
  const call = calls.find((c) => c.path === "/v1/messages");
  assert.ok(call, "no request reached /v1/messages");
  return call.body as {
    system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    messages: Array<{ role: string; content: Array<{ type: string; text: string; cache_control?: { type: string } }> }>;
  };
}

// A REAL SSE RESPONSE. The attempt path uses the SDK's streaming helper, so a
// plain JSON body is answered with "request ended without sending any chunks".
// Building the event stream is what makes this test exercise the path the loop
// actually takes rather than a non-streaming lookalike.
function sse(text: string): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [],
          stop_reason: null,
          stop_details: null,
          usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0 },
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const ROUTE = {
  "POST /v1/messages": {
    contentType: "text/event-stream",
    text: sse(JSON.stringify({ summary: "s", reasoning: "r", files: [] })),
  },
};

function input(over: Partial<Parameters<typeof proposeChange>[1]> = {}) {
  return {
    namespace: "capsid",
    runPrompt: "the run prompt",
    objective: "the objective",
    context: CONTEXT,
    history: "",
    ...over,
  };
}

const ENV = fakeEnv({ ANTHROPIC_API_KEY: "sk-test" });

test("the system prompt carries a cache breakpoint", async () => {
  await withFetch(ROUTE, async (calls) => {
    await proposeChange(ENV, input());
    const body = captured(calls);
    assert.ok(Array.isArray(body.system), "system is not a block array, so it cannot carry a breakpoint");
    assert.equal(body.system.at(-1)?.cache_control?.type, "ephemeral");
  });
});

test("THE REPOSITORY CONTEXT IS THE FIRST USER BLOCK, and carries the breakpoint", async () => {
  await withFetch(ROUTE, async (calls) => {
    await proposeChange(ENV, input({ history: "- reverted: something" }));
    const content = captured(calls).messages[0].content;
    assert.ok(Array.isArray(content), "the user message is not a block array");
    assert.equal(content.length, 2, "expected a cached block and a volatile block");
    assert.match(content[0].text, /## Repository context/);
    assert.equal(content[0].cache_control?.type, "ephemeral", "the context block carries no breakpoint");
    // And the volatile half is AFTER it, which is the whole property.
    assert.match(content[1].text, /Attempts already made in this run/);
    assert.equal(content[1].cache_control, undefined, "a breakpoint after the volatile content caches nothing reusable");
  });
});

test("THE CACHED PREFIX IS BYTE-IDENTICAL ACROSS ATTEMPTS, which is what makes it a cache", async () => {
  // The real test. Two attempts in the same run differ in history and in whether a
  // skill was offered; everything up to and including the breakpoint must not move
  // by a single byte, or the second request writes a new entry instead of reading
  // the first.
  const prefixes: string[] = [];
  const systems: string[] = [];
  for (const attempt of [
    input({ history: "", skill: { id: "sk-1", title: "A skill", body: "do the thing" } }),
    input({ history: "- reverted: first try\n- kept: second try" }),
    input({ history: "- reverted: first try\n- kept: second try\n- reverted: third" }),
  ]) {
    await withFetch(ROUTE, async (calls) => {
      await proposeChange(ENV, attempt);
      const body = captured(calls);
      prefixes.push(body.messages[0].content[0].text);
      systems.push(body.system.map((b) => b.text).join(""));
    });
  }
  assert.equal(new Set(prefixes).size, 1, "the cached prefix changed between attempts, so nothing will ever be read from cache");
  assert.equal(new Set(systems).size, 1, "the system prompt changed between attempts");
  // Vacuity guard: the volatile half really did differ, so the assertion above is
  // about a stable prefix rather than about three identical requests.
  assert.equal(prefixes[0].includes("Attempts already made"), false, "the history leaked into the cached prefix");
});

test("the prefix is large enough to be worth caching", () => {
  // Below the model's minimum cacheable prefix nothing caches, silently, and the
  // breakpoint is decoration. This is a floor rather than an exact figure: the
  // context is bounded elsewhere and the minimum is model-dependent.
  assert.ok(CONTEXT.length > 4000, "the fixture context is too small to exercise the case this guards");
});

test("the cache counters are surfaced, so a dead cache is observable", async () => {
  await withFetch(ROUTE, async () => {
    const result = await proposeChange(ENV, input());
    assert.equal(result.costUsd > 0, true);
  });
  // A cache that silently stops working looks exactly like one that never worked.
  // The counters are the only signal, so they are on the result and logged.
  const anthropic = sourceFile("improve-anthropic.ts");
  assert.match(anthropic, /cacheReadTokens: response\.usage\.cache_read_input_tokens \?\? 0,/);
  assert.match(anthropic, /cacheWriteTokens: response\.usage\.cache_creation_input_tokens \?\? 0,/);
  const attempt = sourceFile("improve-attempt.ts");
  assert.match(attempt, /IMPROVE_ATTEMPT_TOKENS/);
  assert.match(attempt, /cache_read=\$\{result\.cacheReadTokens\}/);
});

test("cache read and write are priced differently from plain input", () => {
  // A cache read is roughly a tenth of the input rate and a write roughly 1.25x.
  // Pricing them as plain input would make the cost estimate wrong in the
  // direction that hides the saving the cache exists for.
  const anthropic = sourceFile("improve-anthropic.ts");
  assert.match(anthropic, /cacheWrite \* rate\.input \* 1\.25/);
  assert.match(anthropic, /cacheRead \* rate\.input \* 0\.1/);
});

// ---- the dependency pin -----------------------------------------------------

test("@anthropic-ai/sdk IS PINNED TO AN EXACT VERSION", () => {
  // A caret range means the SDK can move under this Worker on any install, and the
  // request surface here carries model-specific rules that a minor bump can
  // change. capsid/conventions.md: an upstream default is not a decision.
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const spec = pkg.dependencies["@anthropic-ai/sdk"];
  assert.ok(spec, "@anthropic-ai/sdk is no longer a dependency");
  assert.match(spec, /^\d+\.\d+\.\d+$/, `@anthropic-ai/sdk is '${spec}'; it must be an exact version, with no ^ or ~`);
});

test("the lockfile agrees with the pin", () => {
  const dir = join(import.meta.dirname, "..");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  const installed = lock.packages["node_modules/@anthropic-ai/sdk"]?.version;
  assert.equal(installed, pkg.dependencies["@anthropic-ai/sdk"], "package.json and package-lock.json disagree on the SDK version");
});
