import assert from "node:assert/strict";
import { test } from "node:test";
import { ciDispatch } from "../src/github.ts";
import { claimJti } from "../src/improve-scorer.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch } from "./fakes.ts";

// INGEST HARDENING, audit 2026-09-07 (Grok MAJOR 3, 5, 6 and section 23 item 7;
// Opus MAJOR 2.1 and the budget note in section 5).
//
// Four separate holes, one theme: every stop this system has was checked where
// work STARTS and not where it FINISHES, and the finish is where an attempt gets
// kept. Each assertion below fails against 3763d95.

// ---- the replay cache is now atomic ----------------------------------------

function jtiDb() {
  return fakeD1({});
}

test("PLANT: a jti can be claimed exactly once", async () => {
  const d1 = jtiDb();
  assert.deepEqual(await claimJti(d1.db, "capsid", "nonce-a"), { ok: true });
  const second = await claimJti(d1.db, "capsid", "nonce-a");
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.status, 409);
});

test("PLANT: two concurrent claims of the same jti resolve to ONE winner", async () => {
  // The KV version was get-then-put: both callers read absent, both wrote, both
  // proceeded. A captured signed request could therefore be replayed for the
  // whole 30-minute window by racing it against itself. A PRIMARY KEY has no
  // such window.
  const d1 = jtiDb();
  const results = await Promise.all([
    claimJti(d1.db, "capsid", "raced"),
    claimJti(d1.db, "capsid", "raced"),
    claimJti(d1.db, "capsid", "raced"),
  ]);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, "exactly one caller may claim a nonce");
});

test("the same jti in a different scope is a different claim", async () => {
  const d1 = jtiDb();
  assert.deepEqual(await claimJti(d1.db, "capsid", "n"), { ok: true });
  assert.deepEqual(await claimJti(d1.db, "foxing", "n"), { ok: true });
  assert.deepEqual(await claimJti(d1.db, "backup", "n"), { ok: true });
});

test("a database error FAILS CLOSED, it does not admit the request", async () => {
  const broken = {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          throw new Error("D1 is unavailable");
        },
      }),
    }),
  } as unknown as D1Database;
  const verdict = await claimJti(broken, "capsid", "n");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 503);
});

// ---- ci_dispatch aliases ----------------------------------------------------

function repoEnv(repoFull: string) {
  const kv = fakeKv({ seedToken: true });
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify([{ repo: repoFull, label: "primary" }]) }) }),
      }),
    },
    APP_KV: kv.kv,
  });
}

test("PLANT: ci_dispatch refuses the scorer named by numeric workflow id", async () => {
  // GitHub's dispatch endpoint accepts the numeric id at the same position as the
  // file name, so an exact-basename refusal was one `gh api` call from bypassed.
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => ciDispatch(repoEnv("owner/repo"), "ns", { workflow: "12345678", ref: "main" }),
      /not a workflow file name/,
      "a numeric id must be refused"
    );
    assert.equal(calls.length, 0, "the refusal must cost no round trip");
  });
});

test("PLANT: ci_dispatch refuses the scorer named by full path", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => ciDispatch(repoEnv("owner/repo"), "ns", { workflow: ".github/workflows/improve-score.yml", ref: "main" }),
      /improve loop's scorer/,
      "the full path names the same file"
    );
    assert.equal(calls.length, 0);
  });
});

test("PLANT: ci_dispatch refuses a RENAMED scorer by its content", async () => {
  // A scorer copied under another name is still a scorer: what makes it dangerous
  // is that it holds the signing key and posts to the score endpoint.
  const yaml = Buffer.from(
    'name: totally-innocent\njobs:\n  score:\n    steps:\n      - run: curl -X POST "$CAPSID_URL/improve/score"\n',
    "utf8"
  ).toString("base64");
  await withFetch(
    { "GET /repos/owner/repo/contents/.github/workflows/nightly.yml": { body: { content: yaml, encoding: "base64" } } },
    async () => {
      await assert.rejects(
        () => ciDispatch(repoEnv("owner/repo"), "ns", { workflow: "nightly.yml", ref: "main" }),
        /posts to \/improve\/score/,
        "content decides, not the file name"
      );
    }
  );
});

test("PLANT: ci_dispatch refuses a RERUN of a scorer run", async () => {
  // Rerunning the scorer's failed jobs re-executes the signing step against that
  // run's ref, which is a dispatch by another name.
  await withFetch(
    {
      "GET /repos/owner/repo/actions/runs/99": { body: { path: ".github/workflows/improve-score.yml", name: "improve-score" } },
    },
    async () => {
      await assert.rejects(
        () => ciDispatch(repoEnv("owner/repo"), "ns", { run_id: 99 }),
        /rerunning it re-executes the signing step/
      );
    }
  );
});

test("an ordinary workflow still dispatches, so the refusals are not a blanket ban", async () => {
  const yaml = Buffer.from("name: ci\njobs:\n  build:\n    steps:\n      - run: npm test\n", "utf8").toString("base64");
  await withFetch(
    {
      "GET /repos/owner/repo/contents/.github/workflows/ci.yml": { body: { content: yaml, encoding: "base64" } },
      "GET /repos/owner/repo/actions/runs": { body: { workflow_runs: [] } },
      "GET /repos/owner/repo": { body: { default_branch: "main" } },
      "POST /repos/owner/repo/actions/workflows/ci.yml/dispatches": { status: 204, body: {} },
    },
    async () => {
      const res = await ciDispatch(
        repoEnv("owner/repo"),
        "ns",
        { workflow: "ci.yml", ref: "main" },
        undefined,
        { timeoutMs: 1, intervalMs: 1 }
      );
      assert.equal(res.mode, "dispatch");
    }
  );
});

test("an ordinary RERUN still works", async () => {
  await withFetch(
    {
      "GET /repos/owner/repo/actions/runs/7": { body: { path: ".github/workflows/ci.yml", name: "CI" } },
      "POST /repos/owner/repo/actions/runs/7/rerun-failed-jobs": { status: 201, body: {} },
    },
    async () => {
      const res = await ciDispatch(repoEnv("owner/repo"), "ns", { run_id: 7 });
      assert.equal(res.mode, "rerun");
    }
  );
});

// ---- the three stops now apply at INGEST, not only at the start -------------
//
// Pause was checked in openOne, mode in openOne, budget in the opener and tick.
// None of them was checked at ingest, so a score POST still kept the change,
// wrote improve:best, abstracted a skill and advanced the run in a namespace a
// human had explicitly paused, or after the mode was switched off, or past the
// spend cap. A stop that only stops NEW work is not a stop: the in-flight
// attempt is the one someone paused the namespace to stop.

import { ingestScore } from "../src/improve-run.ts";
import { anchorChecksum, parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import type { ScoreReport } from "../src/improve-scorer.ts";

const SCORES = seedScoresDoc("capsid");
const AT = new Date("2026-09-04T08:10:00Z");

const RUN: Record<string, unknown> = {
  id: "capsid-r1",
  namespace: "capsid",
  started: "2026-09-04 08:00:00",
  status: "awaiting-score",
  attempts: 1,
  current_attempt: "capsid-r1-a01",
  base_sha: "base000",
  advanced_at: "2026-09-04 08:04:00",
};

const ATTEMPT_ROW = {
  id: "capsid-r1-a01",
  namespace: "capsid",
  run_id: "capsid-r1",
  status: "awaiting-score",
  change_summary: "a scoped change",
  diff_ref: "improve/archive/capsid-r1/capsid-r1-a01.md",
  branch: "improve/capsid-r1-a01",
  head_sha: "head01",
  base_sha: "base000",
  dispatched_at: "2026-09-04 08:04:00",
};

function scoreReport(over: Partial<ScoreReport> = {}): ScoreReport {
  return {
    namespace: "capsid",
    run_id: "capsid-r1",
    attempt_id: "capsid-r1-a01",
    head_sha: "head01",
    jti: `j-${Math.random()}`,
    anchors: { build_passes: 1 },
    secondary: { test_pass_rate: 1, lint_count: 0, error_count: 0, p95_latency_ms: 10, bundle_size_bytes: 10 },
    holdout: { total: 30, passed: 30 },
    ci_minutes: 1,
    ...over,
  };
}

async function ingestEnv(kvSeed: Record<string, string>, runs = [RUN]) {
  const pin = await anchorChecksum(parseScoresDoc("capsid", SCORES));
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "s", body: SCORES, type: "reference" }],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid-mcp", label: "primary" }]) }],
    improveRuns: runs,
    improveAttempts: [ATTEMPT_ROW],
  });
  const kv = fakeKv({ seed: { improve_mode: "api", "improve:anchor:capsid": pin, ...kvSeed }, seedToken: true });
  const holdout = fakeR2({
    "improve/holdout/capsid/manifest.json": JSON.stringify({ namespace: "capsid", total: 30, updated_at: "2026-09-01T00:00:00Z" }),
  });
  return { d1, env: fakeEnv({ DB: d1.db, APP_KV: kv.kv, HOLDOUT: holdout.bucket }) };
}

test("PLANT: ingest REFUSES while the namespace is paused", async () => {
  const { d1, env } = await ingestEnv({ "improve:paused:capsid": "an anchor dropped" });
  const result = await ingestScore(env, scoreReport(), AT);
  assert.equal(result.ok, false, "a paused namespace must not ingest");
  assert.match(result.message, /paused/);
  assert.equal(result.kept, undefined, "and nothing may be kept");
  assert.equal(d1.rows.improve_runs[0].status, "awaiting-score", "the run must not advance");
});

test("PLANT: ingest REFUSES when improve_mode is off", async () => {
  const { d1, env } = await ingestEnv({ improve_mode: "off" });
  const result = await ingestScore(env, scoreReport(), AT);
  assert.equal(result.ok, false);
  assert.match(result.message, /improve_mode is off/);
  assert.equal(d1.rows.improve_runs[0].status, "awaiting-score");
});

test("PLANT: ingest REFUSES when the budget is exceeded", async () => {
  const { d1, env } = await ingestEnv(
    { "improve:budget": JSON.stringify({ actions_minutes_month: 1, model_usd_month: 1 }) },
    [{ ...RUN, ci_minutes: 500, cost_usd: 99 }]
  );
  const result = await ingestScore(env, scoreReport(), AT);
  assert.equal(result.ok, false);
  assert.match(result.message, /budget exceeded/);
  assert.equal(d1.rows.improve_runs[0].status, "awaiting-score");
});

test("PLANT: a baseline report must match the run's in-flight attempt", async () => {
  // The baseline used to need only the right attempt_id shape and the CAS. A
  // rerun of the baseline job after the run moved on would overwrite the run's
  // baseline metrics with a measurement of something else, and every later
  // comparison is against those numbers.
  const { env } = await ingestEnv({}, [{ ...RUN, current_attempt: "capsid-r1-a01" }]);
  const result = await ingestScore(
    env,
    scoreReport({ attempt_id: "capsid-r1-baseline", head_sha: "base000" }),
    AT
  );
  assert.match(result.message, /not awaiting its baseline/);
});

test("PLANT: a baseline report must have measured the run's base commit", async () => {
  const { env } = await ingestEnv({}, [{ ...RUN, current_attempt: "capsid-r1-baseline" }]);
  const result = await ingestScore(
    env,
    scoreReport({ attempt_id: "capsid-r1-baseline", head_sha: "some-other-commit" }),
    AT
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /does not match run .* base_sha/);
});

test("a correctly bound baseline is still ingested, so the binding is not a wall", async () => {
  const { d1, env } = await ingestEnv({}, [{ ...RUN, current_attempt: "capsid-r1-baseline" }]);
  const result = await ingestScore(
    env,
    scoreReport({ attempt_id: "capsid-r1-baseline", head_sha: "base000" }),
    AT
  );
  assert.equal(result.ok, true, result.message);
  assert.notEqual(d1.rows.improve_runs[0].status, "awaiting-score", "the run must advance");
});
