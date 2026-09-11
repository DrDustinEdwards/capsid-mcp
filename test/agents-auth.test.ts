import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/auth.ts";
import { SCOPE_FLAGS, defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { adminAgent, legacyAgent, resolveAgent } from "../src/agents.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// GROUP 2: a bearer resolves to a CALLER, not to a tier.
//
// What this replaces: `operatorIdentity` answered "write" or "read" and twelve hex of
// the presented key's digest. Every headless caller in the portfolio spoke that
// vocabulary, so the audit log could say a write happened and could not say whose
// credential did it beyond a fingerprint somebody had to recognise.
//
// The two properties that have to hold through the transition, and they pull in
// opposite directions:
//
//   1. A MINTED AGENT IS RESOLVED FIRST and carries exactly the scopes its row says.
//   2. AN OPERATOR KEY STILL WORKS, with the authority it has today, until Dustin
//      revokes it. A migration that breaks the existing key at the moment it lands is
//      a migration nobody can roll back through.

const KEY = "capsid_agent_" + "a".repeat(64);

async function envWithAgent(overrides: Record<string, unknown> = {}, rowOverrides: Record<string, unknown> = {}) {
  const key_hash = await sha256Hex(KEY);
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  const d1 = fakeD1({
    agents: [
      {
        id: "agent_0123456789ab",
        name: "capsid-driver",
        kind: "driver",
        key_hash,
        scopes: serializeScopes(scopes),
        created_by: "github:dustin",
        created_at: "2026-09-11 00:00:00",
        revoked_at: null,
        last_seen: null,
        ...rowOverrides,
      },
    ],
  });
  return { d1, env: fakeEnv({ DB: d1.db, OPERATOR_KEY_HASH: await sha256Hex("legacy-write-key"), ...overrides }) };
}

const bearer = (key: string) => new Request("https://capsid.example/ops/mcp", { headers: { Authorization: `Bearer ${key}` } });

test("a minted key resolves to its agent row, with that row's scopes and audit identity", async () => {
  const { env } = await envWithAgent();
  const resolved = await resolveAgent(bearer(KEY), env);
  assert.ok(resolved, "the minted key did not resolve");
  assert.equal(resolved.agent.name, "capsid-driver");
  assert.equal(resolved.agent.kind, "driver");
  assert.equal(resolved.agent.id, "agent_0123456789ab");
  assert.equal(resolved.agent.actor, "agent:capsid-driver", "the audit actor is the agent name");
  assert.deepEqual(resolved.agent.scopes.namespaces, ["capsid"]);
  assert.equal(resolved.agent.admin, false, "a minted agent is never admin: it cannot mint another");
  for (const flag of SCOPE_FLAGS) assert.equal(resolved.agent.scopes.flags[flag], false);
});

test("the agent row is looked up before OPERATOR_KEY_HASH is consulted", async () => {
  // Both would resolve. The row has to win, or a key that is BOTH an agent and an
  // operator entry would silently keep the operator key's full authority.
  const { env } = await envWithAgent({ OPERATOR_KEY_HASH: await sha256Hex(KEY) });
  const resolved = await resolveAgent(bearer(KEY), env);
  assert.ok(resolved);
  assert.equal(resolved.agent.name, "capsid-driver");
  assert.equal(resolved.agent.admin, false);
});

test("a revoked agent does not resolve, and does not fall through to the operator tier", async () => {
  const { env } = await envWithAgent({}, { revoked_at: "2026-09-11 01:00:00" });
  assert.equal(await resolveAgent(bearer(KEY), env), null);
});

test("an unknown bearer still falls back to OPERATOR_KEY_HASH, with the authority it has today", async () => {
  const { env } = await envWithAgent();
  const resolved = await resolveAgent(bearer("legacy-write-key"), env);
  assert.ok(resolved, "the legacy operator key stopped working, which is the one thing this migration must not do");
  assert.equal(resolved.agent.kind, "session");
  assert.deepEqual(resolved.agent.scopes.grants, ["read", "write"]);
  assert.equal(resolved.agent.scopes.namespaces, "*");
  for (const flag of SCOPE_FLAGS) {
    assert.equal(resolved.agent.scopes.flags[flag], true, `the legacy key must keep ${flag} until it is revoked by hand`);
  }
  assert.equal(resolved.agent.admin, true, "the legacy write key is what mints the first agents");
  assert.match(resolved.agent.actor, /^opkey:[0-9a-f]{12}$/, "the legacy key keeps its fingerprint actor");
});

test("a read-only operator key resolves to a read grant and no flags", async () => {
  const { env } = await envWithAgent({ OPERATOR_KEY_HASH: `ro:${await sha256Hex("legacy-read-key")}` });
  const resolved = await resolveAgent(bearer("legacy-read-key"), env);
  assert.ok(resolved);
  assert.deepEqual(resolved.agent.scopes.grants, ["read"]);
  assert.equal(resolved.agent.admin, false, "a read-only key cannot mint");
  for (const flag of SCOPE_FLAGS) assert.equal(resolved.agent.scopes.flags[flag], false);
});

test("no bearer, or a bearer nothing knows, resolves to nothing at all", async () => {
  const { env } = await envWithAgent();
  assert.equal(await resolveAgent(new Request("https://capsid.example/ops/mcp"), env), null);
  assert.equal(await resolveAgent(bearer("not-a-key"), env), null);
});

test("an OAuth admin session is the synthetic agent named admin, holding every scope", () => {
  const agent = adminAgent("DrDustinEdwards");
  assert.equal(agent.name, "admin");
  assert.equal(agent.actor, "github:DrDustinEdwards", "the login is more specific than the synthetic name, so the audit row keeps it");
  assert.equal(agent.scopes.namespaces, "*");
  assert.equal(agent.scopes.tools, "*");
  assert.deepEqual(agent.scopes.grants, ["read", "write"]);
  for (const flag of SCOPE_FLAGS) assert.equal(agent.scopes.flags[flag], true);
  assert.equal(agent.admin, true);
});

test("resolving touches last_seen, and does it off the answer rather than inside it", async () => {
  const { d1, env } = await envWithAgent();
  const resolved = await resolveAgent(bearer(KEY), env);
  assert.ok(resolved);
  assert.equal(d1.recorded.length, 0, "resolution must not commit anything on its own");
  await resolved.touch();
  const update = d1.recorded.find((r) => /UPDATE agents SET last_seen/i.test(r.sql));
  assert.ok(update, "touch() did not update last_seen");
  assert.equal(update.params[0], "agent_0123456789ab", "last_seen was written against the wrong row");
});

test("the legacy grant vocabulary still builds a caller, which is what keeps the tests and the fallback honest", () => {
  const write = legacyAgent("write", "test:guard");
  assert.deepEqual(write.scopes.grants, ["read", "write"]);
  assert.equal(write.actor, "test:guard");
  const read = legacyAgent("read", "test:ro");
  assert.deepEqual(read.scopes.grants, ["read"]);
  for (const flag of SCOPE_FLAGS) assert.equal(read.scopes.flags[flag], false);
});
