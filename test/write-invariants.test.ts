import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { fakeD1, fakeEnv, type FakeD1Rows, type Recorded } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";

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

// The store is the SHARED row-backed fake from ./fakes.ts (quality audit 6.1 and
// 6.2). It replaces a local D1 dialect that answered on SQL shape alone: `WHERE id
// = ?1` returned version 42 whatever id was asked for, and `SELECT 1 AS ok FROM
// documents` answered ok for a row that did not exist. Every lookup assertion was
// therefore really asserting that the handler had issued SOME statement. The rows
// are real now and the WHERE clauses resolve against the bound values, so asking
// for the wrong path or the wrong version id gets nothing back.

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
  failBatchMatching?: RegExp;
}

// The race hook's view of the store. It is a thin projection over the rows so the
// existing call sites keep reading as "another writer changed the body", while the
// rows underneath are what the guards actually evaluate against.
interface LiveState {
  body: string | null;
  exists: boolean;
  updatedAt: string;
}

const DOC = { namespace: "capsid", path: "doc.md" };
const VERSION_ID = 42;

function connectOptions(opts: FakeOptions) {
  const { namespaceExists = true, body = "prior body", updatedAt = "2020-01-01 00:00:00", exists = true } = opts;
  const documents = exists
    ? [
        { id: 7, ...DOC, title: "Prior title", body, type: "note", status: "published", tags: "a,b", updated_at: updatedAt },
        // lint finalize only archives episodic and source docs, so the fixture
        // carries one for it to consume (quality audit 6.3).
        { id: 8, namespace: "capsid", path: "ep.md", title: "An episodic", body: "ep body", type: "episodic", status: "published", tags: null, updated_at: updatedAt },
      ]
    : [];
  return {
    documents,
    versions: [
      { id: VERSION_ID, document_id: 7, ...DOC, title: "Old title", body: "old body", snapshot_at: "2026-08-01 00:00:00" },
    ],
    namespaces: namespaceExists ? [{ namespace: "capsid", repos: "[]" }] : [],
    failBatchMatching: opts.failBatchMatching,
    raceAfterPreRead: opts.raceAfterPreRead
      ? (rows: FakeD1Rows, target: { namespace: string; path: string }) => {
          const at = () => rows.documents.find((d) => d.namespace === target.namespace && d.path === target.path);
          const live: LiveState = {
            get body() {
              return at()?.body ?? null;
            },
            set body(value: string | null) {
              const row = at();
              if (row) row.body = value;
              else rows.documents.push({ id: 7, ...target, title: "Racing title", body: value, updated_at: updatedAt });
            },
            get updatedAt() {
              return at()?.updated_at ?? updatedAt;
            },
            set updatedAt(value: string) {
              const row = at();
              if (row) row.updated_at = value;
            },
            get exists() {
              return Boolean(at());
            },
            set exists(value: boolean) {
              if (value && !at()) {
                rows.documents.push({ id: 7, ...target, title: "Racing title", body: null, updated_at: updatedAt });
              } else if (!value) {
                const i = rows.documents.findIndex((d) => d.namespace === target.namespace && d.path === target.path);
                if (i !== -1) rows.documents.splice(i, 1);
              }
            },
          };
          opts.raceAfterPreRead!(live);
        }
      : undefined,
  };
}

async function connect(operator: boolean, opts: FakeOptions = {}) {
  const { rows, recorded, batches, db } = fakeD1(connectOptions(opts));
  const server = buildServer(fakeEnv({ DB: db }), operator, "test:guard");
  const client = new Client({ name: "invariant-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, recorded, rows, batches, close: () => client.close() };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

const shaOf = async (s: string) => (await import("node:crypto")).createHash("sha256").update(s).digest("hex");

const sqlFor = (recorded: Recorded[]) => recorded.map((r) => r.sql.replace(/\s+/g, " ")).join("\n");

// The four tools that overwrite, remove or rename a document, and what each one must
// issue. Adding a mutating tool without adding it here is the gap the source guard in
// invariants.test.ts covers from the other side.
const MUTATORS: Array<{ tool: string; args: Record<string, unknown>; requires: RegExp[]; refusesUnregisteredWith?: RegExp }> = [
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
    // move gained a confirmation on 2026-08-17 (audit 2, F25): it is
    // destructive-class and had none.
    args: { namespace: "capsid", path: "doc.md", new_path: "moved.md", confirm: true },
    // A rename has no body to snapshot; the audit row is the record.
    requires: [/INSERT INTO audit_log/],
  },
  {
    // lint finalize is the WIDEST mutation in the file: one call renames every
    // consumed document. It was never driven behaviourally, only source-scanned
    // (quality audit 6.3), which for the widest mutation is the wrong way round.
    tool: "lint",
    args: { namespace: "capsid", mode: "finalize", consumed: ["ep.md"], confirm: true },
    // Archiving is a rename, so there is no body to snapshot; the audit row is
    // the record, exactly as for move.
    requires: [/INSERT INTO audit_log/],
    // finalize refuses an unregistered namespace by a DIFFERENT route from the
    // other four: it does not call requireRegisteredNamespace, it fails its own
    // per-path existence check, because a document in an unregistered namespace
    // cannot be found to archive. Same refusal, same "nothing written", different
    // message. Asserted as it actually behaves rather than as the others do.
    refusesUnregisteredWith: /not found/,
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
  for (const { tool, args, refusesUnregisteredWith } of MUTATORS) {
    const { client, recorded, close } = await connect(true, { namespaceExists: false });
    const result = (await client.callTool({
      name: tool,
      arguments: { ...args, namespace: "typoed-ns" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    await close();
    assert.equal(result.isError, true, `${tool} accepted an unregistered namespace`);
    assert.match(result.content[0].text, refusesUnregisteredWith ?? /unknown namespace/);
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

// ARMING PARITY: write and restore choose the same guard under the same
// conditions, and it leads the batch.
//
// This test could not have been written before 2026-08-17. The protocol was
// shipped twice, and the two copies spelled the consent condition differently:
// write kept its own `elicited` flag, restore re-derived it as `confirm !== true`.
// Those denoted the same thing, but only by inference from how requireConfirmation
// returns, so a change to that helper could have armed one path and not the other
// with nothing to catch it. There was no shared unit to point a test at, and
// asserting the two separately would have asserted the drift rather than the rule.
//
// Guard classification is by SQL, not by a flag the source exports, so this fails
// against a handler that sets the right flag and pushes the wrong statement.
const guardOf = (batches: string[][]): "missing" | "body" | "none" => {
  const first = batches[0]?.[0] ?? "";
  if (/WHERE NOT EXISTS .*body IS \?3/.test(first)) return "body";
  if (/SELECT NULL, \?1, \?2 WHERE EXISTS/.test(first)) return "missing";
  return "none";
};

const ARMING_CASES = [
  // A create guards on the row still being ABSENT.
  { name: "create", opts: { exists: false }, withIfMatch: false, expected: "missing" as const },
  // An update the caller asked to be checked guards on the body.
  { name: "update with if_match", opts: { body: "prior body" }, withIfMatch: true, expected: "body" as const },
  // An unguarded update keeps last-writer-wins, deliberately.
  { name: "plain update", opts: { body: "prior body" }, withIfMatch: false, expected: "none" as const },
];

for (const { name, opts, withIfMatch, expected } of ARMING_CASES) {
  test(`ARMING PARITY: write and restore both arm the ${expected} guard, first, on a ${name}`, async () => {
    const if_match = withIfMatch ? await shaOf("prior body") : undefined;

    const w = await connect(true, opts);
    const wRes = await call(w.client, "write", {
      namespace: "capsid", path: "doc.md", title: "T", body: "b", confirm: true, ...(if_match ? { if_match } : {}),
    });
    await w.close();

    const r = await connect(true, opts);
    const rRes = await call(r.client, "restore", {
      namespace: "capsid", path: "doc.md", version_id: VERSION_ID, confirm: true, ...(if_match ? { if_match } : {}),
    });
    await r.close();

    // Both landed, so the guards below are the ones a SUCCEEDING commit arms.
    assert.ok(!wRes.isError, `write was refused: ${wRes.content?.[0]?.text}`);
    assert.ok(!rRes.isError, `restore was refused: ${rRes.content?.[0]?.text}`);

    assert.equal(guardOf(w.batches), expected, "write armed the wrong guard");
    assert.equal(guardOf(r.batches), expected, "restore armed the wrong guard");
    assert.equal(guardOf(w.batches), guardOf(r.batches), "write and restore have drifted apart again");

    // ARMED FIRST. The abort must happen before any other statement is attempted,
    // and the fake's batch log is the only place that order is visible: `recorded`
    // is written only after every statement has passed, so it cannot show it.
    if (expected !== "none") {
      assert.equal(w.batches.length, 1);
      assert.match(w.batches[0][0], /INSERT INTO document_versions \(document_id, namespace, path\) SELECT NULL/);
      assert.match(r.batches[0][0], /INSERT INTO document_versions \(document_id, namespace, path\) SELECT NULL/);
    }
  });
}

test("ARMING PARITY: both call sites pass the SAME consent signal", async () => {
  // The behavioural cases above cannot reach the elicited arm: the in-memory
  // client advertises no elicitation capability, so a call without confirm is
  // refused before any guard is chosen. The signal itself is therefore pinned at
  // the source, where the drift would appear: one shared expression inside the
  // protocol helper, and both call sites handing it the same variable.
  const server = sourceFile("server.ts");
  assert.equal(
    server.split("commit.run(elicited, statements)").length - 1,
    2,
    "a call site stopped passing the shared elicited signal to the commit protocol"
  );
  // And the condition that consumes it is stated once, inside the helper.
  assert.equal(
    server.split("if_match !== undefined || elicited").length - 1,
    1,
    "the arming condition is written more than once again"
  );
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

// WHAT RESTORE BINDS, not just which statements it issues (quality audit 6.5).
//
// The MUTATORS loop above asserts that restore issues an INSERT INTO
// document_versions and an INSERT INTO audit_log. Both would still be issued by a
// restore that wrote the LIVE body back over itself: same statements, same order,
// same count, and the tool would answer "restored" having restored nothing. The
// only thing that distinguishes a working restore from that one is the value bound
// to the upsert.
//
// The fake makes the two bodies distinguishable on purpose: the version row carries
// "old body" and the live document carries "prior body". A restore must read the
// first and write it, while snapshotting the second.
test("restore writes the VERSION body, and snapshots the LIVE one", async () => {
  const { client, recorded, close } = await connect(true);
  const result = (await client.callTool({
    name: "restore",
    arguments: { namespace: "capsid", path: "doc.md", version_id: 42, confirm: true },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await close();
  assert.ok(!result.isError, `restore failed: ${result.content?.[0]?.text}`);

  const upsert = recorded.find((r) => /INSERT INTO documents [(]/i.test(r.sql));
  assert.ok(upsert, "restore issued no upsert into documents");
  assert.ok(
    upsert.params.includes("old body"),
    `restore did not write the version body. It bound: ${JSON.stringify(upsert.params)}`
  );
  assert.equal(
    upsert.params.includes("prior body"),
    false,
    `restore wrote the LIVE body back instead of the version body. It bound: ${JSON.stringify(upsert.params)}`
  );
  // The title travels with the body: a restore that put back old bytes under the
  // current title is half a restore.
  assert.ok(upsert.params.includes("Old title"), `restore did not write the version title: ${JSON.stringify(upsert.params)}`);

  // And the snapshot is the mirror image: it must capture what is being replaced,
  // or the restore is not itself undoable, which is the property its description
  // promises.
  const snapshot = recorded.find((r) => /INSERT INTO document_versions [(]/i.test(r.sql) && !/SELECT NULL/i.test(r.sql));
  assert.ok(snapshot, "restore issued no snapshot of the live body");
  assert.ok(
    snapshot.params.includes("prior body"),
    `restore snapshotted the wrong body: ${JSON.stringify(snapshot.params)}`
  );
});

// ---- history, driven rather than described (quality audit 6.3) --------------
//
// history was never behaviourally tested. Its scoping rule ("namespace and path
// are part of the lookup on purpose: an id alone would let a caller walk every
// snapshot in the store") was asserted by a comment in src/server.ts and by
// nothing else, and could not have been tested before, because the old fake
// returned the same version row for every id, namespace and path.

test("history lists the versions of the document asked for", async () => {
  const { client, close } = await connect(true);
  const result = await call(client, "history", { namespace: "capsid", path: "doc.md" });
  await close();
  assert.ok(!result.isError, `history failed: ${result.content?.[0]?.text}`);
  const out = JSON.parse(result.content[0].text) as { versions: Array<{ id: number }>; live: unknown };
  assert.deepEqual(out.versions.map((v) => v.id), [42], "history did not return the document's own snapshot");
  assert.ok(out.live, "history did not report the live document");
});

test("history returns nothing for a path with no snapshots", async () => {
  const { client, close } = await connect(true);
  const result = await call(client, "history", { namespace: "capsid", path: "ep.md" });
  await close();
  const out = JSON.parse(result.content[0].text) as { versions: unknown[] };
  assert.deepEqual(out.versions, [], "a document's history leaked another document's snapshots");
});

test("fetching a version by id is scoped to its own document", async () => {
  // The same id, asked for under a path it does not belong to. Under the old fake
  // this returned the body anyway, which is the walk-the-store shape the scoping
  // exists to prevent.
  const { client, close } = await connect(true);
  const wrongPath = await call(client, "history", { namespace: "capsid", path: "ep.md", version_id: 42 });
  await close();
  assert.equal(wrongPath.isError, true, "a snapshot was readable through a document it does not belong to");
  assert.match(wrongPath.content[0].text, /no version 42/);
});

test("fetching a version by id returns that version's body", async () => {
  const { client, close } = await connect(true);
  const result = await call(client, "history", { namespace: "capsid", path: "doc.md", version_id: 42 });
  await close();
  assert.ok(!result.isError, `history by id failed: ${result.content?.[0]?.text}`);
  const out = JSON.parse(result.content[0].text) as { id: number; body: string; bytes: number };
  assert.equal(out.id, 42);
  assert.equal(out.body, "old body");
  assert.equal(out.bytes, "old body".length);
});

// ---- the fake can now DISAGREE (quality audit 6.1) ---------------------------
//
// Three tests that could not have failed before. The old fake answered on SQL
// shape alone: `FROM document_versions WHERE id` returned version 42 for any id,
// `FROM documents WHERE namespace = ?1 AND path = ?2` returned the one document
// for any path, and `SELECT 1 AS ok FROM documents` answered ok unconditionally.
// A handler that looked up the wrong row got the right answer anyway, so the
// lookup could not be tested at all: what looked like coverage was the fake
// agreeing with whatever it was asked.

test("a version id that does not exist is refused, not silently substituted", async () => {
  const { client, recorded, close } = await connect(true);
  const result = await call(client, "restore", {
    namespace: "capsid", path: "doc.md", version_id: 99, confirm: true,
  });
  await close();
  assert.equal(result.isError, true, "restore accepted a version id that does not exist");
  assert.match(result.content[0].text, /no version 99/);
  assert.deepEqual(recorded, [], "a restore of a missing version still wrote statements");
});

test("a version belonging to another document is not reachable by id", async () => {
  // namespace and path are part of the version lookup on purpose: an id alone
  // would let a caller walk every snapshot in the store by incrementing a number.
  // Under the old fake this passed for any id, path or namespace, so the property
  // was asserted by the tool's description and by nothing else.
  const { client, close } = await connect(true);
  const result = await call(client, "restore", {
    namespace: "capsid", path: "some-other-doc.md", version_id: 42, confirm: true,
  });
  await close();
  assert.equal(result.isError, true, "a snapshot was reachable from a document it does not belong to");
  assert.match(result.content[0].text, /no version 42/);
});

test("a document that does not exist is not found at a path that does", async () => {
  // delete reads the row before it does anything. The old fake returned the one
  // document for every path, so a delete of a path that has never existed reported
  // success and issued a snapshot of a body it invented.
  const { client, recorded, close } = await connect(true);
  const result = await call(client, "delete", {
    namespace: "capsid", path: "never-existed.md", confirm: true,
  });
  await close();
  assert.equal(result.isError, true, "delete accepted a path with no document");
  assert.match(result.content[0].text, /not found/);
  assert.deepEqual(recorded, [], "a delete of a missing document still wrote statements");
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

// ---- F30: a batch failure is a clean refusal, not an exception ---------------

// The fake's batch throws whatever this holds, so a test can produce a D1 failure
// that is NOT one of the commit-time guards. Before the fix, write and restore
// rethrew that, so the tool call rejected while delete, move and finalize all
// answered with a normal error result. Same failure, two shapes.
async function connectExploding(sql: RegExp) {
  // Failure injection is a capability of the shared fake now, rather than a
  // monkey-patch over a local one.
  const { db, recorded } = fakeD1(connectOptions({ failBatchMatching: sql }));
  const server = buildServer(fakeEnv({ DB: db }), true, "test:guard");
  const client = new Client({ name: "f30-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, recorded, close: () => client.close() };
}

const F30_CASES = [
  { tool: "write", args: { namespace: "capsid", path: "doc.md", title: "T", body: "b", confirm: true } },
  { tool: "restore", args: { namespace: "capsid", path: "doc.md", version_id: 42, confirm: true } },
  { tool: "delete", args: { namespace: "capsid", path: "doc.md", confirm: true } },
  { tool: "move", args: { namespace: "capsid", path: "doc.md", new_path: "moved.md", confirm: true } },
  { tool: "lint", args: { namespace: "capsid", mode: "finalize", consumed: ["ep.md"], confirm: true } },
];

for (const { tool, args } of F30_CASES) {
  test(`${tool} returns a clean failure when the batch throws`, async () => {
    const { client, close } = await connectExploding(/INSERT INTO document_versions|UPDATE documents|INSERT INTO documents|DELETE FROM documents/);
    let result: { isError?: boolean; content: Array<{ text: string }> };
    try {
      result = (await client.callTool({ name: tool, arguments: args })) as typeof result;
    } catch (err) {
      await close();
      assert.fail(`${tool} threw out of the handler instead of returning a failure: ${err instanceof Error ? err.message : String(err)}`);
    }
    await close();
    assert.equal(result.isError, true, `${tool} reported success on a failed batch`);
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /database is locked/, `${tool} lost the reason: ${text}`);
    assert.match(text, /nothing (was written|changed|archived)/i, `${tool} did not say the store is unchanged: ${text}`);
  });
}

// ---- F17: a landed GitHub write is not reported as a failure ----------------

test("write_repo_file reports success with a warning when the audit insert fails", async () => {
  // guardedWrite commits to GitHub and THEN writes its audit row, and the two
  // cannot share a transaction. When the row failed, the caller was told the tool
  // failed, and the natural response to that is a retry, which is a second commit.
  const { db } = fakeD1(connectOptions({}));
  (db as { prepare: unknown }).prepare = ((sql: string) => {
    const base = { bind: () => base, first: async () => null, all: async () => ({ results: [], meta: { changes: 0 } }), run: async () => ({ meta: { changes: 1 } }) } as Record<string, unknown>;
    if (/INSERT INTO audit_log/i.test(sql)) {
      base.run = async () => {
        throw new Error("D1_ERROR: no such table: audit_log");
      };
    }
    if (/FROM namespaces/i.test(sql)) base.first = async () => ({ repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) });
    return base;
  }) as never;

  const server = buildServer({ DB: db, APP_KV: { get: async (k: string) => (k.startsWith("gh:token:") ? "t" : null), put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) } } as never, true, "test:guard");
  const client = new Client({ name: "f17-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    if (path === "/repos/o/r" && method === "GET") return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    if (path === "/repos/o/r/contents/doc.md" && method === "GET") return new Response("{}", { status: 404 });
    if (path === "/repos/o/r/contents/doc.md" && method === "PUT") {
      return new Response(JSON.stringify({ commit: { sha: "landed-sha" }, content: { sha: "file-sha" } }), { status: 201 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = (await client.callTool({
      name: "write_repo_file",
      arguments: { namespace: "capsid", path: "doc.md", content: "hi", message: "m", mode: "direct" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(!result.isError, `the landed write was reported as a failure: ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text) as { commitSha?: string; audit_warning?: string };
    // The result still describes what landed, and says the log does not know.
    assert.equal(payload.commitSha, "landed-sha");
    assert.match(payload.audit_warning ?? "", /SUCCEEDED/);
    assert.match(payload.audit_warning ?? "", /no such table: audit_log/);
    assert.match(payload.audit_warning ?? "", /Do not retry/);
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
});
