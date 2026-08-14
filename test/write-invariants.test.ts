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
  updatedAt?: string;
  // The document does not exist, so the handler takes its create path.
  exists?: boolean;
  // A CONCURRENT WRITER. Runs once, immediately after the handler's pre-read of
  // the document row and therefore BEFORE its commit-time read and its batch.
  // That is exactly the window the write predicate exists to close: it is where
  // a racing write lands, and with a 90 second elicitation sitting in it, it is
  // not small.
  raceAfterPreRead?: (live: LiveState) => void;
}

interface LiveState {
  body: string | null;
  exists: boolean;
  updatedAt: string;
}

// The guard statements the server arms. Recognised by SQL shape so the fake can
// evaluate the predicate the way SQLite would, rather than assuming it passed.
//
// EXTENSION NOTE (audit 2 batch A). Until now this fake recorded statements and
// returned success unconditionally, so it could not express a race at all: every
// batch "succeeded" whatever the store contained. Two things were added, both
// minimal and both load-bearing for the tests below. First, batch() now
// EVALUATES the three guard shapes against current state and throws the real NOT
// NULL violation when one fires, which is what D1 does. Second, mutable live
// state plus a raceBeforeCommit hook, so a test can put a competing write in the
// exact window the predicate exists to close. Without both, a predicate test
// would be asserting against a store that cannot disagree with it, which is the
// vacuous-guard shape this repo has been bitten by four times.
const GUARD_ERROR = "NOT NULL constraint failed: document_versions.document_id";

function guardFires(sql: string, params: unknown[], live: LiveState): boolean {
  const flat = sql.replace(/\s+/g, " ");
  if (!/INSERT INTO document_versions \(document_id, namespace, path\) SELECT NULL/i.test(flat)) return false;
  if (/AND body IS \?3/i.test(flat)) return !(live.exists && live.body === params[2]); // requireBodyUnchanged
  if (/WHERE EXISTS/i.test(flat)) return live.exists; // requireMissing
  return !live.exists; // requireExists
}

function fakeDb(opts: FakeOptions = {}) {
  const {
    namespaceExists = true,
    body: priorBody = "prior body",
    updatedAt = "2020-01-01 00:00:00",
    exists = true,
    raceAfterPreRead,
  } = opts;
  const recorded: Recorded[] = [];
  const live: LiveState = { body: priorBody as string | null, exists, updatedAt };
  const doc = () => ({ id: 7, title: "Prior title", body: live.body, type: "note", status: "published", tags: "a,b", updated_at: live.updatedAt });

  let raced = false;
  const answer = (sql: string) => {
    if (/FROM namespaces/i.test(sql)) return namespaceExists ? { namespace: "capsid" } : null;
    if (/FROM document_versions WHERE id/i.test(sql)) {
      return { id: 42, document_id: 7, namespace: "capsid", path: "doc.md", title: "Old title", body: "old body", snapshot_at: "2026-08-01 00:00:00" };
    }
    if (/SELECT 1 AS ok FROM documents/i.test(sql)) return { ok: 1 };
    if (/FROM documents/i.test(sql)) {
      // The commit-time read of updated_at is NOT the pre-read, so it must see
      // whatever the racing writer left behind.
      const isPreRead = !/SELECT updated_at FROM documents/i.test(sql);
      const value = live.exists ? doc() : null;
      if (isPreRead && raceAfterPreRead && !raced) {
        raced = true;
        raceAfterPreRead(live);
      }
      return value;
    }
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
    live,
    db: {
      prepare: (sql: string) => stmt(sql),
      batch: async (statements: Array<{ sql: string; params: unknown[] }>) => {
        for (const s of statements) {
          // A guard that fires aborts the transaction, so nothing this batch
          // would have written is recorded. That is the property under test.
          if (guardFires(s.sql, s.params, live)) throw new Error(GUARD_ERROR);
          recorded.push({ sql: s.sql, params: s.params, via: "batch" });
        }
        return statements.map(() => ({ results: [], meta: { changes: 1 } }));
      },
    },
  };
}

async function connect(operator: boolean, opts: FakeOptions = {}) {
  const { recorded, db, live } = fakeDb(opts);
  const server = buildServer({ DB: db } as never, operator, "test:guard");
  const client = new Client({ name: "invariant-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, recorded, live, close: () => client.close() };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

const shaOf = async (s: string) => (await import("node:crypto")).createHash("sha256").update(s).digest("hex");

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
  // restore was excluded here until 2026-08-17 (audit 2, F31). It checks the
  // namespace like every other mutator, so the exclusion was hiding nothing and
  // the loop is now whole.
  for (const { tool, args } of MUTATORS) {
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

// PHASE 0, 2026-08-14: the overwrite warning. Motivating incident is
// dustinedwards/core.md, where one session's 2,253-byte consolidation was replaced by
// another session 44 minutes later from a stale read, with a clean response either
// side and the loss found days after the fact (snapshot document_versions 1142).

const recently = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");

async function writeAndRead(opts: Record<string, unknown>, args: Record<string, unknown> = {}) {
  const { client, close } = await connect(true, opts);
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true, ...args },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await close();
  return JSON.parse(result.content[0].text) as { concurrency_warning?: string };
}

test("overwriting a document touched in the last hour WARNS", async () => {
  const out = await writeAndRead({ updatedAt: recently(10) });
  assert.ok(out.concurrency_warning, "no warning on a document written 10 minutes ago");
  assert.match(out.concurrency_warning, /possible concurrent edit/);
  assert.match(out.concurrency_warning, /pass if_match/i);
  // The warning names WHEN, because "recently" is not actionable and a timestamp is.
  assert.match(out.concurrency_warning, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test("overwriting an older document does NOT warn", async () => {
  // The other side. Without this the warning could fire on every write and the test
  // above would still pass, which is a warning nobody reads within a week.
  assert.equal((await writeAndRead({ updatedAt: recently(61) })).concurrency_warning, undefined);
  assert.equal((await writeAndRead({ updatedAt: "2020-01-01 00:00:00" })).concurrency_warning, undefined);
});

test("a guarded write never warns, however recent", async () => {
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update("prior body").digest("hex");
  const out = await writeAndRead({ updatedAt: recently(1) }, { if_match: sha });
  assert.equal(out.concurrency_warning, undefined, "if_match already guards this write; warning is noise");
});

test("the warning NEVER refuses the write", async () => {
  const { client, recorded, close } = await connect(true, { updatedAt: recently(5) });
  const result = (await client.callTool({
    name: "write",
    arguments: { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true },
  })) as { isError?: boolean };
  await close();
  assert.ok(!result.isError, "the warning turned into a refusal");
  assert.match(sqlFor(recorded), /INSERT INTO documents/, "the write did not land");
});

test("a UTC timestamp is not read as local time", async () => {
  // D1 stores datetime('now') in UTC with no zone marker. Parsing it as local time
  // would silence the warning west of UTC and fire it constantly east of it, and the
  // bug would be invisible on a machine sitting on UTC.
  const { concurrentEditWarning } = await import("../src/server.ts");
  const now = Date.parse("2026-08-14T12:00:00Z");
  assert.ok(concurrentEditWarning("2026-08-14 11:30:00", now), "30 minutes ago should warn");
  assert.equal(concurrentEditWarning("2026-08-14 10:00:00", now), null, "2 hours ago should not");
  // A future timestamp is not a concurrent edit, it is a clock problem.
  assert.equal(concurrentEditWarning("2026-08-14 13:00:00", now), null);
  assert.equal(concurrentEditWarning(null, now), null);
});

// AUDIT 2 BATCH A, 2026-08-17: the write predicate.
//
// Every test below turns on a store that CHANGES between the handler's pre-read
// and its commit. Before this batch the fake could not express that at all, so
// none of these could have failed for the right reason.

test("PREDICATE: a body that changes after the pre-read is refused at commit, not accepted", async () => {
  // The pre-check passes (the sha is correct when the handler reads it) and the
  // refusal therefore comes from the in-batch guard. That is the distinction:
  // this is the window the old pre-read left open.
  const sha = await shaOf("prior body");
  const { client, recorded, close } = await connect(true, {
    body: "prior body",
    raceAfterPreRead: (live) => {
      live.body = "body written by someone else";
    },
  });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true, if_match: sha,
  });
  await close();
  assert.equal(result.isError, true, "the racing write was overwritten instead of refused");
  assert.match(result.content[0].text, /stored body changed after this write read it/);
  assert.match(result.content[0].text, /Current sha256 is [0-9a-f]{64}/);
  // The sha reported is the RACER's body, which is what the caller must rebase
  // onto. Reporting the sha it already knew would be useless.
  assert.match(result.content[0].text, new RegExp(await shaOf("body written by someone else")));
  // Fail closed: the aborted batch left nothing behind.
  assert.deepEqual(recorded, [], "a refused predicate still committed statements");
});

test("PREDICATE: an overwrite with no confirm is refused before any commit", async () => {
  // The pre-elicitation arm. The in-memory client advertises no elicitation
  // capability, so the handler refuses rather than waiting. The post-elicitation
  // arm is the guard itself, which the test above proves, and both arm the same
  // statement.
  const { client, recorded, close } = await connect(true, { body: "prior body" });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body",
  });
  await close();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /confirmation required/);
  assert.deepEqual(recorded, [], "the confirmation path wrote before it was confirmed");
});

test("PREDICATE: an unguarded update still lands, so the guard is not a blanket refusal", async () => {
  // The other side. Without this, a predicate that refused everything would pass
  // every test above and break every legitimate write.
  const { client, recorded, close } = await connect(true, { body: "prior body" });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true,
  });
  await close();
  assert.ok(!result.isError, `an ordinary write was refused: ${result.content?.[0]?.text}`);
  assert.match(sqlFor(recorded), /INSERT INTO documents/);
});

test("CREATE COLLISION: exactly one of two racing creates wins, and the loser is refused", async () => {
  // Both writers pre-read nothing, so both take the create path. The first
  // commits. The second must NOT fall into ON CONFLICT DO UPDATE, because its
  // statement list carries no snapshot (there was nothing to snapshot when it
  // looked), so the winner's body would be gone with no version row anywhere.
  const { client, recorded, close } = await connect(true, {
    exists: false,
    raceAfterPreRead: (live) => {
      live.exists = true;
      live.body = "the winner body";
    },
  });
  const result = await call(client, "write", {
    namespace: "capsid", path: "new-doc.md", title: "Loser", body: "the loser body",
  });
  await close();
  assert.equal(result.isError, true, "the second create silently overwrote the first");
  assert.match(result.content[0].text, /create collision/);
  assert.match(result.content[0].text, /another writer created it first/);
  assert.deepEqual(recorded, [], "the losing create still wrote statements");
});

test("CREATE COLLISION: an uncontested create still succeeds", async () => {
  const { client, recorded, close } = await connect(true, { exists: false });
  const result = await call(client, "write", {
    namespace: "capsid", path: "new-doc.md", title: "T", body: "b",
  });
  await close();
  assert.ok(!result.isError, `an uncontested create was refused: ${result.content?.[0]?.text}`);
  const out = JSON.parse(result.content[0].text) as { action: string; snapshotted: boolean };
  assert.equal(out.action, "created");
  assert.equal(out.snapshotted, false);
  assert.match(sqlFor(recorded), /INSERT INTO documents/);
});

test("restore accepts if_match and refuses a stale one", async () => {
  const stale = await connect(true, { body: "prior body" });
  const staleRes = await call(stale.client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 42, confirm: true, if_match: "0".repeat(64),
  });
  await stale.close();
  assert.equal(staleRes.isError, true, "restore accepted a stale if_match");
  assert.match(staleRes.content[0].text, /if_match mismatch/);
  assert.match(staleRes.content[0].text, /Current sha256 is [0-9a-f]{64}/);
  assert.deepEqual(stale.recorded, [], "a refused restore still wrote statements");

  const good = await connect(true, { body: "prior body" });
  const okRes = await call(good.client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 42, confirm: true, if_match: await shaOf("prior body"),
  });
  await good.close();
  assert.ok(!okRes.isError, `restore refused a correct if_match: ${okRes.content?.[0]?.text}`);
  assert.match(sqlFor(good.recorded), /INSERT INTO document_versions \(document_id, namespace, path, title, body\)/);
});

test("restore refuses at the PREDICATE when the live body changes after its pre-read", async () => {
  const { client, recorded, close } = await connect(true, {
    body: "prior body",
    raceAfterPreRead: (live) => {
      live.body = "changed under the restore";
    },
  });
  const result = await call(client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 42, confirm: true, if_match: await shaOf("prior body"),
  });
  await close();
  assert.equal(result.isError, true, "restore committed over a body that changed beneath it");
  assert.match(result.content[0].text, /live body changed after this restore read it/);
  assert.deepEqual(recorded, [], "a refused restore still committed statements");
});

test("restore recreating a deleted document refuses a racing create", async () => {
  const { client, recorded, close } = await connect(true, {
    exists: false,
    raceAfterPreRead: (live) => {
      live.exists = true;
      live.body = "recreated by someone else";
    },
  });
  const result = await call(client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 42, confirm: true,
  });
  await close();
  assert.equal(result.isError, true, "restore overwrote a document created during its flight");
  assert.match(result.content[0].text, /create collision/);
  assert.deepEqual(recorded, [], "the losing restore still wrote statements");
});

test("the concurrency warning is read at COMMIT time, not from the pre-read", async () => {
  // The pre-read sees a timestamp two years old, so the OLD code, which computed
  // the warning from that row, could not warn no matter what happened next. A
  // writer then lands during this handler's flight and the commit-time read sees
  // it. This test fails against the pre-change code, which is what makes it
  // evidence rather than decoration.
  const fresh = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const { client, close } = await connect(true, {
    updatedAt: "2020-01-01 00:00:00",
    raceAfterPreRead: (live) => {
      live.updatedAt = fresh;
    },
  });
  const result = await call(client, "write", {
    namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true,
  });
  await close();
  const out = JSON.parse(result.content[0].text) as { concurrency_warning?: string };
  assert.ok(out.concurrency_warning, "the warning was computed from the stale pre-read, not from a fresh read at commit");
  assert.match(out.concurrency_warning, /possible concurrent edit/);
  assert.match(out.concurrency_warning, new RegExp(fresh));
});
