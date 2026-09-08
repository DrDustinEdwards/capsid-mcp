import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import {
  buildTruthReport,
  integrityOf,
  INTEGRITY_LINE,
  renderTruthReport,
  reportPath,
  STALE_DECISION_DAYS,
  type ReportDoc,
  type ReportEdge,
} from "../src/truth-report.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// THE TRUTH REPORT.
//
// capsid/conventions.md states the mechanism this exists for: "CAPSID CANNOT BE
// GATED. Every gate in every repo verifies DISK. So a number that lives only here
// can be wrong forever and nothing notices." A report that is only ever a tool
// response is the same problem one level up, so the mode writes a document and
// the trend is the artifact.
//
// Two halves, and they fail differently. The pure function is tested here against
// hand-built inputs, because that is where every judgement lives; the handler is
// driven over a real MCP connection, because that is where the write path lives.

const NOW = new Date("2026-09-07T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().replace("T", " ").slice(0, 19);

const doc = (over: Partial<ReportDoc> & { path: string }): ReportDoc => ({
  type: "note",
  status: "published",
  title: "t",
  body: "",
  updated_at: daysAgo(1),
  ...over,
});

const base = {
  namespace: "capsid",
  now: NOW,
  docs: [] as ReportDoc[],
  edges: [] as ReportEdge[],
  danglingEdges: [] as ReportEdge[],
  countClaims: [] as never[],
};

// ---- integrity is a ratio, and an unrun check is excluded ------------------

test("integrity is null when nothing was checkable, not 100 percent", () => {
  const report = buildTruthReport({ ...base });
  // No documents, no edges, no claims: every check has zero subjects, so there is
  // nothing to be in good standing. Reporting 100 here would be the worst
  // possible answer, because an empty store would score perfectly.
  assert.equal(report.integrity, null);
});

test("PLANT: a check that could not run is EXCLUDED from integrity, never counted as clean", () => {
  const docs = [doc({ path: "core.md", type: "core", body: "see src/gone.ts" })];
  // repoPaths absent: the tree could not be read.
  const unrun = buildTruthReport({ ...base, docs });
  const drift = unrun.checks.find((c) => c.check === "doc_vs_code_drift")!;
  assert.equal(drift.subjects, 0, "an unrun check contributes no subjects");
  assert.match(drift.findings[0].detail, /NOT RUN/, "and it says so, rather than reporting zero findings");

  // The same store with a readable tree that does NOT contain the path: now the
  // check runs and the finding is real.
  const ran = buildTruthReport({ ...base, docs, repoPaths: new Set(["src/server.ts"]) });
  const ranDrift = ran.checks.find((c) => c.check === "doc_vs_code_drift")!;
  assert.equal(ranDrift.subjects, 1);
  assert.equal(ranDrift.ok, 0);
  assert.match(ranDrift.findings[0].subject, /src\/gone\.ts/);
  assert.ok(
    ran.integrity! < 100,
    "a real drift finding must move the number; if it does not, the check is decorative"
  );
});

test("a Capsid document path is not a repo path", () => {
  // Every canon document cites `capsid/conventions.md` and friends. Reporting the
  // whole canon as drift is how this check gets switched off.
  const docs = [doc({ path: "core.md", body: "see capsid/conventions.md and germomics/core.md and src/server.ts" })];
  const report = buildTruthReport({ ...base, docs, repoPaths: new Set(["src/server.ts"]) });
  const drift = report.checks.find((c) => c.check === "doc_vs_code_drift")!;
  assert.equal(drift.subjects, 1, "only the real repo path is a subject");
  assert.deepEqual(drift.findings, []);
});

// ---- the individual checks --------------------------------------------------

test("a decision older than the threshold is stale, and one inside it is not", () => {
  const docs = [
    doc({ path: "decisions.md", type: "decision", updated_at: daysAgo(STALE_DECISION_DAYS + 1) }),
    doc({ path: "recent.md", type: "decision", updated_at: daysAgo(1) }),
    doc({ path: "superseded.md", type: "decision", status: "superseded", updated_at: daysAgo(400) }),
  ];
  const report = buildTruthReport({ ...base, docs });
  const check = report.checks.find((c) => c.check === "stale_decisions")!;
  assert.equal(check.subjects, 2, "a superseded decision is not held to the freshness rule");
  assert.equal(check.ok, 1);
  assert.equal(check.findings.length, 1);
  assert.match(check.findings[0].subject, /decisions\.md/);
});

test("a spec with an edge in EITHER direction is bound", () => {
  const docs = [
    doc({ path: "spec-a.md", type: "spec" }),
    doc({ path: "spec-b.md", type: "spec" }),
    doc({ path: "spec-c.md", type: "spec" }),
  ];
  const edges: ReportEdge[] = [
    { from_ns: "capsid", from_path: "spec-a.md", type: "governs", to_ns: "capsid", to_path: "core.md" },
    { from_ns: "capsid", from_path: "core.md", type: "references", to_ns: "capsid", to_path: "spec-b.md" },
  ];
  const report = buildTruthReport({ ...base, docs, edges });
  const check = report.checks.find((c) => c.check === "unbound_specs")!;
  assert.equal(check.subjects, 3);
  assert.equal(check.ok, 2);
  assert.equal(check.findings.length, 1);
  assert.match(check.findings[0].subject, /spec-c\.md/);
});

test("archived documents are counted but held to nothing", () => {
  const docs = [
    doc({ path: "archive/old.md", type: "decision", updated_at: daysAgo(999) }),
    doc({ path: "archive/spec.md", type: "spec" }),
  ];
  const report = buildTruthReport({ ...base, docs });
  assert.equal(report.documents.total, 2);
  assert.equal(report.documents.archived, 2);
  assert.equal(report.checks.find((c) => c.check === "stale_decisions")!.subjects, 0);
  assert.equal(report.checks.find((c) => c.check === "unbound_specs")!.subjects, 0);
});

test("a broken link is counted against the whole edge population", () => {
  const edges: ReportEdge[] = [
    { from_ns: "capsid", from_path: "a.md", type: "references", to_ns: "capsid", to_path: "b.md" },
    { from_ns: "capsid", from_path: "a.md", type: "references", to_ns: "capsid", to_path: "gone.md" },
  ];
  const report = buildTruthReport({
    ...base,
    docs: [doc({ path: "a.md" }), doc({ path: "b.md" })],
    edges,
    danglingEdges: [{ ...edges[1], target_missing: 1 }],
  });
  const check = report.checks.find((c) => c.check === "broken_links")!;
  assert.equal(check.subjects, 2);
  assert.equal(check.ok, 1);
  assert.match(check.findings[0].detail, /target document no longer exists/);
});

// ---- the stored document ----------------------------------------------------

test("PLANT: the integrity number survives a render and a read-back", () => {
  // improve_status parses this line out of the stored body. A number a program has
  // to find in prose is a number that will one day be in different prose, so the
  // line has a fixed shape and both directions are asserted.
  const report = buildTruthReport({
    ...base,
    docs: [doc({ path: "core.md", type: "core" }), doc({ path: "spec.md", type: "spec" })],
  });
  const body = renderTruthReport(report);
  assert.match(body, INTEGRITY_LINE);
  assert.equal(integrityOf(body), report.integrity);
  assert.equal(integrityOf("no integrity line here"), null);
  assert.equal(integrityOf(null), null, "a missing body reads as no report, never as zero");
});

test("the report path is one document per namespace per day, and sorts by date", () => {
  assert.equal(reportPath(new Date("2026-09-07T23:59:00Z")), "reports/lint-2026-09-07.md");
  // Lexical sort equals chronological sort, which is what improve_status relies on
  // when it takes ORDER BY path DESC LIMIT 1.
  const dates = ["2026-01-05", "2026-09-07", "2026-10-01", "2027-01-01"].map((d) => reportPath(new Date(`${d}T00:00:00Z`)));
  assert.deepEqual([...dates].sort(), dates);
});

// ---- the handler ------------------------------------------------------------

async function connect(grant: "read" | "write") {
  const rows = {
    documents: [
      { id: 1, namespace: "capsid", path: "core.md", title: "core", body: "Capsid has 30 tools.", type: "core", status: "published", tags: null, updated_at: daysAgo(1) },
      { id: 2, namespace: "capsid", path: "spec.md", title: "spec", body: "a spec nothing points at", type: "spec", status: "published", tags: null, updated_at: daysAgo(1) },
    ],
    namespaces: [{ namespace: "capsid", repos: "[]" }],
  };
  const { db, batches, recorded } = fakeD1(rows);
  const server = buildServer(fakeEnv({ DB: db, APP_KV: fakeKv({}).kv }), grant, "test:report");
  const client = new Client({ name: "report-test", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, batches, recorded, close: () => client.close() };
}

const call = async (client: Client, args: Record<string, unknown>) =>
  (await client.callTool({ name: "lint", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

test("PLANT: report mode is write-gated, like finalize", async () => {
  const { client, close } = await connect("read");
  try {
    const result = await call(client, { namespace: "capsid", mode: "report" });
    assert.equal(result.isError, true, "a read-only key must not be able to write a report document");
  } finally {
    await close();
  }
});

test("report mode STORES the report, so the trend is a document", async () => {
  const { client, batches, recorded, close } = await connect("write");
  try {
    const result = await call(client, { namespace: "capsid", mode: "report" });
    assert.ok(!result.isError, result.content.map((c) => c.text).join(""));
    const payload = JSON.parse(result.content.map((c) => c.text).join("")) as {
      mode: string;
      stored: string;
      integrity: number | null;
      checks: Array<{ check: string }>;
    };
    assert.equal(payload.mode, "report");
    assert.match(payload.stored, /^capsid\/reports\/lint-\d{4}-\d{2}-\d{2}\.md$/);
    assert.deepEqual(
      payload.checks.map((c) => c.check).sort(),
      ["broken_links", "contradictions", "doc_vs_code_drift", "stale_decisions", "unbound_specs", "unconsolidated"]
    );

    // THE WRITE PATH, from the statements the handler issued. The fake records
    // SQL rather than applying it, which is what every other write test in this
    // repo asserts against; that the document really LANDS in a database is the
    // integration layer's half (test-integration/truth-report.test.ts), and the
    // two halves fail differently on purpose.
    const flat = batches.flat().map((s) => s.replace(/\s+/g, " "));
    assert.ok(
      flat.some((s) => /INSERT INTO documents \(namespace, path, title, body, type, tags, status\)/.test(s)),
      "the report must go through the same upsert the write tool issues"
    );
    assert.ok(
      flat.some((s) => /INSERT INTO audit_log .* 'lint_report'/.test(s)),
      "hard rule 5: no write path skips the audit log, and a report is not an exception"
    );

    // The body it wrote is the rendered report, and the number in it is the number
    // it returned. Taken from the bound params rather than from the store, for the
    // reason above.
    const upsert = recorded.find((r) => /INSERT INTO documents \(namespace, path, title, body/.test(r.sql));
    assert.ok(upsert, "no document upsert was issued at all");
    const [ns, storedPath, , storedBody, storedType] = upsert!.params as [string, string, string, string, string];
    assert.equal(ns, "capsid");
    assert.equal(`${ns}/${storedPath}`, payload.stored);
    assert.equal(storedType, "reference");
    assert.equal(integrityOf(storedBody), payload.integrity, "the stored body carries the number the response reported");
  } finally {
    await close();
  }
});

test("gather and finalize are untouched by the new mode", async () => {
  const { client, close } = await connect("write");
  try {
    const gather = await call(client, { namespace: "capsid" });
    assert.ok(!gather.isError);
    const payload = JSON.parse(gather.content.map((c) => c.text).join("")) as { mode: string };
    assert.equal(payload.mode, "gather", "the default mode did not move");

    const finalize = await call(client, { namespace: "capsid", mode: "finalize", confirm: true });
    assert.equal(finalize.isError, true);
    assert.match(finalize.content.map((c) => c.text).join(""), /finalize requires consumed/);
  } finally {
    await close();
  }
});
