import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DAY_UTC,
  discoverModels,
  guideKey,
  readSchedule,
  SCHEDULE_KEY,
  sha256Hex,
  SKILLS_NAMESPACE,
  SKILLS_REFRESH_ACTOR,
  skillsRefreshAgent,
} from "../src/skills-refresh.ts";
import { SCOPE_FLAGS } from "../src/agents-schema.ts";
import { sourceFile } from "./source-files.ts";

// A KV that answers from a map, and one that throws, so both branches of the
// schedule read are driven rather than reasoned about.
function fakeKv(store: Record<string, string>): KVNamespace {
  return { get: async (k: string) => (k in store ? store[k] : null) } as unknown as KVNamespace;
}
const throwingKv = { get: async () => { throw new Error("KV is down"); } } as unknown as KVNamespace;

const OVERVIEW = "| Claude Fable 5.1 | `claude-fable-5-1` |\n| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` |";

test("discovers models and collapses dated snapshots", () => {
  const slugs = discoverModels(OVERVIEW);
  assert.deepEqual(slugs, ["fable-5-1", "haiku-4-5"]);
  assert.ok(slugs.length > 0, "parsed zero models means the matcher broke");
});

test("THE WORKER AND THE REPO SCRIPT AGREE ON WHAT A MODEL ID LOOKS LIKE", async () => {
  // The same discovery runs in two places: here, and in claude-skills'
  // scripts/model-guides.mjs. A list spelled twice is a list that drifts, and the
  // copy nobody looked at is the one that stops seeing a new model family.
  const { readFileSync, existsSync } = await import("node:fs");
  const path = "C:/Users/email/dev/claude-skills/scripts/model-guides.mjs";
  if (!existsSync(path)) {
    assert.ok(true, "claude-skills is not checked out beside this repo; skipped");
    return;
  }
  const script = readFileSync(path, "utf8");
  const theirs = /const MODEL_ID = (\/.+\/g);/.exec(script);
  assert.ok(theirs, "scripts/model-guides.mjs no longer declares MODEL_ID");
  const mine = /const MODEL_ID = (\/.+\/g);/.exec(sourceFile("skills-refresh.ts"));
  assert.ok(mine, "src/skills-refresh.ts no longer declares MODEL_ID");
  assert.equal(mine[1], theirs[1], "the Worker and the repo script disagree about what a model id looks like");
});

test("an unset key takes the documented default and runs", async () => {
  const schedule = await readSchedule(fakeKv({}));
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.dayUtc, DEFAULT_DAY_UTC);
  assert.equal(DEFAULT_DAY_UTC, 1, "the default day is Monday");
});

test("A KV THAT THREW DISABLES THE RUN", async () => {
  // Deliberately not the same as the unset key. An unset key is a configuration
  // that was never written; a throw is a fault, and a fault does not start work.
  const schedule = await readSchedule(throwingKv);
  assert.equal(schedule.enabled, false);
  assert.match(schedule.reason ?? "", /KV is down/);
});

test("an explicit disable is honoured", async () => {
  const schedule = await readSchedule(fakeKv({ [SCHEDULE_KEY]: '{"enabled":false}' }));
  assert.equal(schedule.enabled, false);
});

test("a configured day overrides the default", async () => {
  const schedule = await readSchedule(fakeKv({ [SCHEDULE_KEY]: '{"dayUtc":4}' }));
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.dayUtc, 4);
});

test("garbage in the key disables rather than guessing", async () => {
  for (const raw of ["not json", "[]", '"a string"', '{"dayUtc":9}', '{"dayUtc":"monday"}', '{"dayUtc":1.5}']) {
    const schedule = await readSchedule(fakeKv({ [SCHEDULE_KEY]: raw }));
    assert.equal(schedule.enabled, false, `${raw} should have disabled the run`);
  }
});

test("the cron agent may reach exactly one namespace and holds no blast-radius flag", () => {
  const agent = skillsRefreshAgent();
  assert.equal(agent.actor, SKILLS_REFRESH_ACTOR);
  assert.match(agent.actor, /^agent:/, "the actor shape jobs.ts checks for");
  assert.equal(agent.kind, "cron");
  assert.equal(agent.admin, false);
  assert.deepEqual(agent.scopes.namespaces, [SKILLS_NAMESPACE]);
  assert.deepEqual(agent.scopes.repos, [], "the refresh cron reaches no repo directly");
  assert.deepEqual(agent.scopes.grants, ["write"]);
  // Derived from the flag list rather than spelled out, so a flag added to
  // SCOPE_FLAGS is asserted false here by the act of existing.
  for (const flag of SCOPE_FLAGS) {
    assert.equal(agent.scopes.flags[flag], false, `the refresh cron must not hold ${flag}`);
  }
  assert.ok(SCOPE_FLAGS.length > 0, "no flags were checked");
});

test("the schedule key is the one a human edits", () => {
  assert.equal(SCHEDULE_KEY, "skills:refresh:schedule");
});

test("the guide key is namespaced per model", () => {
  assert.equal(guideKey("fable-5-1"), "skills:guides:fable-5-1");
  assert.notEqual(guideKey("opus-5"), guideKey("sonnet-5"));
});

test("sha256Hex matches a known digest", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});
