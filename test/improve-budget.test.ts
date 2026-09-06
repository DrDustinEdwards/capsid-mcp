import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDGET_DEFAULTS, ROSTER } from "../src/improve-schema.ts";
import { checkBudget, improveStatus, openRuns, tickRuns } from "../src/improve-run.ts";
import { anchorChecksum, parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch } from "./fakes.ts";

// THE BUDGET KILL SWITCH (Cloudflare platform arc 2026-09-06). Budget alerts
// cannot stop a Worker, so the opener and the tick check monthly caps from KV
// before opening or advancing anything. These drive both refusals, the pause
// fan-out, the KV override, and the status surface.

const NOW = new Date("2026-09-15T12:00:00Z");
const SCORES = seedScoresDoc("capsid");

// A run inside the budget month carrying spend, and one from LAST month that
// must not count against this month's caps.
const spentRun = (over: Record<string, unknown>) => ({
  namespace: "capsid",
  mode: "subscription",
  status: "done",
  started: "2026-09-02 08:00:00",
  ...over,
});

async function harness(opts: { runs?: Array<Record<string, unknown>>; budget?: string }) {
  const pin = await anchorChecksum(parseScoresDoc("capsid", SCORES));
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "scores", body: SCORES, type: "reference" }],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "owner/capsid-mcp", label: "primary" }]) }],
    improveRuns: opts.runs ?? [],
  });
  const kv = fakeKv({
    seed: {
      "improve:anchor:capsid": pin,
      improve_mode: "subscription",
      ...(opts.budget === undefined ? {} : { "improve:budget": opts.budget }),
    },
    seedToken: true,
  });
  const env = fakeEnv({
    DB: d1.db,
    APP_KV: kv.kv,
    HOLDOUT: fakeR2({}).bucket,
    MEDIA: fakeR2({}).bucket,
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
  });
  return { d1, kv, env };
}

test("an exceeded Actions-minutes cap opens NOTHING and pauses every roster namespace with 'budget'", async () => {
  await withFetch({}, async () => {
    const { kv, env } = await harness({
      runs: [spentRun({ id: "capsid-r1", ci_minutes: 301, cost_usd: 1 })],
    });
    const summary = await openRuns(env, NOW, "capsid");
    assert.equal(summary.outcomes[0].opened, false);
    assert.match(summary.outcomes[0].note, /budget exceeded/);
    assert.match(summary.outcomes[0].note, /301\.0 of 300 Actions minutes/);
    for (const namespace of ROSTER) {
      assert.equal(kv.store.get(`improve:paused:${namespace}`), "budget", `${namespace} was not paused`);
    }
  });
});

test("an exceeded model-spend cap advances NOTHING: an active run is reported, not moved", async () => {
  await withFetch({}, async (calls) => {
    const { d1, env } = await harness({
      runs: [
        spentRun({ id: "capsid-r1", ci_minutes: 1, cost_usd: 51 }),
        { id: "capsid-r2", namespace: "capsid", mode: "api", status: "opening", base_sha: "base000", started: "2026-09-15 08:00:00", advanced_at: "2026-09-15 08:04:00" },
      ],
    });
    const outcomes = await tickRuns(env, NOW);
    assert.equal(outcomes.length, 1);
    assert.match(outcomes[0].note, /budget exceeded/);
    assert.equal(outcomes[0].to, "opening", "the run was advanced despite the exceeded cap");
    assert.equal(d1.rows.improve_runs.find((r) => r.id === "capsid-r2")?.status, "opening");
    assert.equal(calls.length, 0, "an exceeded budget still reached the network");
  });
});

test("spend from a PREVIOUS month does not count against this month's caps", async () => {
  await withFetch({}, async () => {
    const { kv, env } = await harness({
      runs: [spentRun({ id: "capsid-r0", started: "2026-08-20 08:00:00", ci_minutes: 10_000, cost_usd: 10_000 })],
    });
    const budget = await checkBudget(env, NOW);
    assert.equal(budget.exceeded, false, "last month's spend tripped this month's cap");
    const summary = await openRuns(env, NOW, "capsid");
    assert.match(summary.outcomes[0].note, /task document written/);
    assert.equal(kv.store.get("improve:paused:capsid"), undefined, "an under-cap month still paused the namespace");
  });
});

test("caps come from KV and override the defaults without a deploy", async () => {
  await withFetch({}, async () => {
    // 20 minutes spent: under the default 300, over a KV cap of 10.
    const { env } = await harness({
      runs: [spentRun({ id: "capsid-r1", ci_minutes: 20, cost_usd: 0 })],
      budget: JSON.stringify({ actions_minutes_month: 10 }),
    });
    const budget = await checkBudget(env, NOW);
    assert.equal(budget.exceeded, true, "the KV cap did not override the default");
    assert.equal(budget.caps.actions_minutes_month, 10);
    // The field the KV value did not name keeps its default.
    assert.equal(budget.caps.model_usd_month, BUDGET_DEFAULTS.model_usd_month);
  });
});

test("a malformed budget key falls back to the DEFAULTS, never to no cap", async () => {
  await withFetch({}, async () => {
    const { env } = await harness({
      runs: [spentRun({ id: "capsid-r1", ci_minutes: 299, cost_usd: 49 })],
      budget: "not json at all",
    });
    const budget = await checkBudget(env, NOW);
    assert.deepEqual(budget.caps, { ...BUDGET_DEFAULTS });
    assert.equal(budget.exceeded, false, "299 minutes and $49 are under the 300/$50 defaults");
  });
});

test("the KV month field re-anchors the meter, which is how a human resets it mid-month", async () => {
  await withFetch({}, async () => {
    const { env } = await harness({
      runs: [spentRun({ id: "capsid-r1", started: "2026-09-02 08:00:00", ci_minutes: 400, cost_usd: 0 })],
      budget: JSON.stringify({ month: "2026-10" }),
    });
    const budget = await checkBudget(env, NOW);
    assert.equal(budget.month, "2026-10");
    assert.equal(budget.spend.ci_minutes, 0, "spend before the re-anchored month still counted");
    assert.equal(budget.exceeded, false);
  });
});

test("improve_status reports spend against cap", async () => {
  await withFetch({}, async () => {
    const { env } = await harness({
      runs: [spentRun({ id: "capsid-r1", ci_minutes: 12, cost_usd: 3.5 })],
    });
    const status = await improveStatus(env, "capsid");
    assert.equal(status.budget.caps.actions_minutes_month, BUDGET_DEFAULTS.actions_minutes_month);
    assert.equal(status.budget.caps.model_usd_month, BUDGET_DEFAULTS.model_usd_month);
    assert.equal(status.budget.spend.ci_minutes, 12);
    assert.equal(status.budget.spend.cost_usd, 3.5);
    assert.equal(status.budget.exceeded, false);
  });
});
