import assert from "node:assert/strict";
import { test } from "node:test";
import { improveStatus } from "../src/improve-run.ts";
import { sha256Hex } from "../src/auth.ts";
import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2 } from "./fakes.ts";

// GROUP 7: THE INVENTORY IS VISIBLE FROM THE CONSOLE THE DRIVER ALREADY READS.
//
// improve_status is what a session calls at the start of a run and what the console
// renders. A credential inventory that can only be read by calling a separate
// admin-only tool is one nobody looks at, and last_seen only answers "is this still
// in use" if somebody sees it.

async function statusEnv(agents: Array<Record<string, unknown>>) {
  const d1 = fakeD1({ agents });
  return fakeEnv({ DB: d1.db, APP_KV: fakeKv({}).kv, MEDIA: fakeR2().bucket, HOLDOUT: fakeR2().bucket });
}

async function row(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `agent_${name.slice(0, 12).padEnd(12, "0")}`,
    name,
    kind: "driver",
    key_hash: await sha256Hex(name),
    scopes: serializeScopes(defaultScopes([name.replace("-driver", "")])),
    created_by: "github:DrDustinEdwards",
    created_at: "2026-09-11 00:00:00",
    revoked_at: null,
    last_seen: null,
    ...overrides,
  };
}

test("improve_status carries the agent inventory, with last_seen", async () => {
  const env = await statusEnv([
    await row("capsid-driver", { last_seen: "2026-09-11 02:00:00" }),
    await row("foxing-driver"),
  ]);
  const status = await improveStatus(env);
  assert.ok(Array.isArray(status.agents), "improve_status does not report the agents");
  const capsid = status.agents.find((a) => a.name === "capsid-driver");
  assert.ok(capsid, "the capsid driver is missing from the report");
  assert.equal(capsid.last_seen, "2026-09-11 02:00:00");
  assert.equal(capsid.kind, "driver");
  assert.deepEqual(capsid.namespaces, ["capsid"], "the report does not say what an agent may reach");
});

test("the report names the flags an agent HOLDS, not all six with a boolean beside each", async () => {
  // A row of six falses per agent is noise that hides the one agent holding
  // can_merge. What a reader wants from an inventory is the exception.
  const scopes = defaultScopes(["*"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  const env = await statusEnv([await row("seat", { kind: "seat", scopes: serializeScopes(scopes) })]);
  const status = await improveStatus(env);
  const seat = status.agents.find((a) => a.name === "seat");
  assert.ok(seat);
  assert.deepEqual(seat.flags, ["can_merge"]);
  const drivers = await improveStatus(await statusEnv([await row("capsid-driver")]));
  assert.deepEqual(drivers.agents[0].flags, [], "a driver holding nothing should report nothing rather than six falses");
});

test("a revoked agent is reported as revoked rather than dropped", async () => {
  // Dropping it makes "revoked" and "never existed" look the same to whoever is
  // reading the inventory to decide what is still live.
  const env = await statusEnv([await row("old-laptop", { revoked_at: "2026-09-10 12:00:00" })]);
  const status = await improveStatus(env);
  assert.equal(status.agents.length, 1);
  assert.equal(status.agents[0].revoked_at, "2026-09-10 12:00:00");
});

test("the report never carries a key or the stored verifier", async () => {
  const env = await statusEnv([await row("capsid-driver")]);
  const status = await improveStatus(env);
  const serialized = JSON.stringify(status.agents);
  assert.ok(!serialized.includes(await sha256Hex("capsid-driver")), "improve_status handed out the stored verifier");
  assert.ok(!/capsid_agent_/.test(serialized), "improve_status carries something shaped like a key");
});

test("a Worker with no agents yet reports an empty inventory rather than failing", async () => {
  // The state every deployment is in on the morning this ships, and the state the
  // portfolio stays in until the mint commands are run by hand.
  const status = await improveStatus(await statusEnv([]));
  assert.deepEqual(status.agents, []);
});
