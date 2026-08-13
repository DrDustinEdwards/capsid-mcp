import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";

// THE BEHAVIOURAL HALF of the write-path invariants. test/invariants.test.ts reads
// the source; this file DRIVES the real tool handlers over a real MCP connection
// and records the SQL they issue.
//
// Both halves exist because they fail differently. A source guard cannot tell
// whether a statement is reached: it would keep passing if the snapshot INSERT were
// still in the file but sat behind a condition that is never true. A behavioural
// test cannot tell whether a NEW tool skipped the invariant entirely. Together they
// cover "the statement is there" and "the statement is issued".
//
// The store is a fake D1 that answers by SQL shape and records everything. It is not
// a database and proves nothing about SQL correctness; it proves which statements a
// handler emits, which is precisely what the invariants are about.

interface Recorded {
  sql: string;
  params: unknown[];
  via: "batch" | "direct";
}

interface FakeOptions {
  namespaceExists?: boolean;
  body?: string;
}

function fakeDb(opts: FakeOptions = {}) {
  const { namespaceExists = true, body: priorBody = "prior body" } = opts;
  const recorded: Recorded[] = [];
  const doc = { id: 7, title: "Prior title", body: priorBody, type: "note", status: "published", tags: "a,b" };

  const answer = (sql: string) => {
    if (/FROM namespaces/i.test(sql)) return namespaceExists ? { namespace: "capsid" } : null;
    if (/FROM document_versions WHERE id/i.test(sql)) {
      return { id: 42, document_id: 7, namespace: "capsid", path: "doc.md", title: "Old title", body: "old body", snapshot_at: "2026-08-01 00:00:00" };
    }
    if (/SELECT 1 AS ok FROM documents/i.test(sql)) return { ok: 1 };
    if (/FROM documents/i.test(sql)) return doc;
    return null;
  };

  const stmt = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...bound: unknown[]) => stmt(sql, bound),
    first: async () => answer(sql),
    all: async () => ({ results: /FROM document_links/i.test(sql) ? [] : [answer(sql)].filter(Boolean), meta: { changes: 0 } }),
    run: async () => {
      recorded.push({ sql, params, via: "direct" });
      return { meta: { changes: 1 } };
    },
  });

  return {
    recorded,
    db: {
      prepare: (sql: string) => stmt(sql),
      batch: async (statements: Array<{ sql: string; params: unknown[] }>) => {
        for (const s of statements) recorded.push({ sql: s.sql, params: s.params, via: "batch" });
        return statements.map(() => ({ results: [], meta: { changes: 1 } }));
      },
    },
  };
}

async function connect(operator: boolean, opts: FakeOptions = {}) {
  const { recorded, db } = fakeDb(opts);
  const server = buildServer({ DB: db } as never, operator, "test:guard");
  const client = new Client({ name: "invariant-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, recorded, close: () => client.close() };
}

const sqlFor = (recorded: Recorded[]) => recorded.map((r) => r.sql.replace(/\s+/g, " ")).join("\n");

// The four tools that overwrite, remove or rename a document, and what each one must
// issue. Adding a mutating tool without adding it here is the gap the source guard in
// invariants.test.ts covers from the other side.
const MUTATORS = [
  {
    tool: "write",
    args: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true },
    requires: [/INSERT INTO document_versions/, /INSERT INTO audit_log/],
  },
  {
    tool: "delete",
    args: { namespace: "capsid", path: "doc.md", confirm: true },
    requires: [/INSERT INTO document_versions/, /INSERT INTO audit_log/],
  },
  {
    tool: "restore",
    args: { namespace: "capsid", path: "doc.md", version_id: 42, confirm: true },
    requires: [/INSERT INTO document_versions/, /INSERT INTO audit_log/],
  },
  {
    tool: "move",
    args: { namespace: "capsid", path: "doc.md", new_path: "moved.md" },
    // A rename has no body to snapshot; the audit row is the record.
    requires: [/INSERT INTO audit_log/],
  },
];

for (const { tool, args, requires } of MUTATORS) {
  test(`${tool} issues its snapshot and audit statements`, async () => {
    const { client, recorded, close } = await connect(true);
    const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    await close();
    assert.ok(!result.isError, `${tool} returned an error: ${result.content?.[0]?.text}`);
    // Vacuity guard: the handler has to have written something at all.
    assert.ok(recorded.length > 0, `${tool} issued no statements`);
    const sql = sqlFor(recorded);
    for (const re of requires) {
      assert.match(sql, re, `${tool} did not issue ${re}. Statements issued:\n${sql}`);
    }
  });

  test(`${tool} lands its mutation and its audit row in ONE batch`, async () => {
    // A separate .run() after the batch is two transactions, so the mutation and its
    // record can disagree: move worked that way until 2026-08-13, which left a
    // rename with no log entry possible in one direction and a log entry for a
    // rename that never happened in the other.
    const { client, recorded, close } = await connect(true);
    await client.callTool({ name: tool, arguments: args });
    await close();
    const direct = recorded.filter((r) => r.via === "direct");
    assert.deepEqual(
      direct.map((r) => r.sql.replace(/\s+/g, " ").slice(0, 60)),
      [],
      `${tool} issued statements outside the batch`
    );
  });
}

test("a read-only key cannot reach any mutating tool, and writes nothing", async () => {
  for (const { tool, args } of MUTATORS) {
    const { client, recorded, close } = await connect(false);
    const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    await close();
    assert.equal(result.isError, true, `${tool} did not refuse a read-only key`);
    assert.match(result.content[0].text, /write-grant operator key/);
    // The refusal has to come BEFORE any statement, not after the work is done.
    assert.deepEqual(recorded, [], `${tool} wrote ${recorded.length} statement(s) while refusing a read-only key`);
  }
});

test("write refuses when if_match does not describe the stored body", async () => {
  const { client, recorded, close } = await connect(true);
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true, if_match: "0".repeat(64) },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await close();
  assert.equal(result.isError, true, "a stale if_match was accepted");
  assert.match(result.content[0].text, /if_match mismatch/);
  // Fail closed: nothing written, and the caller is told the current sha.
  assert.deepEqual(recorded, [], "a refused if_match still wrote statements");
  assert.match(result.content[0].text, /Current sha256 is [0-9a-f]{64}/);
});

test("write accepts the if_match it just handed out", async () => {
  // The round trip that makes the feature usable: the sha of the stored body, as the
  // fake store reports it, is accepted.
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update("prior body").digest("hex");
  const { client, recorded, close } = await connect(true);
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true, if_match: sha },
  })) as { isError?: boolean };
  await close();
  assert.ok(!result.isError, "a correct if_match was refused");
  assert.match(sqlFor(recorded), /INSERT INTO document_versions/);
});

test("write, delete and move all refuse an unregistered namespace, and write nothing", async () => {
  // A typo in `namespace` used to open a shadow namespace: documents the namespaces
  // list cannot see, the lint loop never counts, and brief will never assemble.
  for (const { tool, args } of MUTATORS.filter((m) => m.tool !== "restore")) {
    const { client, recorded, close } = await connect(true, { namespaceExists: false });
    const result = (await client.callTool({
      name: tool,
      arguments: { ...args, namespace: "typoed-ns" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    await close();
    assert.equal(result.isError, true, `${tool} accepted an unregistered namespace`);
    assert.match(result.content[0].text, /unknown namespace/);
    assert.deepEqual(recorded, [], `${tool} wrote statements for an unregistered namespace`);
  }
});

test("mode meta leaves the body byte-identical, wide dash and all", async () => {
  // The body a meta write stores must be the body it read. A normalizer running over
  // an untouched body would rewrite prose nobody submitted, which is why mode 'meta'
  // skips normalization entirely.
  //
  // The fixture body carries a real U+2014, built from its code point rather than
  // typed. conventions.md requires detection machinery to write the character as an
  // escape so the file itself stays clean and greppable, and the repo's own
  // PreToolUse hook enforces that on this very file: it blocked two attempts to save
  // it with the literal character, which is the guard working.
  const EM_DASH = String.fromCharCode(0x2014);
  const dashed = `a body with an em ${EM_DASH} dash in it`;
  const { client, recorded, close } = await connect(true, { body: dashed });
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", mode: "meta", status: "closed" },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await close();
  assert.ok(!result.isError, `meta write failed: ${result.content?.[0]?.text}`);
  const upsert = recorded.find((r) => /INSERT INTO documents/i.test(r.sql));
  assert.ok(upsert, "meta write issued no upsert");
  assert.ok(
    (upsert.params as unknown[]).includes(dashed),
    `meta rewrote the body it was told to leave alone: ${JSON.stringify(upsert.params)}`
  );
  // And the prior metadata is in the audit row, because a version snapshot does not
  // carry type, status or tags.
  const audit = recorded.find((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.match(JSON.stringify(audit?.params), /prior_meta/);
});
