import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type ToolGrant } from "../src/server.ts";
import { anchorChecksum, parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import { ROSTER } from "../src/improve-schema.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";

// THE TWO TOOLS, over a real MCP connection.
//
// The gate under test is the one test/invariants.test.ts asserts structurally for
// every other mutating tool: an `ro:` operator key must not reach improve_run.
// improve_run's own SQL lives in a helper, so the source scan there cannot see it,
// which is exactly why it is driven here instead.

const SCORES = seedScoresDoc("capsid");

async function connect(grant: ToolGrant) {
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "scores", body: SCORES, type: "reference" }],
  });
  const kv = fakeKv({
    seed: {
      improve_mode: "api",
      "improve:anchor:capsid": await anchorChecksum(parseScoresDoc("capsid", SCORES)),
    },
  });
  const env = fakeEnv({ DB: d1.db, APP_KV: kv.kv, HOLDOUT: fakeR2().bucket, MEDIA: fakeR2().bucket });
  const server = buildServer(env, grant, "opkey:test");
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    d1,
    kv,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

test("both tools are registered and discoverable", async () => {
  const { client, close } = await connect("write");
  const names = (await client.listTools()).tools.map((t) => t.name);
  await close();
  assert.ok(names.includes("improve_run"), "improve_run is not registered");
  assert.ok(names.includes("improve_status"), "improve_status is not registered");
});

test("A READ-ONLY KEY CANNOT REACH improve_run, and writes nothing while refusing", async () => {
  await withFetch({}, async () => {
    const { client, d1, kv, close } = await connect("read");
    const result = (await client.callTool({ name: "improve_run", arguments: { namespace: "capsid" } })) as ToolResult;
    await close();
    assert.equal(result.isError, true, "a read-only key reached improve_run");
    assert.match(result.content[0].text, /write-grant operator key/);
    // The refusal has to come BEFORE any statement, not after the work is done.
    assert.deepEqual(d1.recorded, [], "improve_run wrote statements while refusing a read-only key");
    assert.deepEqual(kv.puts, [], "improve_run wrote to KV while refusing a read-only key");
  });
});

test("a read-only key CAN read improve_status, because it is a read tool", async () => {
  await withFetch({}, async () => {
    const { client, close } = await connect("read");
    const result = (await client.callTool({ name: "improve_status", arguments: { namespace: "capsid" } })) as ToolResult;
    await close();
    assert.ok(!result.isError, `improve_status refused a read-only key: ${result.content?.[0]?.text}`);
    const parsed = JSON.parse(result.content[0].text) as { mode: string; namespaces: Array<{ namespace: string }> };
    assert.equal(parsed.mode, "api");
    assert.equal(parsed.namespaces[0].namespace, "capsid");
  });
});

test("improve_status NEVER WRITES, whatever grant it is called with", async () => {
  for (const grant of ["read", "write"] as const) {
    await withFetch({}, async () => {
      const { client, d1, kv, close } = await connect(grant);
      await client.callTool({ name: "improve_status", arguments: {} });
      await close();
      assert.deepEqual(d1.recorded, [], `improve_status wrote statements under the ${grant} grant`);
      assert.deepEqual(kv.puts, [], `improve_status wrote to KV under the ${grant} grant`);
    });
  }
});

test("improve_run REFUSES A NAMESPACE THAT IS NOT ON THE ROSTER, and names the roster", async () => {
  await withFetch({}, async () => {
    const { client, d1, close } = await connect("write");
    const result = (await client.callTool({ name: "improve_run", arguments: { namespace: "julieedwards" } })) as ToolResult;
    await close();
    assert.equal(result.isError, true, "an off-roster namespace was accepted");
    assert.match(result.content[0].text, /not on the improve roster/);
    for (const namespace of ROSTER) {
      assert.match(result.content[0].text, new RegExp(namespace), `the refusal does not name ${namespace}`);
    }
    assert.deepEqual(d1.recorded, [], "an off-roster refusal still wrote statements");
  });
});

test("improve_run with dry_run WRITES NOTHING through the tool surface either", async () => {
  await withFetch({}, async (calls) => {
    const { client, d1, kv, close } = await connect("write");
    const result = (await client.callTool({
      name: "improve_run",
      arguments: { namespace: "capsid", dry_run: true },
    })) as ToolResult;
    await close();
    assert.ok(!result.isError, `dry_run errored: ${result.content?.[0]?.text}`);
    const parsed = JSON.parse(result.content[0].text) as { dry_run: boolean; opened: Array<{ note: string }> };
    assert.equal(parsed.dry_run, true);
    assert.match(parsed.opened[0].note, /would open a run/);
    assert.deepEqual(d1.recorded, [], "a dry run through the tool wrote statements");
    assert.deepEqual(kv.puts, [], "a dry run through the tool wrote to KV");
    assert.deepEqual(calls, [], "a dry run through the tool made a network call");
  });
});

// ---- the gate, in source ----------------------------------------------------

test("improve_run carries the operator gate IN ITS OWN BLOCK", () => {
  // test/invariants.test.ts finds mutating tools by scanning for SQL inside a
  // registerTool block. improve_run's SQL is in a helper, so that scan cannot see
  // it and cannot demand the gate. Asserted here instead, by name.
  const server = sourceFile("server.ts");
  const start = server.indexOf('"improve_run"');
  const end = server.indexOf('"improve_status"');
  assert.ok(start !== -1 && end > start, "could not bound the improve_run registration");
  const block = server.slice(start, end);
  assert.match(block, /if \(!mayWrite\) return fail\(DENIED\);/, "improve_run lost its write gate");
});

test("improve_status carries NO gate, and no mutating SQL, because it is a read tool", () => {
  const server = sourceFile("server.ts");
  const start = server.indexOf('"improve_status"');
  const end = server.indexOf("const RESOURCE_METADATA", start);
  assert.ok(start !== -1 && end > start, "could not bound the improve_status registration");
  const block = server.slice(start, end);
  assert.equal(/if \(!mayWrite\)/.test(block), false, "improve_status gained a write gate; it is a read tool");
  assert.equal(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(block), false, "improve_status contains mutating SQL");
});
