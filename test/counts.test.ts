import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AUTHORITATIVE, scanCountClaims } from "../src/counts.ts";
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
    AUTHORITATIVE.tools,
    `server.ts registers ${registered.length} tools but counts.ts says ${AUTHORITATIVE.tools}`
  );
});

test("live gate count matches the distinct gates in verify-live.mjs", () => {
  const src = read("../scripts/verify-live.mjs");
  // Gates 3 and 5 each call record() twice, once on the skipped path, so count
  // DISTINCT labels rather than call sites.
  const labels = new Set([...src.matchAll(/record\(\s*"([^"]+)"/g)].map((m) => m[1]));
  assert.equal(
    labels.size,
    AUTHORITATIVE.liveGates,
    `verify-live.mjs has ${labels.size} distinct gates (${[...labels].join(", ")}) but counts.ts says ${AUTHORITATIVE.liveGates}`
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
    AUTHORITATIVE.htmlEnforcedHeaders,
    `header layer emits ${enforced.length} enforced (${enforced.join(", ")}) plus the consent CSP, but counts.ts says ${AUTHORITATIVE.htmlEnforcedHeaders}`
  );
  assert.equal(reportOnly.length, AUTHORITATIVE.htmlReportOnlyHeaders);
});

test("scan flags a stale tool count in a standing doc", () => {
  const claims = scanCountClaims([
    { path: "core.md", type: "core", body: "The server exposes 19 tools today." },
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].noun, "tools");
  assert.equal(claims[0].states, "19");
  assert.equal(claims[0].authoritative, "22");
});

test("scan does NOT flag a correct count", () => {
  assert.deepEqual(scanCountClaims([{ path: "core.md", type: "core", body: "22 tools, split 11 read and 11 write." }]), []);
});

test("episodics are exempt because their numbers are history, not claims", () => {
  // A session doc saying "6 of 6 gates passed" is an accurate record of a run.
  // Flagging it would bury the real findings in noise.
  const claims = scanCountClaims([
    { path: "session-2026-08-09.md", type: "episodic", body: "6 of 6 gates passed. The surface had 19 tools." },
  ]);
  assert.deepEqual(claims, []);
});

test("archived documents are exempt", () => {
  const claims = scanCountClaims([{ path: "archive/old-core.md", type: "core", body: "16 tools." }]);
  assert.deepEqual(claims, []);
});

test("the 'N of M gates' form is judged on the TOTAL, not the numerator", () => {
  // "6 of 8 gates" states the artifact has 8 gates, which is correct, and that 6
  // passed, which is a run result and none of this lint's business.
  assert.deepEqual(scanCountClaims([{ path: "core.md", type: "core", body: "6 of 8 gates passed" }]), []);
  const stale = scanCountClaims([{ path: "core.md", type: "core", body: "6 of 6 gates passed" }]);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].states, "6");
  assert.equal(stale[0].authoritative, "8");
});

test("'all seven' is flagged when it is about headers", () => {
  const claims = scanCountClaims([
    { path: "decisions.md", type: "decision", body: "Propose HTML gets all seven, JSON gets nosniff." },
  ]);
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
    assert.deepEqual(scanCountClaims([{ path: "parity/notes.md", type: "reference", body }]), [], `false positive on: ${body}`);
  }
});

test("the scan never returns a rewritten body, only a flag", () => {
  // Flag, never auto-correct. If this object ever grows a "corrected" or
  // "replacement" field, that is a program editing canon on its own judgement.
  const claims = scanCountClaims([{ path: "core.md", type: "core", body: "19 tools" }]);
  for (const c of claims) {
    assert.deepEqual(
      Object.keys(c).sort().filter((k) => !["path", "type", "noun", "quote", "states", "authoritative", "note"].includes(k)),
      []
    );
  }
});
