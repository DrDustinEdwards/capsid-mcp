import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorDriftVerdict, driftVerdict, monitorAttempt, pathMonitor } from "../src/improve-gates.ts";
import { parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import { DRIFT_RUN_WINDOW, protectedHits } from "../src/improve-schema.ts";
import type { RunRow } from "../src/improve-state.ts";
import { fakeEnv } from "./fakes.ts";
import { IMPROVE_RUN_DEFAULTS } from "./improve-fakes.ts";

// The two gates. Both halves of the monitor and both halves of the drift gate.

// ---- the deterministic monitor ----------------------------------------------

test("the path monitor flags every class of protected path", () => {
  const cases: Array<[string, RegExp]> = [
    ["test/foo.test.ts", /test directory/],
    ["src/thing.test.ts", /test file/],
    ["src/thing.spec.tsx", /test file/],
    ["tests/integration/a.js", /test directory/],
    ["src/__tests__/a.ts", /test directory/],
    [".github/workflows/improve-score.yml", /CI configuration/],
    ["improve/scores.md", /improve loop's own documents/],
    ["src/improve-gates.ts", /improve loop's own source/],
    ["migrations/0004_x.sql", /database migration/],
    ["wrangler.jsonc", /deployment configuration/],
    ["package.json", /dependency manifest/],
    ["package-lock.json", /dependency manifest/],
    ["tsconfig.test.json", /compiler configuration/],
    ["vite.config.ts", /config file/],
    [".eslintrc", /lint configuration/],
    [".claude/settings.json", /agent steering layer/],
    ["CLAUDE.md", /repo briefing/],
  ];
  for (const [path, why] of cases) {
    const verdict = pathMonitor([path]);
    assert.equal(verdict.flagged, true, `${path} was not flagged`);
    assert.match(verdict.reason ?? "", why, `${path} was flagged for the wrong reason: ${verdict.reason}`);
    assert.equal(verdict.source, "paths");
    assert.equal(verdict.costUsd, 0, "the deterministic half must cost nothing");
  }
});

test("the path monitor does NOT fire on ordinary source, which is what keeps it alive", () => {
  // A guard that fires on innocent code gets deleted rather than fixed
  // (capsid/conventions.md). These are the paths a real scoped change touches.
  const innocent = [
    "src/routes.ts",
    "src/lib/format.ts",
    "app/components/Button.tsx",
    "worker/handlers/health.ts",
    "docs/guide.md",
    "README.md",
    "styles/app.css",
    "public/robots.txt",
    "src/improvements/rank.ts",
    "src/testing-library-helpers.ts",
  ];
  const verdict = pathMonitor(innocent);
  assert.equal(verdict.flagged, false, `false positive on: ${verdict.reason}`);
  assert.equal(verdict.source, "none");
});

test("one protected path among many innocent ones still flags", () => {
  const verdict = pathMonitor(["src/a.ts", "src/b.ts", "test/a.test.ts", "src/c.ts"]);
  assert.equal(verdict.flagged, true);
  assert.match(verdict.reason ?? "", /test\/a\.test\.ts/);
});

test("protectedHits reports one reason per path, not one per pattern", () => {
  // src/improve-gates.ts matches both the improve-source pattern and nothing else;
  // a path that matched two patterns must still count once, or the message reads
  // as if more files were touched than were.
  const hits = protectedHits(["src/improve-gates.ts"]);
  assert.equal(hits.length, 1);
});

// ---- the model half ---------------------------------------------------------

test("THE MONITOR FAILS CLOSED when it cannot run", () => {
  // A monitor that cannot run is not a monitor that approves. With no API key the
  // model call throws, and the attempt must be reverted with the unavailability
  // named rather than accepted unreviewed.
  return monitorAttempt(fakeEnv({}), {
    changedPaths: ["src/a.ts"],
    changeSummary: "something",
    reasoning: "because",
    diff: "code",
  }).then((verdict) => {
    assert.equal(verdict.flagged, true);
    assert.match(verdict.reason ?? "", /could not run/);
    assert.match(verdict.reason ?? "", /reverted rather than accepted unreviewed/);
    assert.equal(verdict.source, "model");
  });
});

test("the deterministic half runs FIRST, so a protected path never reaches the model", async () => {
  // fakeEnv({}) has no API key, so any model call throws. A clean return here
  // proves the path check short-circuited before the network.
  const verdict = await monitorAttempt(fakeEnv({}), {
    changedPaths: ["test/a.test.ts"],
    changeSummary: "weaken a test",
    reasoning: "it was flaky",
    diff: "code",
  });
  assert.equal(verdict.source, "paths", "the model half ran for a path the pattern already refused");
});

// ---- the drift gate ---------------------------------------------------------

function run(over: Partial<RunRow>): RunRow {
  return { ...(IMPROVE_RUN_DEFAULTS as unknown as RunRow), ...over };
}

test("a revert ratio over the ceiling pauses the namespace", () => {
  const runs = [
    run({ id: "r3", attempts: 10, reverts: 8 }),
    run({ id: "r2", attempts: 10, reverts: 7 }),
    run({ id: "r1", attempts: 10, reverts: 6 }),
  ];
  const verdict = driftVerdict(runs);
  assert.equal(verdict.pause, true);
  assert.equal(verdict.attempts, 30);
  assert.equal(verdict.reverts, 21);
  assert.match(verdict.reason ?? "", /70%/);
  assert.match(verdict.reason ?? "", /paused until someone looks/);
});

test("a ratio under the ceiling does not pause", () => {
  const runs = [
    run({ id: "r3", attempts: 10, reverts: 5 }),
    run({ id: "r2", attempts: 10, reverts: 6 }),
    run({ id: "r1", attempts: 10, reverts: 5 }),
  ];
  const verdict = driftVerdict(runs);
  assert.equal(verdict.pause, false);
  assert.equal(verdict.reason, null);
});

test("FEWER THAN THREE RUNS NEVER PAUSES", () => {
  // A single bad night is noise. Pausing on it would stop every namespace on its
  // first night, before the loop had done anything to judge.
  const bad = run({ attempts: 10, reverts: 10 });
  assert.equal(driftVerdict([bad]).pause, false);
  assert.equal(driftVerdict([bad, bad]).pause, false);
  assert.equal(driftVerdict([bad, bad, bad]).pause, true, "three bad runs should pause");
});

test("a window with NO attempts does not pause, and does not divide by zero", () => {
  const empty = [run({ attempts: 0, reverts: 0 }), run({ attempts: 0, reverts: 0 }), run({ attempts: 0, reverts: 0 })];
  const verdict = driftVerdict(empty);
  assert.equal(verdict.pause, false);
  assert.equal(verdict.ratio, 0);
  assert.ok(Number.isFinite(verdict.ratio));
});

test("only the newest three runs are considered", () => {
  const window = Array.from({ length: DRIFT_RUN_WINDOW }, (_, i) => run({ id: `new${i}`, attempts: 10, reverts: 1 }));
  const ancient = Array.from({ length: 10 }, (_, i) => run({ id: `old${i}`, attempts: 10, reverts: 10 }));
  const verdict = driftVerdict([...window, ...ancient]);
  assert.equal(verdict.runsConsidered, DRIFT_RUN_WINDOW);
  assert.equal(verdict.attempts, 30, "runs outside the window were counted");
  assert.equal(verdict.pause, false);
});

test("the numbers behind the verdict are reported, not just the conclusion", () => {
  const verdict = driftVerdict([
    run({ attempts: 5, reverts: 4 }),
    run({ attempts: 5, reverts: 4 }),
    run({ attempts: 5, reverts: 4 }),
  ]);
  assert.equal(verdict.attempts, 15);
  assert.equal(verdict.reverts, 12);
  assert.equal(verdict.runsConsidered, 3);
  assert.ok(Math.abs(verdict.ratio - 0.8) < 1e-9);
});

test("AN ANCHOR DROP PAUSES IMMEDIATELY, without waiting three runs", () => {
  const anchors = parseScoresDoc(
    "x",
    "# s\n\n## Anchors\n\n- holdout_pass_rate: min 0.9\n\n## Secondary\n\n- a: maximize weight 1\n"
  ).anchors;
  const verdict = anchorDriftVerdict(anchors, { holdout_pass_rate: 1 }, { holdout_pass_rate: 0.95 });
  assert.equal(verdict.pause, true);
  assert.match(verdict.reason ?? "", /an anchor dropped against the best recorded run/);
  assert.match(verdict.reason ?? "", /a regression in progress/);
});

test("no anchor drop, no pause", () => {
  const anchors = parseScoresDoc("capsid", seedScoresDoc("capsid")).anchors;
  const verdict = anchorDriftVerdict(anchors, { build_passes: 1, holdout_pass_rate: 1 }, { build_passes: 1, holdout_pass_rate: 1 });
  assert.equal(verdict.pause, false);
  assert.equal(verdict.reason, null);
});
