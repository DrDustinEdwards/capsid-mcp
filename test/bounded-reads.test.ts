import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { GATHER_BUDGET, MAX_ROWS, SEARCH_ROWS } from "../src/limits.ts";
import { type DocRow, fakeD1, fakeEnv, type FakeD1Options, type Recorded } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";

// EVERY READ IS BOUNDED, AND SAYS SO WHEN IT CUT (audit 9.2).
//
// Before this, `list`, `find` and the resource listing had no LIMIT at all and
// `search` had one that it never mentioned. All four returned a bare array, and a
// bare array cannot distinguish "these are all of them" from "these are the first
// of them". That is the failure this file exists to prevent: not a crash, but a
// caller reasoning confidently over a silently truncated answer.
//
// Two things are asserted at every site, and the second is the one that matters:
//   1. the RESPONSE reports the truncation, and
//   2. the QUERY asked the store for a bounded page.
// Only the second protects the isolate. A handler that fetched every row and then
// sliced would satisfy (1) while still materializing the whole table, so the bound
// is asserted where it is actually enforced: the bound parameter.

async function connect(opts: FakeD1Options = {}) {
  const { db, reads } = fakeD1(opts);
  const server = buildServer(fakeEnv({ DB: db }), "write", "test:bounds");
  const client = new Client({ name: "bounds-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, reads, close: () => client.close() };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

// The bound is enforced in SQL, so the proof is the value bound to the LIMIT.
const limitBoundTo = (recorded: Recorded[], match: RegExp): unknown => {
  const stmt = recorded.find((r) => match.test(r.sql.replace(/\s+/g, " ")));
  assert.ok(stmt, `no statement matched ${match}`);
  assert.match(stmt.sql.replace(/\s+/g, " "), /LIMIT \?\d+/, "the query carries no LIMIT, so the whole table is materialized");
  return stmt.params[stmt.params.length - 1];
};

const docs = (n: number, namespace = "capsid", prefix = "doc"): DocRow[] =>
  Array.from({ length: n }, (_, i) => ({ namespace, path: `${prefix}-${String(i).padStart(4, "0")}.md`, title: `Doc ${i}` }));

test("list returns a bounded page and says it was cut", async () => {
  const { client, reads, close } = await connect({ documents: docs(MAX_ROWS + 25) });
  const out = parse(await call(client, "list", {}));
  await close();
  assert.equal(out.truncated, true, "list returned every row and claimed nothing was cut");
  assert.equal(out.count, MAX_ROWS);
  assert.equal(out.documents.length, MAX_ROWS);
  assert.equal(out.limit, MAX_ROWS);
  assert.match(out.note, /Returned the first 500 rows; there are more\./);
  // The advice must be actionable and must fit the call that was made: this one
  // passed no namespace, so naming the namespace filter is the useful next step.
  assert.match(out.note, /Narrow with namespace/);
  // ONE more row than it returns, which is the cheapest way to know there ARE more.
  assert.equal(limitBoundTo(reads, /FROM documents WHERE \(\?1 IS NULL OR namespace/), MAX_ROWS + 1);
});

test("list under the bound reports the whole answer, with no note", async () => {
  // The other side. A bound that reported truncation always would pass the test
  // above and make every complete answer look partial.
  const { client, close } = await connect({ documents: docs(3) });
  const out = parse(await call(client, "list", {}));
  await close();
  assert.equal(out.truncated, false);
  assert.equal(out.count, 3);
  assert.equal(out.note, undefined, "a complete list still carried a truncation note");
});

test("a namespace-scoped list is not truncated by another namespace's documents", async () => {
  // MAX_ROWS is set above the largest real namespace (245 of 557 documents on
  // 2026-08-17) precisely so scoped reads keep working untouched. If the filter
  // were dropped, these 30 rows would arrive with 600 others and truncate.
  const { client, close } = await connect({
    documents: [...docs(600, "recova"), ...docs(30, "capsid")],
  });
  const out = parse(await call(client, "list", { namespace: "capsid" }));
  await close();
  assert.equal(out.truncated, false, "a scoped list truncated, so the filter is not reaching the query");
  assert.equal(out.count, 30);
});

test("find returns a bounded page and says it was cut", async () => {
  const { client, reads, close } = await connect({ documents: docs(MAX_ROWS + 10) });
  const out = parse(await call(client, "find", { glob: "doc-*.md" }));
  await close();
  assert.equal(out.truncated, true);
  assert.equal(out.count, MAX_ROWS);
  assert.match(out.note, /Tighten the glob/);
  assert.equal(limitBoundTo(reads, /WHERE path GLOB/), MAX_ROWS + 1);
});

test("find matching a handful is complete, and the glob really filtered", async () => {
  // Guards the fake as much as the handler: if globMatch matched everything, the
  // count below would be 400 and the truncation test above would pass vacuously.
  const { client, close } = await connect({
    documents: [...docs(400, "capsid", "other"), ...docs(4, "capsid", "notes/session")],
  });
  const out = parse(await call(client, "find", { glob: "notes/*.md" }));
  await close();
  assert.equal(out.truncated, false);
  assert.equal(out.count, 4, "the glob did not filter, so this proves nothing about the bound");
});

test("search returns its top page and says when more matched", async () => {
  const { client, reads, close } = await connect({ ftsRows: SEARCH_ROWS + 5 });
  const out = parse(await call(client, "search", { query: "anything" }));
  await close();
  assert.equal(out.truncated, true, "search silently returned a full page as if it were the whole answer");
  assert.equal(out.count, SEARCH_ROWS);
  assert.match(out.note, /Add a namespace or type filter/);
  assert.equal(limitBoundTo(reads, /FROM documents_fts/), SEARCH_ROWS + 1);
});

test("search with few hits is not reported as truncated", async () => {
  const { client, close } = await connect({ ftsRows: 2 });
  const out = parse(await call(client, "search", { query: "anything" }));
  await close();
  assert.equal(out.truncated, false);
  assert.equal(out.count, 2);
});

// ---- gather ------------------------------------------------------------------

// A packet that trims must still be a USABLE packet: core and the rules survive
// whatever else goes, because they are the instructions for the job.
const BIG = "x".repeat(40_000);

const gatherFixture = (): FakeD1Options => ({
  documents: [
    { namespace: "capsid", path: "core.md", type: "note", body: "the core" },
    { namespace: "capsid", path: "schema.md", type: "note", body: "the schema rules" },
    { namespace: "capsid", path: "conventions.md", type: "note", body: "the conventions" },
    ...Array.from({ length: 4 }, (_, i) => ({
      namespace: "capsid",
      path: `concept-${i}.md`,
      type: "concept",
      body: BIG,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      namespace: "capsid",
      path: `session-${i}.md`,
      type: "episodic",
      body: BIG,
      created_at: `2026-08-0${i + 1} 00:00:00`,
    })),
  ],
});

test("gather trims an oversized packet and names what it dropped", async () => {
  // 8 x 40KB of body against a 150KB budget, so the packet cannot fit and the
  // tool must choose. Before this it simply returned all 320KB with a warning.
  const { client, close } = await connect(gatherFixture());
  const out = parse(await call(client, "lint", { namespace: "capsid", mode: "gather" }));
  await close();

  assert.equal(out.truncated, true, "an oversized packet reported itself as whole");
  assert.ok(out.packet_chars <= GATHER_BUDGET, `packet is ${out.packet_chars}, over the ${GATHER_BUDGET} budget`);
  assert.equal(out.budget, GATHER_BUDGET);
  assert.ok(Array.isArray(out.trimmed) && out.trimmed.length > 0, "nothing was named as trimmed");

  // The wiki stubs first, and every stub says where to read the real thing.
  assert.match(out.trimmed.join(" | "), /wiki bodies/);
  for (const row of out.wiki) {
    assert.match(row.body, /^\(trimmed for size: read capsid\/concept-\d\.md\)$/);
  }
  // core and the rules are never trimmed: without them the packet is useless.
  assert.equal(out.core.body, "the core");
  assert.deepEqual(
    out.rules.map((r: { path: string; body: string }) => r.body).sort(),
    ["the conventions", "the schema rules"]
  );
});

test("gather keeps the OLDEST unconsolidated bodies, which is the compile order", async () => {
  const { client, close } = await connect(gatherFixture());
  const out = parse(await call(client, "lint", { namespace: "capsid", mode: "gather" }));
  await close();

  const kept = out.unconsolidated.filter((r: { body: string }) => !r.body.startsWith("(trimmed"));
  const held = out.unconsolidated.filter((r: { body: string }) => r.body.startsWith("(trimmed"));
  assert.ok(kept.length > 0, "everything was held back, so the packet does no work");
  assert.ok(held.length > 0, "this fixture is meant to exceed the budget");
  // Whole documents, never half a body: a truncated markdown file cannot be told
  // apart from a complete one by the client reading it.
  for (const row of kept) assert.equal(row.body, BIG);
  // Oldest first. If this reversed, a client compiling "the next batch" would
  // repeatedly get the newest and never drain the queue.
  const keptPaths = kept.map((r: { path: string }) => r.path);
  assert.deepEqual(keptPaths, [...keptPaths].sort(), "kept documents are not the oldest by created_at");
  assert.ok(
    keptPaths[keptPaths.length - 1] < held[0].path,
    `kept ${keptPaths.join(",")} but held ${held.map((h: { path: string }) => h.path).join(",")}`
  );
  assert.match(out.trimmed.join(" | "), /unconsolidated bodies .*oldest were kept/);
});

test("a gather that fits is not trimmed at all", async () => {
  const { client, close } = await connect({
    documents: [
      { namespace: "capsid", path: "core.md", type: "note", body: "the core" },
      { namespace: "capsid", path: "session-0.md", type: "episodic", body: "small" },
    ],
  });
  const out = parse(await call(client, "lint", { namespace: "capsid", mode: "gather" }));
  await close();
  assert.equal(out.truncated, false);
  assert.equal(out.trimmed, undefined);
  assert.equal(out.unconsolidated[0].body, "small");
});

// ---- resources/list ----------------------------------------------------------

test("resources/list is bounded, and hands back a cursor to the rest", async () => {
  const { client, reads, close } = await connect({ documents: docs(MAX_ROWS + 7) });
  const first = await client.listResources();
  assert.equal(first.resources.length, MAX_ROWS, "the resource listing is unbounded");
  assert.ok(first.nextCursor, "the listing was capped with no way to reach the rest");
  assert.equal(limitBoundTo(reads, /SELECT namespace, path, title FROM documents/), MAX_ROWS + 1);

  // The cap is only safe because page 2 is reachable, so prove it is.
  const second = await client.listResources({ cursor: first.nextCursor });
  await close();
  assert.equal(second.resources.length, 7, "the second page did not return the remainder");
  assert.equal(second.nextCursor, undefined, "the last page still advertised more");

  // No overlap and no gap: keyset pagination is only correct if the tuple compare
  // is right, and an off-by-one there repeats or skips a document silently.
  const firstUris = first.resources.map((r) => r.uri);
  const secondUris = second.resources.map((r) => r.uri);
  assert.equal(new Set([...firstUris, ...secondUris]).size, MAX_ROWS + 7, "pages overlap or drop documents");
});

test("resources/list paginates across namespaces without skipping a boundary", async () => {
  // The tuple compare exists for exactly this: 'ns-a' and 'ns' both prefix each
  // other once a separator is glued on, so a concatenated cursor key reorders the
  // rows and loses whichever straddles the page edge.
  const { client, close } = await connect({
    documents: [...docs(MAX_ROWS - 1, "ns"), ...docs(4, "ns-a")],
  });
  const first = await client.listResources();
  const second = await client.listResources({ cursor: first.nextCursor });
  await close();
  const all = [...first.resources, ...second.resources].map((r) => r.uri);
  assert.equal(new Set(all).size, MAX_ROWS + 3, "a document was skipped or repeated at the namespace boundary");
});

test("a small resource listing carries no cursor", async () => {
  const { client, close } = await connect({ documents: docs(5) });
  const listed = await client.listResources();
  await close();
  assert.equal(listed.resources.length, 5);
  assert.equal(listed.nextCursor, undefined, "a complete listing advertised another page");
});

test("the resources/list override cannot silently drop a statically registered resource", async () => {
  // The handler below replaces the one McpServer installs, which also serves
  // resources registered by URI rather than by template. There are none today and
  // this is what notices if one is added.
  const text = sourceFile("server.ts");
  assert.equal(
    text.split("server.registerResource(").length - 1,
    1,
    "a second resource registration exists; the ListResources override serves only the document template"
  );
  assert.match(text, /setRequestHandler\(ListResourcesRequestSchema/, "the paginating list handler is gone");
});
