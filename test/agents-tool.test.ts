import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { sha256Hex } from "../src/auth.ts";
import { SCOPE_FLAGS, defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { adminAgent, legacyAgent, type Agent } from "../src/agents.ts";
import { fakeD1, fakeEnv, type FakeD1 } from "./fakes.ts";

// GROUP 4: MINTING, over a real MCP connection.
//
// The property that matters is not that mint works. It is WHO may call it. A minted
// agent that can mint another agent has a privilege-escalation path with no ceiling:
// a driver scoped to one namespace mints itself a seat scoped to all of them, and
// every scope below is decoration. So `admin` is not a flag (a flag would be settable
// by update_scopes, which is the same escalation one step further out) and it is true
// only for the two identities that predate the table.

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function connect(caller: Agent, rows: Array<Record<string, unknown>> = []) {
  const d1: FakeD1 = fakeD1({ agents: rows });
  const server = buildServer(fakeEnv({ DB: d1.db }), caller);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    d1,
    call: (args: Record<string, unknown>) => client.callTool({ name: "agents", arguments: args }) as Promise<ToolResult>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const parse = (result: ToolResult) => JSON.parse(result.content[0].text) as Record<string, unknown>;

// TWO SHAPES OF NO, and the difference is deliberate. An AUTHORIZATION refusal is an
// MCP error (isError), because the caller asked for something it may never have. A
// DOMAIN refusal (this name is taken, there is no such agent) comes back as an
// ordinary result carrying ok:false and a refusal string, which is the shape the
// queue already uses for the same reason: the call was legitimate and the answer is
// no.
const refusalOf = (result: ToolResult) => String(parse(result).refusal ?? "");
const statements = (d1: FakeD1) => [...d1.reads, ...d1.recorded];

async function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent_0123456789ab",
    name: "capsid-driver",
    kind: "driver",
    key_hash: await sha256Hex("a-minted-key"),
    scopes: serializeScopes(defaultScopes(["capsid"])),
    created_by: "github:dustin",
    created_at: "2026-09-11 00:00:00",
    revoked_at: null,
    last_seen: null,
    ...overrides,
  };
}

test("mint returns the key ONCE and stores only its hash", async () => {
  const { d1, call, close } = await connect(adminAgent("DrDustinEdwards"));
  const result = await call({ action: "mint", name: "capsid-driver", kind: "driver", namespaces: ["capsid"] });
  await close();
  assert.notEqual(result.isError, true, result.content[0].text);
  const body = parse(result);
  const key = String(body.key);
  assert.match(key, /^capsid_agent_[0-9a-f]{64}$/);
  assert.match(String(body.note ?? ""), /once/i, "the response has to say the key is not recoverable");

  const insert = statements(d1).find((r) => /INSERT INTO agents/i.test(r.sql));
  assert.ok(insert, "mint did not insert the row");
  const stored = insert.params.map(String);
  assert.ok(!stored.includes(key), "THE PLAINTEXT KEY REACHED THE DATABASE");
  assert.ok(stored.includes(await sha256Hex(key)), "the row does not carry the key's sha256");

  // Audit-logged with the scopes, and with the hash rather than the key.
  const audit = statements(d1).find((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.ok(audit, "mint was not audit-logged");
  const params = JSON.stringify(audit.params);
  assert.ok(!params.includes(key), "THE PLAINTEXT KEY REACHED THE AUDIT LOG");
  assert.match(params, /namespaces/, "the audit row does not record the scopes the agent was minted with");
});

test("a new agent is born with read on its named namespaces and no flags", async () => {
  const { call, close } = await connect(adminAgent("DrDustinEdwards"));
  const body = parse(await call({ action: "mint", name: "capsid-driver", kind: "driver", namespaces: ["capsid"] }));
  await close();
  const scopes = body.scopes as { namespaces: string[]; grants: string[]; flags: Record<string, boolean> };
  assert.deepEqual(scopes.namespaces, ["capsid"]);
  assert.deepEqual(scopes.grants, ["read"]);
  for (const flag of SCOPE_FLAGS) assert.equal(scopes.flags[flag], false);
});

test("A MINTED AGENT CANNOT MINT, REVOKE OR RE-SCOPE ANOTHER", async () => {
  // The escalation this exists to refuse. The caller here holds write on its own
  // namespace, which is more than a driver needs and still not enough for this.
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  const minted: Agent = {
    id: "agent_0123456789ab",
    name: "capsid-driver",
    kind: "driver",
    actor: "agent:capsid-driver",
    scopes,
    admin: false,
    row: null,
  };
  const { d1, call, close } = await connect(minted, [await liveRow()]);
  for (const args of [
    { action: "mint", name: "a-second-agent", kind: "driver", namespaces: ["capsid"] },
    { action: "revoke", name: "capsid-driver" },
    { action: "update_scopes", name: "capsid-driver", grants: ["read", "write"] },
    { action: "list" },
  ]) {
    const result = await call(args);
    assert.equal(result.isError, true, `a minted agent reached agents action '${args.action}'`);
    assert.match(result.content[0].text, /admin/i, `the refusal for '${args.action}' does not say what is missing`);
  }
  await close();
  assert.equal(d1.recorded.length, 0, "a refused call wrote something");
});

test("a read-only caller is refused before the admin check even runs", async () => {
  const { call, close } = await connect(legacyAgent("read", "opkey:0123456789ab"));
  const result = await call({ action: "list" });
  await close();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires the write grant/);
});

test("list shows the inventory and last_seen, and never the verifier", async () => {
  const { call, close } = await connect(adminAgent("DrDustinEdwards"), [
    await liveRow({ last_seen: "2026-09-11 01:30:00" }),
    await liveRow({ id: "agent_ffffffffffff", name: "retired", key_hash: await sha256Hex("other"), revoked_at: "2026-09-10 00:00:00" }),
  ]);
  const body = parse(await call({ action: "list" }));
  await close();
  const agents = body.agents as Array<Record<string, unknown>>;
  assert.equal(agents.length, 2, "list hides revoked agents, which is how a revoked credential becomes invisible instead of accounted for");
  const live = agents.find((a) => a.name === "capsid-driver");
  assert.ok(live);
  assert.equal(live.last_seen, "2026-09-11 01:30:00");
  assert.equal(live.revoked_at, null);
  assert.ok(!("key_hash" in live), "list handed out the stored verifier");
  assert.match(String(live.fingerprint), /^[0-9a-f]{12}$/, "an agent needs a short handle to match against an audit row");
});

test("revoke is a timestamp, not a delete, so the audit rows it wrote still resolve", async () => {
  const { d1, call, close } = await connect(adminAgent("DrDustinEdwards"), [await liveRow()]);
  const result = await call({ action: "revoke", name: "capsid-driver" });
  await close();
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(parse(result).ok, true, refusalOf(result));
  const update = statements(d1).find((r) => /UPDATE agents SET revoked_at/i.test(r.sql));
  assert.ok(update, "revoke did not set revoked_at");
  assert.ok(!statements(d1).some((r) => /DELETE FROM agents/i.test(r.sql)), "revoke deleted the row");
  assert.match(update.sql, /RETURNING/i, "the transition is not a keyed UPDATE with RETURNING, so a no-op reports success");
});

test("revoking or re-scoping an agent that is not there is a refusal, not a silent success", async () => {
  const { call, close } = await connect(adminAgent("DrDustinEdwards"));
  for (const action of ["revoke", "update_scopes"]) {
    const result = await call({ action, name: "nobody", grants: ["read"] });
    assert.equal(parse(result).ok, false, `${action} reported success over a missing row`);
    assert.match(refusalOf(result), /no live agent named 'nobody'/);
  }
  await close();
});

test("update_scopes replaces the scopes and records both sides in the audit row", async () => {
  const { d1, call, close } = await connect(adminAgent("DrDustinEdwards"), [await liveRow()]);
  const result = await call({ action: "update_scopes", name: "capsid-driver", grants: ["read", "write"], flags: { can_direct_write: true } });
  await close();
  assert.notEqual(result.isError, true, result.content[0].text);
  const body = parse(result);
  assert.equal(body.ok, true, refusalOf(result));
  const scopes = body.scopes as { grants: string[]; flags: Record<string, boolean> };
  assert.deepEqual(scopes.grants, ["read", "write"]);
  assert.equal(scopes.flags.can_direct_write, true);
  assert.equal(scopes.flags.can_merge, false, "an unnamed flag must not be turned on by a call that did not name it");
  const audit = statements(d1).find((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.ok(audit, "update_scopes was not audit-logged");
  assert.match(JSON.stringify(audit.params), /before/, "the audit row does not record what the scopes were before");
});

test("mint refuses a kind the table does not have, and a name that is already taken", async () => {
  const { call, close } = await connect(adminAgent("DrDustinEdwards"), [await liveRow()]);
  const badKind = await call({ action: "mint", name: "new-one", kind: "superuser", namespaces: ["capsid"] });
  assert.equal(parse(badKind).ok, false);
  assert.match(refusalOf(badKind), /session, driver, seat, cron/);
  const taken = await call({ action: "mint", name: "capsid-driver", kind: "driver", namespaces: ["capsid"] });
  assert.equal(parse(taken).ok, false);
  assert.match(refusalOf(taken), /already/i);
  await close();
});

test("mint needs at least one namespace, or the default scope means nothing", async () => {
  const { call, close } = await connect(adminAgent("DrDustinEdwards"));
  const result = await call({ action: "mint", name: "new-one", kind: "driver", namespaces: [] });
  await close();
  assert.equal(parse(result).ok, false);
  assert.match(refusalOf(result), /namespace/i);
});
