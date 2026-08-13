import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AUTHORITATIVE, scanCountClaims } from "../src/counts.ts";

const CAPSID = AUTHORITATIVE.capsid;
import { securityHeadersFor } from "../src/headers.ts";

// Batch-two item 10. src/counts.ts caches numbers that live elsewhere, so these
// tests derive each one from the artifact itself and fail when the two drift.
// A constant nobody checks is exactly the stale prose this feature exists to
// catch, one level down.

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("tools count matches the registrations in server.ts", () => {
  const src = read("../src/server.ts");
  const registered = src.match(/server\.registerTool\(/g) ?? [];
  assert.equal(
    registered.length,
    CAPSID.tools,
    `server.ts registers ${registered.length} tools but counts.ts says ${CAPSID.tools}`
  );
});

test("live gate count matches the distinct gates in verify-live.mjs", () => {
  const src = read("../scripts/verify-live.mjs");
  // Gates 3 and 5 each call record() twice, once on the skipped path, so count
  // DISTINCT labels rather than call sites.
  const labels = new Set([...src.matchAll(/record\(\s*"([^"]+)"/g)].map((m) => m[1]));
  assert.equal(
    labels.size,
    CAPSID.liveGates,
    `verify-live.mjs has ${labels.size} distinct gates (${[...labels].join(", ")}) but counts.ts says ${CAPSID.liveGates}`
  );
});

test("header counts match what the header layer actually emits", () => {
  const html = securityHeadersFor("html");
  const enforced = Object.keys(html).filter((k) => !/-Report-Only$/i.test(k) && k !== "Reporting-Endpoints");
  const reportOnly = Object.keys(html).filter((k) => /-Report-Only$/i.test(k));
  // The consent dialog sets its own enforced CSP in github-handler.ts, so the
  // header layer emits five of the six and the CSP is the sixth.
  assert.equal(
    enforced.length + 1,
    CAPSID.htmlEnforcedHeaders,
    `header layer emits ${enforced.length} enforced (${enforced.join(", ")}) plus the consent CSP, but counts.ts says ${CAPSID.htmlEnforcedHeaders}`
  );
  assert.equal(reportOnly.length, CAPSID.htmlReportOnlyHeaders);
});

test("scan flags a stale tool count in a standing doc", () => {
  const claims = scanCountClaims([
    { path: "core.md", type: "core", body: "The server exposes 19 tools today." },
  ], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].noun, "tools");
  assert.equal(claims[0].states, "19");
  assert.equal(claims[0].authoritative, "24");
});

test("scan does NOT flag a correct count", () => {
  assert.deepEqual(scanCountClaims([{ path: "core.md", type: "core", body: "24 tools, split 13 read and 11 write." }], "capsid"), []);
});

test("episodics are exempt because their numbers are history, not claims", () => {
  // A session doc saying "6 of 6 gates passed" is an accurate record of a run.
  // Flagging it would bury the real findings in noise.
  const claims = scanCountClaims([
    { path: "session-2026-08-09.md", type: "episodic", body: "6 of 6 gates passed. The surface had 19 tools." },
  ], "capsid");
  assert.deepEqual(claims, []);
});

test("archived documents are exempt", () => {
  const claims = scanCountClaims([{ path: "archive/old-core.md", type: "core", body: "16 tools." }], "capsid");
  assert.deepEqual(claims, []);
});

test("the 'N of M gates' form is judged on the TOTAL, not the numerator", () => {
  // "6 of 8 gates" states the artifact has 8 gates, which is correct, and that 6
  // passed, which is a run result and none of this lint's business.
  assert.deepEqual(scanCountClaims([{ path: "core.md", type: "core", body: "6 of 9 gates passed" }], "capsid"), []);
  const stale = scanCountClaims([{ path: "core.md", type: "core", body: "6 of 6 gates passed" }], "capsid");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].states, "6");
  assert.equal(stale[0].authoritative, "9");
});

test("'all seven' is flagged when it is about headers", () => {
  const claims = scanCountClaims([
    { path: "security-headers.md", type: "concept", body: "Propose HTML gets all seven, JSON gets nosniff." },
  ], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].noun, "security headers");
  assert.match(claims[0].authoritative, /6 enforced plus 1 Report-Only/);
});

test("'all seven' about anything else is NOT flagged", () => {
  // Measured against the live corpus 2026-08-12: "all seven" appears in 25
  // documents and almost none are about headers. Seven ROWS files, seven
  // manifest fields, seven migrations, seven width probes. An unscoped match
  // flagged every one of them, which is a lint nobody would read twice.
  const decoys = [
    "PARITY-ROWS split seven ways. All seven written BEFORE the index cited them.",
    "buildNotificationSettingsUpdate exists with all seven fields and a passing unit test.",
    "All seven migrations were applied and the schema is reproduced.",
    "Zero pixel change on all seven, the classes moved unaltered.",
  ];
  for (const body of decoys) {
    assert.deepEqual(scanCountClaims([{ path: "parity/notes.md", type: "reference", body }], "capsid"), [], `false positive on: ${body}`);
  }
});

test("the scan never returns a rewritten body, only a flag", () => {
  // Flag, never auto-correct. If this object ever grows a "corrected" or
  // "replacement" field, that is a program editing canon on its own judgement.
  const claims = scanCountClaims([{ path: "core.md", type: "core", body: "19 tools" }], "capsid");
  for (const c of claims) {
    assert.deepEqual(
      Object.keys(c).sort().filter((k) => !["path", "type", "noun", "quote", "states", "authoritative", "note"].includes(k)),
      []
    );
  }
});

// The three false-positive classes measured portfolio-wide on 2026-08-14, when 16
// claims were flagged and 14 of them were wrong. Each is a regression test, because
// each was a lint that cried wolf, and a lint nobody reads is a lint that is off.

test("a namespace with no authoritative numbers gets NO claims", () => {
  // dustinedwards has its own 24-gate suite and its own tool counts. Comparing them
  // against capsid's 9 live gates and 24 tools produced 14 of the 16 false positives.
  const docs = [
    { path: "core.md", type: "core", body: "TWENTY-FOUR gates, MINIMUM_GATES 24. check:head covers 20 gates in extraction." },
    { path: "operator-mcp-wrapper.md", type: "concept", body: "The wrapper exposes 5 tools." },
  ];
  assert.deepEqual(scanCountClaims(docs, "dustinedwards"), []);
  assert.deepEqual(scanCountClaims(docs, "recova"), []);
  // The same prose IS capsid's business when it is capsid's document.
  assert.ok(scanCountClaims(docs, "capsid").length > 0, "capsid's own numbers must still be checked");
});

test("a decisions log is EXEMPT outright: it is history by construction", () => {
  // Ruled 2026-08-15. Three finer carve-outs each revealed another shape behind them,
  // so the family is retired: a ruling log states what was true on a date, never what
  // is true now, and the lint has no jurisdiction there.
  const log = {
    path: "decisions.md",
    type: "decision",
    body: [
      "2026-07-17: the surface went from 16 tools to 19 tools.",
      "2026-07-18: Expansion layer, tool surface 19 to 22.",
      "core.md said 19 tools when server.ts registers 22.",
      "The server exposes 11 tools.",
    ].join("\n\n"),
  };
  assert.deepEqual(scanCountClaims([log], "capsid"), [], "a decision doc produced claims");
});

test("every claim is checked in a document that is not an append-only log", () => {
  // The exemption is keyed on type `decision` and must not leak to core or concept
  // docs, which state current fact throughout.
  const doc = { path: "core.md", type: "core", body: "It had 19 tools then, and 19 tools now." };
  assert.equal(scanCountClaims([doc], "capsid").length, 2);
});

test("a four-digit year is never a tool count", () => {
  // `tool surface[^.\n]*?\b(\d+)\b` matched the 2026 in "the 2026-07-28 migration"
  // and reported that capsid has 2026 tools.
  const doc = { path: "core.md", type: "core", body: "The tool surface is reviewed against the 2026-07-28 spec migration." };
  assert.deepEqual(scanCountClaims([doc], "capsid"), []);
  // The same exclusion applies to the gate patterns, so a year sitting where a count
  // would go is skipped rather than reported as a gate total.
  const gates = { path: "core.md", type: "core", body: "Reviewed in 2026, 1997 gates ran." };
  assert.deepEqual(scanCountClaims([gates], "capsid"), []);
  // And a real count in the same shape still fires, so the exclusion is not a blanket
  // mute on the pattern.
  const real = { path: "core.md", type: "core", body: "The suite has 7 gates." };
  assert.deepEqual(scanCountClaims([real], "capsid").map((c) => c.states), ["7"]);
});

test("the one genuine hit still fires after all three fixes", () => {
  // capsid/concept-build-operations.md claimed 11 tools. It was the only true
  // positive of the 16, and it must survive the false-positive fixes.
  const doc = { path: "concept-build-operations.md", type: "concept", body: "The server exposes 11 tools over MCP." };
  const claims = scanCountClaims([doc], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].states, "11");
  assert.equal(claims[0].authoritative, "24");
});

// Defects 4 and 5, the two false positives that survived the 2026-08-14 scoping fixes.

test("a transition states the RESULTING count, not the pre-state", () => {
  // "19 to 22" said the surface stopped being 19. The lint reported "states 19".
  const doc = { path: "core.md", type: "core", body: "Expansion layer, tool surface 19 to 22 (links, brief, ci_status)." };
  const claims = scanCountClaims([doc], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].states, "22", "the pre-state was reported instead of the resulting state");

  // And when the resulting state is current, nothing fires.
  assert.deepEqual(scanCountClaims([{ ...doc, body: "the surface went 22 to 24 tools" }], "capsid"), []);
});

test("a transition in a LIVE-STATE doc reports the resulting count", () => {
  // The decisions-log half of this moved to the outright exemption above. What
  // remains is the rule for documents that do assert current state.
  const doc = { path: "core.md", type: "core", body: "Expansion layer, tool surface 19 to 22." };
  const claims = scanCountClaims([doc], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].states, "22");
});

test("a subset count is not a total", () => {
  // The exact sentence that kept firing after the document was corrected.
  const doc = { path: "concept-build-operations.md", type: "concept", body: "The other 12 tools are read-open: list, read, brief." };
  assert.deepEqual(scanCountClaims([doc], "capsid"), []);
  for (const phrase of ["The remaining 12 tools are read-open.", "Only 12 tools are gated.", "Of those 12 tools, none are gated."]) {
    assert.deepEqual(scanCountClaims([{ path: "x.md", type: "concept", body: phrase }], "capsid"), [], `subset not exempted: ${phrase}`);
  }
  // An unqualified total in the same document still fires.
  assert.equal(scanCountClaims([{ path: "x.md", type: "concept", body: "The server exposes 19 tools." }], "capsid").length, 1);
});

test("N of M: M is checked as the total, N is exempt", () => {
  // Correct pair: M matches the authoritative total, so nothing fires.
  assert.deepEqual(scanCountClaims([{ path: "x.md", type: "concept", body: "Gated tools (12 of 24), all failing with DENIED." }], "capsid"), []);
  // Stale M fires, and reports M rather than N.
  const claims = scanCountClaims([{ path: "x.md", type: "concept", body: "Gated tools (11 of 22)." }], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].states, "22");
});

test("N of M is checked for internal consistency even when M is right", () => {
  // A subset larger than its total is wrong without reference to any artifact.
  const claims = scanCountClaims([{ path: "x.md", type: "concept", body: "Gated tools (30 of 24)." }], "capsid");
  assert.equal(claims.length, 1);
  assert.match(claims[0].authoritative, /cannot exceed/);
  assert.match(claims[0].note ?? "", /internal contradiction/);
});
