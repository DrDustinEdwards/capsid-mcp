import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  anchorChecksum,
  anchorRegressions,
  anchorVerdict,
  compare,
  parseScoresDoc,
  seedScoresDoc,
  verifyAnchors,
} from "../src/improve-scores.ts";
import { fakeKv } from "./fakes.ts";

// The referee: the scores document, the anchor pin, and keep-or-revert.
//
// Everything here is a pure function over a document a human wrote and a checksum
// a human pinned. No model, no network, no database. That is deliberate in the
// code and it is why this file can assert the loop's safety properties directly
// rather than through a run.

const DOC = seedScoresDoc("capsid");

test("the generated seed document parses to the anchors and secondaries it states", () => {
  const doc = parseScoresDoc("capsid", DOC);
  assert.deepEqual(doc.problems, [], `the seed document does not parse: ${doc.problems.join("; ")}`);
  assert.deepEqual(
    doc.anchors.map((a) => `${a.metric}:${a.kind}:${a.bound}`),
    ["build_passes:required:null", "holdout_pass_rate:min:1"]
  );
  assert.deepEqual(
    doc.secondary.map((s) => s.metric),
    ["test_pass_rate", "lint_count", "error_count", "p95_latency_ms", "bundle_size_bytes"]
  );
  // Vacuity guard on the round trip: the parser is being exercised against the
  // exact text the generator emits, so a generator change that breaks the format
  // fails here rather than at 03:00.
  assert.ok(doc.anchorBlock.includes("build_passes"), "the anchor block did not capture its own lines");
});

test("foxhound, and only foxhound, carries the two stub metrics", () => {
  // Keyed on foxhound since the 2026-09-05 namespace rename. Both stubs belong to
  // this ONE namespace because it maps to both repos: recovery_rate to the legacy
  // Recova product, dispute_win_rate to foxhound itself.
  const foxhound = parseScoresDoc("foxhound", seedScoresDoc("foxhound"));
  const stubs = foxhound.secondary.filter((s) => s.stub).map((s) => s.metric);
  assert.deepEqual(stubs, ["recovery_rate", "dispute_win_rate"]);
  for (const namespace of ["capsid", "foxing", "germomics", "dustinedwards"]) {
    const doc = parseScoresDoc(namespace, seedScoresDoc(namespace));
    assert.deepEqual(doc.secondary.filter((s) => s.stub), [], `${namespace} unexpectedly carries a stub metric`);
  }
});

// ---- the checksum -----------------------------------------------------------

test("the checksum covers the ANCHOR SECTION and not the secondary section", async () => {
  const original = parseScoresDoc("capsid", DOC);
  // A human reweights a secondary metric. This must NOT move the anchor hash,
  // because the alternative is a refusal at 03:00 for a legitimate edit.
  const reweighted = parseScoresDoc("capsid", DOC.replace("lint_count: minimize weight 2", "lint_count: minimize weight 5"));
  assert.equal(await anchorChecksum(reweighted), await anchorChecksum(original));

  // An anchor is loosened. This MUST move it.
  const loosened = parseScoresDoc("capsid", DOC.replace("holdout_pass_rate: min 1.0", "holdout_pass_rate: min 0.5"));
  assert.notEqual(await anchorChecksum(loosened), await anchorChecksum(original));
});

test("CRLF does not change the anchor hash", async () => {
  // capsid/repo-structure.md records the CRLF checkout hazard as a measured trap
  // that has already produced two vacuous plants. A document reaching the Worker
  // through a checkout on an autocrlf host must hash the same as one written
  // through the MCP write path, or the pin mismatches forever for a reason nobody
  // can find.
  const lf = parseScoresDoc("capsid", DOC);
  const crlf = parseScoresDoc("capsid", DOC.replace(/\n/g, "\r\n"));
  assert.equal(await anchorChecksum(crlf), await anchorChecksum(lf));
});

test("a MISSING pin is a refusal, not a free pass", async () => {
  const { kv } = fakeKv();
  const verification = await verifyAnchors(kv, "capsid", parseScoresDoc("capsid", DOC));
  assert.equal(verification.ok, false);
  assert.match(verification.refusal ?? "", /no anchor pin for capsid/);
  // And it hands over the value to pin, so the fix is one command rather than a
  // hunt. Pinning on first sight is the alternative this refuses: whatever the
  // anchors happened to say the first time the loop looked would become canon.
  assert.match(verification.refusal ?? "", new RegExp(verification.current));
});

test("a MISMATCHED pin refuses and names both hashes", async () => {
  const doc = parseScoresDoc("capsid", DOC);
  const { kv } = fakeKv({ seed: { "improve:anchor:capsid": "0".repeat(64) } });
  const verification = await verifyAnchors(kv, "capsid", doc);
  assert.equal(verification.ok, false);
  assert.match(verification.refusal ?? "", /anchor checksum mismatch/);
  assert.match(verification.refusal ?? "", /Nothing ran/);
  assert.match(verification.refusal ?? "", new RegExp(await anchorChecksum(doc)));
});

test("the pin the loop hands out is the one it accepts back", async () => {
  const doc = parseScoresDoc("capsid", DOC);
  const pin = await anchorChecksum(doc);
  const { kv } = fakeKv({ seed: { "improve:anchor:capsid": pin } });
  const verification = await verifyAnchors(kv, "capsid", doc);
  assert.equal(verification.ok, true, verification.refusal ?? "");
  assert.equal(verification.refusal, null);
  // The hash is a plain sha256 over the block, computable without this module.
  assert.equal(pin, createHash("sha256").update(doc.anchorBlock).digest("hex"));
});

test("a pin that verifies is still refused when the document does not parse", async () => {
  const broken = "# scores\n\n## Anchors\n\n- build_passes: whatever\n\n## Secondary\n\n- x: sideways weight 1\n";
  const doc = parseScoresDoc("capsid", broken);
  const { kv } = fakeKv({ seed: { "improve:anchor:capsid": await anchorChecksum(doc) } });
  const verification = await verifyAnchors(kv, "capsid", doc);
  assert.equal(verification.ok, false);
  assert.match(verification.refusal ?? "", /does not parse/);
});

test("an unreadable KV refuses rather than proceeding unpinned", async () => {
  const { kv } = fakeKv({ failGet: true });
  const verification = await verifyAnchors(kv, "capsid", parseScoresDoc("capsid", DOC));
  assert.equal(verification.ok, false);
  assert.match(verification.refusal ?? "", /Refusing the run rather than proceeding unpinned/);
});

test("a document with an Anchors heading and no anchors is refused", async () => {
  const doc = parseScoresDoc("capsid", "# s\n\n## Anchors\n\nnothing here\n\n## Secondary\n\n- a: maximize weight 1\n");
  assert.ok(doc.problems.some((p) => /declares no anchors/.test(p)), doc.problems.join("; "));
});

// ---- the anchor verdict -----------------------------------------------------

test("an UNREPORTED anchor is a FAILED anchor", () => {
  const anchors = parseScoresDoc("capsid", DOC).anchors;
  // The cheapest way to pass an anchor is to stop reporting it. Skipping an
  // unreported anchor would score a scorer that quietly stopped running the
  // holdout suite exactly like one that runs it and passes.
  const verdict = anchorVerdict(anchors, { build_passes: 1 });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reasons.join(" "), /holdout_pass_rate was not reported/);

  const nulled = anchorVerdict(anchors, { build_passes: 1, holdout_pass_rate: null });
  assert.equal(nulled.passed, false);
  assert.match(nulled.reasons.join(" "), /holdout_pass_rate was not reported/);
});

test("required means truthy and a floor means at least", () => {
  const anchors = parseScoresDoc("capsid", DOC).anchors;
  assert.equal(anchorVerdict(anchors, { build_passes: 1, holdout_pass_rate: 1 }).passed, true);
  assert.equal(anchorVerdict(anchors, { build_passes: 0, holdout_pass_rate: 1 }).passed, false);
  assert.equal(anchorVerdict(anchors, { build_passes: 1, holdout_pass_rate: 0.99 }).passed, false);
});

test("a ceiling anchor is judged in the other direction", () => {
  const doc = parseScoresDoc("x", "# s\n\n## Anchors\n\n- crashes: max 0\n\n## Secondary\n\n- a: maximize weight 1\n");
  assert.equal(anchorVerdict(doc.anchors, { crashes: 0 }).passed, true);
  assert.equal(anchorVerdict(doc.anchors, { crashes: 1 }).passed, false);
});

test("anchorRegressions sees a drop that is still inside its bound", () => {
  const anchors = parseScoresDoc("capsid", DOC).anchors;
  // 1.0 to 0.98 against a floor of 1.0 fails the verdict, so use a looser floor:
  // the point of this function is the slide nothing else can see.
  const loose = parseScoresDoc("x", "# s\n\n## Anchors\n\n- holdout_pass_rate: min 0.9\n\n## Secondary\n\n- a: maximize weight 1\n").anchors;
  assert.equal(anchorVerdict(loose, { holdout_pass_rate: 0.95 }).passed, true);
  assert.deepEqual(anchorRegressions(loose, { holdout_pass_rate: 1 }, { holdout_pass_rate: 0.95 }), [
    "holdout_pass_rate moved from 1 to 0.95",
  ]);
  // No drop, no finding. And an unmeasured side is not a drop.
  assert.deepEqual(anchorRegressions(anchors, { build_passes: 1 }, { build_passes: 1 }), []);
  assert.deepEqual(anchorRegressions(anchors, { build_passes: 1 }, {}), []);
});

// ---- keep or revert ---------------------------------------------------------

const SECONDARY = parseScoresDoc("capsid", DOC).secondary;
const BASE = {
  test_pass_rate: 0.9,
  lint_count: 10,
  error_count: 4,
  p95_latency_ms: 200,
  bundle_size_bytes: 100_000,
};

test("a strict improvement is kept", () => {
  const result = compare(SECONDARY, BASE, { ...BASE, lint_count: 5 });
  assert.equal(result.improved, true);
  assert.ok(result.delta > 0);
  assert.equal(result.compared, 5);
});

test("a TIE reverts", () => {
  // Churn accumulates into a diff nobody can review, so "no worse" is not enough.
  const result = compare(SECONDARY, BASE, { ...BASE });
  assert.equal(result.improved, false);
  assert.equal(result.delta, 0);
  assert.match(result.reason, /a tie or a loss reverts/);
});

test("a regression reverts", () => {
  const result = compare(SECONDARY, BASE, { ...BASE, lint_count: 20 });
  assert.equal(result.improved, false);
  assert.ok(result.delta < 0);
});

test("AN UNPROVABLE COMPARISON REVERTS, and says why", () => {
  // The cheapest way to score well is to report nothing. A system that reads
  // silence as success rewards exactly that.
  const result = compare(SECONDARY, BASE, {});
  assert.equal(result.improved, false);
  assert.equal(result.compared, 0);
  assert.match(result.reason, /no secondary metric could be compared/);
  assert.match(result.reason, /reporting nothing must never be the cheapest way to score well/);
});

test("a metric missing on ONE side is excluded and named", () => {
  const result = compare(SECONDARY, BASE, { ...BASE, lint_count: null });
  const lint = result.details.find((d) => d.metric === "lint_count");
  assert.equal(lint?.contribution, null);
  assert.match(lint?.why ?? "", /not reported by this attempt/);
  assert.equal(result.compared, 4, "the other four should still be compared");
});

test("a STUB metric is excluded even when both sides report a value", () => {
  const stubbed = parseScoresDoc("foxhound", seedScoresDoc("foxhound")).secondary;
  const result = compare(stubbed, { ...BASE, recovery_rate: 0.1 }, { ...BASE, recovery_rate: 0.9 });
  const stub = result.details.find((d) => d.metric === "recovery_rate");
  assert.equal(stub?.contribution, null);
  assert.match(stub?.why ?? "", /declared a stub/);
  // A huge apparent win on a stub must not carry the decision.
  assert.equal(result.improved, false, "a stub metric moved the verdict");
});

test("a metric measured in bytes cannot drown four measured in counts", () => {
  // Without the relative scaling and the clamp, a 1KB bundle reduction would
  // outweigh every other metric combined, because its raw magnitude is larger.
  const bytesOnly = compare(SECONDARY, BASE, { ...BASE, bundle_size_bytes: 99_000 });
  const countsWorse = compare(SECONDARY, BASE, {
    ...BASE,
    bundle_size_bytes: 99_000,
    lint_count: 30,
    error_count: 12,
  });
  assert.equal(bytesOnly.improved, true);
  assert.equal(countsWorse.improved, false, "a small byte win outweighed two large count regressions");
});

test("a base of zero does not divide by zero, and an increase from zero still registers a loss", () => {
  const zeroBase = { ...BASE, lint_count: 0 };
  const result = compare(SECONDARY, zeroBase, { ...zeroBase, lint_count: 3 });
  const lint = result.details.find((d) => d.metric === "lint_count");
  assert.ok(Number.isFinite(lint?.contribution ?? NaN), "the contribution was not finite");
  assert.ok((lint?.contribution ?? 0) < 0, "an increase from zero did not register as a loss");
});

test("one metric's contribution is bounded by its weight", () => {
  // The clamp. A metric that improved a thousandfold contributes its weight and
  // no more, so no single number can carry an otherwise losing change.
  const result = compare(SECONDARY, BASE, { ...BASE, test_pass_rate: 900 });
  const rate = result.details.find((d) => d.metric === "test_pass_rate");
  assert.equal(rate?.contribution, 3);
});
