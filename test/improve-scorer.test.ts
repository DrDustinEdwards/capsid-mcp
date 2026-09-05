import assert from "node:assert/strict";
import { test } from "node:test";
import { hmacHex } from "../src/auth.ts";
import { ROSTER } from "../src/improve-schema.ts";
import {
  checkHoldout,
  deriveScoreKey,
  MAX_REPORT_BYTES,
  parseScoreReport,
  SCORE_PATH,
  signaturePayload,
  SIGNATURE_MAX_AGE_MS,
  verifySignedReport,
  type ScoreReport,
} from "../src/improve-scorer.ts";

// The scorer seam: who may report a score, and what a report has to say to be
// believed. Nothing here needs a database or a network.

const ROOT = "root-secret-value";
const NOW = new Date("2026-09-04T12:00:00Z");

function report(over: Partial<ScoreReport> = {}): ScoreReport {
  return {
    namespace: "capsid",
    run_id: "capsid-2026-09-04T08-00-00",
    attempt_id: "capsid-2026-09-04T08-00-00-a01",
    head_sha: "abc123",
    anchors: { build_passes: 1 },
    secondary: { lint_count: 3 },
    holdout: { total: 11, passed: 11 },
    ci_minutes: 4,
    ...over,
  };
}

async function sign(namespace: string, body: string, at: Date = NOW): Promise<{ namespace: string; timestamp: string; signature: string; body: string }> {
  const key = await deriveScoreKey(ROOT, namespace);
  const timestamp = at.toISOString();
  return { namespace, timestamp, signature: await hmacHex(key, signaturePayload(timestamp, body)), body };
}

// ---- the endpoint is not under /ops/ ----------------------------------------

test("the score path is NOT under /ops/, deliberately", () => {
  // An /ops/ path means an operator key opens it, and an operator key can write
  // every document in the store. Five repos need to reach this endpoint.
  assert.equal(SCORE_PATH, "/improve/score");
  assert.equal(SCORE_PATH.startsWith("/ops/"), false);
});

// ---- key derivation ---------------------------------------------------------

test("each namespace gets a DIFFERENT key, and none of them is the root secret", async () => {
  // DERIVED FROM ROSTER rather than restated. The list was spelled out here and
  // went stale the moment the recova namespace was renamed to foxhound, which is
  // the drift this repo keeps ruling against, one level down.
  const keys = await Promise.all(ROSTER.map((ns) => deriveScoreKey(ROOT, ns)));
  assert.equal(new Set(keys).size, keys.length, "two namespaces derived the same key");
  for (const key of keys) {
    assert.notEqual(key, ROOT, "a derived key is the root secret itself");
    assert.equal(key.length, 64);
  }
});

test("derivation is stable, so a repo secret does not have to be re-pasted", async () => {
  assert.equal(await deriveScoreKey(ROOT, "capsid"), await deriveScoreKey(ROOT, "capsid"));
});

// ---- signature verification -------------------------------------------------

test("a correctly signed report is admitted", async () => {
  const body = JSON.stringify(report());
  const verdict = await verifySignedReport({ IMPROVE_SCORE_SECRET: ROOT }, await sign("capsid", body), NOW);
  assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.refusal);
});

test("A KEY FOR ONE NAMESPACE CANNOT SIGN FOR ANOTHER", async () => {
  // The whole reason the keys are derived per namespace. foxing's Actions log
  // leaking must not let anything report for capsid.
  const body = JSON.stringify(report());
  const signed = await sign("foxing", body);
  const verdict = await verifySignedReport({ IMPROVE_SCORE_SECRET: ROOT }, { ...signed, namespace: "capsid" }, NOW);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 401);
  assert.match(verdict.ok === false ? verdict.refusal : "", /signature does not verify/);
});

test("a tampered body fails, even with a valid signature for the original", async () => {
  const signed = await sign("capsid", JSON.stringify(report()));
  const tampered = { ...signed, body: JSON.stringify(report({ secondary: { lint_count: 0 } })) };
  const verdict = await verifySignedReport({ IMPROVE_SCORE_SECRET: ROOT }, tampered, NOW);
  assert.equal(verdict.ok, false);
});

test("THE TIMESTAMP IS INSIDE THE SIGNATURE, so rewriting it does not defeat the age check", async () => {
  const body = JSON.stringify(report());
  const signed = await sign("capsid", body, new Date(NOW.getTime() - SIGNATURE_MAX_AGE_MS - 60_000));
  // Replay attempt: keep the old signature, present a fresh timestamp.
  const replayed = { ...signed, timestamp: NOW.toISOString() };
  const verdict = await verifySignedReport({ IMPROVE_SCORE_SECRET: ROOT }, replayed, NOW);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.refusal : "", /signature does not verify/);
});

test("a stale signature is refused on age", async () => {
  const body = JSON.stringify(report());
  const at = new Date(NOW.getTime() - SIGNATURE_MAX_AGE_MS - 60_000);
  const verdict = await verifySignedReport({ IMPROVE_SCORE_SECRET: ROOT }, await sign("capsid", body, at), NOW);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.refusal : "", /outside the accepted window/);
});

test("a timestamp far in the FUTURE is refused too", async () => {
  // A future timestamp is as much a replay handle as a past one.
  const body = JSON.stringify(report());
  const at = new Date(NOW.getTime() + SIGNATURE_MAX_AGE_MS + 60_000);
  const verdict = await verifySignedReport({ IMPROVE_SCORE_SECRET: ROOT }, await sign("capsid", body, at), NOW);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.refusal : "", /outside the accepted window/);
});

test("a few minutes of clock skew is tolerated", async () => {
  const body = JSON.stringify(report());
  for (const skew of [-120_000, 120_000]) {
    const verdict = await verifySignedReport(
      { IMPROVE_SCORE_SECRET: ROOT },
      await sign("capsid", body, new Date(NOW.getTime() + skew)),
      NOW
    );
    assert.equal(verdict.ok, true, `${skew}ms of skew was refused`);
  }
});

test("an unconfigured secret refuses with 503, not 401", async () => {
  // 401 would tell the caller its key is wrong. The key is fine; the server is
  // not configured, and those need different fixes.
  const verdict = await verifySignedReport({}, await sign("capsid", "{}"), NOW);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 503);
  assert.match(verdict.ok === false ? verdict.refusal : "", /IMPROVE_SCORE_SECRET is unset/);
});

test("a malformed namespace or timestamp header is a 400", async () => {
  const bad = await verifySignedReport({ IMPROVE_SCORE_SECRET: ROOT }, { namespace: "not a namespace!", timestamp: NOW.toISOString(), signature: "x", body: "{}" }, NOW);
  assert.equal(bad.ok === false && bad.status, 400);
  const noTime = await verifySignedReport({ IMPROVE_SCORE_SECRET: ROOT }, { namespace: "capsid", timestamp: "yesterday", signature: "x", body: "{}" }, NOW);
  assert.equal(noTime.ok === false && noTime.status, 400);
});

// ---- report parsing ---------------------------------------------------------

test("a well-formed report parses", () => {
  const parsed = parseScoreReport(JSON.stringify(report()));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.refusal);
  assert.equal(parsed.ok && parsed.report.namespace, "capsid");
  assert.equal(parsed.ok && parsed.report.holdout.total, 11);
});

test("a metric that is a STRING is refused, not coerced", () => {
  // Coercion is how a scorer ends up comparing a string to a number and reporting
  // an improvement that is a sort order.
  const parsed = parseScoreReport(JSON.stringify({ ...report(), secondary: { lint_count: "0" } }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok === false ? parsed.refusal : "", /must be a finite number or null/);
});

test("a non-finite metric is refused", () => {
  // JSON cannot carry Infinity, so it arrives as null or as a string; both are
  // covered. This is the shape a hand-built body would use.
  const parsed = parseScoreReport('{"namespace":"capsid","run_id":"r","attempt_id":"a","head_sha":"s","anchors":{},"secondary":{"x":1e999},"holdout":{"total":1,"passed":1}}');
  assert.equal(parsed.ok, false);
});

test("a null metric IS allowed, because a stub reports null", () => {
  const parsed = parseScoreReport(JSON.stringify({ ...report(), secondary: { recovery_rate: null } }));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.refusal);
  assert.equal(parsed.ok && parsed.report.secondary.recovery_rate, null);
});

test("an oversized body is refused before it is parsed", () => {
  const parsed = parseScoreReport("x".repeat(MAX_REPORT_BYTES + 1));
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok === false ? parsed.refusal : "", /over the .* ceiling/);
});

test("a missing holdout block is refused", () => {
  const { holdout, ...rest } = report();
  void holdout;
  const parsed = parseScoreReport(JSON.stringify(rest));
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok === false ? parsed.refusal : "", /holdout must carry numeric total and passed/);
});

test("an invalid metric NAME is refused", () => {
  const parsed = parseScoreReport(JSON.stringify({ ...report(), secondary: { "../etc": 1 } }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok === false ? parsed.refusal : "", /invalid metric name/);
});

// ---- the holdout check ------------------------------------------------------

const MANIFEST = { namespace: "capsid", total: 11, updated_at: "2026-09-01T00:00:00Z" };

test("NO MANIFEST IS A REFUSAL", () => {
  // Trusting the report's own total when no manifest exists means a namespace
  // with no holdout set scores exactly like one with a passing holdout set.
  const verdict = checkHoldout(null, report());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.passRate, null);
  assert.match(verdict.refusal ?? "", /no holdout manifest for capsid/);
});

test("A SHRUNK SUITE IS REFUSED, which is the attack this check exists for", () => {
  // The cheapest attack on a hidden suite is not to pass it but to shrink it.
  const verdict = checkHoldout(MANIFEST, report({ holdout: { total: 3, passed: 3 } }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.passRate, null);
  assert.match(verdict.refusal ?? "", /manifest declares 11 tests and the report claims 3/);
  assert.match(verdict.refusal ?? "", /refused rather than reconciled/);
});

test("THE PASS RATE IS COMPUTED FROM THE MANIFEST, not taken from the report", () => {
  const verdict = checkHoldout(MANIFEST, report({ holdout: { total: 11, passed: 10 } }));
  assert.equal(verdict.ok, true, verdict.refusal ?? "");
  assert.ok(Math.abs((verdict.passRate ?? 0) - 10 / 11) < 1e-9);
});

test("an impossible pass count is refused", () => {
  assert.equal(checkHoldout(MANIFEST, report({ holdout: { total: 11, passed: 12 } })).ok, false);
  assert.equal(checkHoldout(MANIFEST, report({ holdout: { total: 11, passed: -1 } })).ok, false);
});

test("a full pass is 1.0", () => {
  const verdict = checkHoldout(MANIFEST, report());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.passRate, 1);
});
