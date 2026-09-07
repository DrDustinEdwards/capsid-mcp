import assert from "node:assert/strict";
import { test } from "node:test";
import { improveControl, improveStatus } from "../src/improve-run.ts";
import { BUDGET_KEY, MODE_KEY, pausedKey, ROSTER } from "../src/improve-schema.ts";
import { pausedReason, readBudget, readMode } from "../src/improve-state.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// GROUP: improve_run's control actions. Each writes ONE KV value, audits it, and
// reads it back, so a test proves three things per action: the value landed in KV,
// an audit_log row was written, and the returned value is the read-back (not just
// the input echoed). Every path is write-gated at the tool boundary; that gate is
// the mayWrite check shared with the run path and is asserted in improve-tools.

function harness(seed: Record<string, string> = {}) {
  const kv = fakeKv({ seed });
  const d1 = fakeD1();
  return { env: fakeEnv({ APP_KV: kv.kv, DB: d1.db }), kv, d1 };
}

const audited = (d1: ReturnType<typeof fakeD1>) => d1.batches.some((b) => b.some((s) => /INSERT INTO audit_log/.test(s)));

test("mode sets improve_mode, audits, and reads it back", async () => {
  const { env, kv, d1 } = harness();
  const r = await improveControl(env, "mode", { value: "subscription" });
  assert.equal(r.action, "mode");
  if (r.action === "mode") assert.equal(r.mode, "subscription");
  assert.equal(kv.store.get(MODE_KEY), "subscription");
  assert.ok(audited(d1), "no audit_log row was written for the mode change");
  assert.equal((await readMode(kv.kv)).mode, "subscription");
});

test("mode rejects an unknown value and changes nothing", async () => {
  const { env, kv } = harness();
  await assert.rejects(() => improveControl(env, "mode", { value: "turbo" }), /one of/);
  assert.equal(kv.store.has(MODE_KEY), false);
});

test("pause sets the key with a reason and reads it back; unpause clears it", async () => {
  const { env, kv, d1 } = harness();
  const p = await improveControl(env, "pause", { namespace: "capsid", reason: "manual hold" });
  assert.equal(p.action, "pause");
  if (p.action === "pause") assert.equal(p.paused.capsid, "manual hold");
  assert.equal(kv.store.get(pausedKey("capsid")), "manual hold");
  assert.ok(audited(d1));

  const u = await improveControl(env, "unpause", { namespace: "capsid" });
  if (u.action === "unpause") assert.equal(u.paused.capsid, null);
  assert.equal(kv.store.has(pausedKey("capsid")), false);
  assert.equal(await pausedReason(kv.kv, "capsid"), null);
});

test('pause "all" pauses every roster namespace with the default reason', async () => {
  const { env, kv } = harness();
  const r = await improveControl(env, "pause", { namespace: "all" });
  for (const ns of ROSTER) assert.equal(kv.store.get(pausedKey(ns)), "paused via improve_run");
  if (r.action === "pause") assert.deepEqual(r.namespaces.slice().sort(), [...ROSTER].sort());
});

test("pause rejects a non-roster namespace and a missing target", async () => {
  const { env, kv } = harness();
  await assert.rejects(() => improveControl(env, "pause", { namespace: "nope" }), /not on the improve roster/);
  await assert.rejects(() => improveControl(env, "pause", {}), /needs a namespace/);
  assert.equal(kv.store.size, 0);
});

test("budget sets both caps, audits, and reads them back", async () => {
  const { env, kv, d1 } = harness();
  const r = await improveControl(env, "budget", { actions_minutes_month: 500, model_usd_month: 80 });
  assert.equal(r.action, "budget");
  if (r.action === "budget") {
    assert.equal(r.caps.actions_minutes_month, 500);
    assert.equal(r.caps.model_usd_month, 80);
  }
  const caps = await readBudget(kv.kv);
  assert.equal(caps.actions_minutes_month, 500);
  assert.equal(caps.model_usd_month, 80);
  assert.ok(audited(d1));
});

test("budget rejects a non-positive or missing cap", async () => {
  const { env, kv } = harness();
  await assert.rejects(() => improveControl(env, "budget", { actions_minutes_month: 0, model_usd_month: 80 }), /positive number/);
  await assert.rejects(() => improveControl(env, "budget", { actions_minutes_month: 500 }), /positive number/);
  assert.equal(kv.store.has(BUDGET_KEY), false);
});

test("improve_status reflects a mode change and a pause set through the control action", async () => {
  const { env } = harness();
  await improveControl(env, "mode", { value: "api" });
  await improveControl(env, "pause", { namespace: "capsid", reason: "held" });
  const status = await improveStatus(env);
  assert.equal(status.mode, "api");
  const capsid = status.namespaces.find((n) => n.namespace === "capsid");
  assert.equal(capsid?.paused, "held");
});
