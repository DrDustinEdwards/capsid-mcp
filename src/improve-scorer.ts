// THE SCORER SEAM: dispatching CI, and admitting what CI says back.
//
// THIS IS THE ONLY MODULE IN src/ THAT MAY NAME THE HOLDOUT BINDING.
// src/env.ts declares it, this file uses it, and nothing else may mention it or
// the bucket name. test/improve-holdout.test.ts fails the build otherwise. The
// third layer is the type: src/improve-attempt.ts takes AttemptEnv, which is
// Omit<Env, "HOLDOUT">, so the binding is not merely unused over there, it does
// not exist in the value's type and a reference does not compile.
//
// WHY THE WORKER CANNOT BE THE SCORER, stated once so nobody re-proposes it: a
// Cloudflare Worker cannot run `npm ci`, a build, or a test suite. There is no
// process to spawn. Anchor metrics that a Worker "computed" would therefore be
// proxies wearing an anchor's name, and an anchor is the one number in this
// system that must not be a proxy. So CI is the scorer, in the target repo, on
// the target branch, with the target's own toolchain.
//
// WHAT THE WORKER STILL HOLDS, and why the binding is not decorative: the
// MANIFEST. CI pulls the holdout TESTS straight from R2 with its own read-only
// token; the Worker never reads them and could not hand them out if asked. It
// reads only `total`, the number of tests that are supposed to exist, and it
// refuses a report claiming fewer. That single number is what stops the cheapest
// attack on a hidden suite, which is not to pass it but to shrink it.

import { hmacHex, timingSafeEqual } from "./auth";
import type { Env } from "./env";
import { dispatchWorkflow } from "./github";
import { holdoutManifestKey, type HoldoutManifest } from "./improve-schema";
import type { MetricMap } from "./improve-scores";

// The workflow file every roster repo carries. One spelling, here, because the
// dispatcher and the documentation that tells Dustin what to add both read it.
export const SCORER_WORKFLOW = "improve-score.yml";

// The report endpoint. Not under /ops/: an /ops/ path means "an operator key
// opens this", and this path is opened by a per-namespace HMAC instead. Naming
// it /ops/ would invite the next reader to add the operator-key check to it and
// hand five repos a key that can write every document in the store.
export const SCORE_PATH = "/improve/score";

// A signature older than this is refused. Bounds replay to the window in which a
// report is still plausibly in flight; a CI job that takes longer than half an
// hour to POST its own result has a different problem.
export const SIGNATURE_MAX_AGE_MS = 30 * 60 * 1000;

// Bound on the report body. A score report is a few hundred bytes of numbers;
// this is three orders of magnitude of headroom and still refuses a body that is
// trying to be something else.
export const MAX_REPORT_BYTES = 16_384;

// ---- the per-namespace key --------------------------------------------------

// ONE WORKER SECRET, N REPO SECRETS.
//
// IMPROVE_SCORE_SECRET never leaves the Worker. Each repo holds only
// HMAC(root, "capsid-improve-score:v1:<namespace>"), so a repo secret leaking
// from one repo's Actions logs authorises reports for that namespace and no
// other, and rotating one namespace does not touch the rest. The alternative,
// one shared secret in five repos, makes the blast radius of any one repo the
// whole system.
//
// The version segment is in the derivation string on purpose: rotating every
// derived key at once is then a one-character change here rather than a new
// secret and five re-pastes.
export async function deriveScoreKey(rootSecret: string, namespace: string): Promise<string> {
  return hmacHex(rootSecret, `capsid-improve-score:v1:${namespace}`);
}

// ---- the report -------------------------------------------------------------

export interface ScoreReport {
  namespace: string;
  run_id: string;
  attempt_id: string;
  head_sha: string;
  anchors: MetricMap;
  secondary: MetricMap;
  // What CI says it ran. Checked against the manifest, which is the half CI
  // cannot forge without also having write access to the holdout bucket.
  holdout: { total: number; passed: number };
  ci_minutes: number;
}

export type ReportParse = { ok: true; report: ScoreReport } | { ok: false; refusal: string };

// Numbers or null, nothing else. A metric map arriving as {"lint_count": "0"} or
// {"lint_count": {"toString": ...}} is refused rather than coerced: coercion is
// how a scorer ends up comparing a string to a number and reporting an
// improvement that is a sort order.
function metricMap(raw: unknown, field: string): { ok: true; map: MetricMap } | { ok: false; refusal: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, refusal: `${field} must be an object of metric names to numbers` };
  }
  const map: MetricMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,64}$/i.test(key)) return { ok: false, refusal: `${field} carries an invalid metric name: ${key}` };
    if (value === null) {
      map[key] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, refusal: `${field}.${key} is ${JSON.stringify(value)}; metrics must be a finite number or null` };
    }
    map[key] = value;
  }
  return { ok: true, map };
}

export function parseScoreReport(bodyText: string): ReportParse {
  if (bodyText.length > MAX_REPORT_BYTES) {
    return { ok: false, refusal: `report body is ${bodyText.length} bytes, over the ${MAX_REPORT_BYTES} ceiling` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch (err) {
    return { ok: false, refusal: `report body is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw === null || typeof raw !== "object") return { ok: false, refusal: "report body is not an object" };
  const r = raw as Record<string, unknown>;
  for (const field of ["namespace", "run_id", "attempt_id", "head_sha"]) {
    if (typeof r[field] !== "string" || (r[field] as string).length === 0 || (r[field] as string).length > 256) {
      return { ok: false, refusal: `report.${field} must be a non-empty string under 256 characters` };
    }
  }
  const anchors = metricMap(r.anchors, "anchors");
  if (!anchors.ok) return { ok: false, refusal: anchors.refusal };
  const secondary = metricMap(r.secondary, "secondary");
  if (!secondary.ok) return { ok: false, refusal: secondary.refusal };

  const holdout = r.holdout as { total?: unknown; passed?: unknown } | undefined;
  if (!holdout || typeof holdout.total !== "number" || typeof holdout.passed !== "number") {
    return { ok: false, refusal: "report.holdout must carry numeric total and passed" };
  }
  const ciMinutes = typeof r.ci_minutes === "number" && Number.isFinite(r.ci_minutes) ? r.ci_minutes : 0;

  return {
    ok: true,
    report: {
      namespace: r.namespace as string,
      run_id: r.run_id as string,
      attempt_id: r.attempt_id as string,
      head_sha: r.head_sha as string,
      anchors: anchors.map,
      secondary: secondary.map,
      holdout: { total: holdout.total, passed: holdout.passed },
      ci_minutes: ciMinutes,
    },
  };
}

// ---- authentication ---------------------------------------------------------

export interface SignedRequest {
  namespace: string;
  timestamp: string;
  signature: string;
  body: string;
}

// The signed payload is the timestamp and the body, joined by a dot. The
// timestamp is INSIDE the signature rather than beside it, or it would be a
// header an attacker rewrites for free to defeat the age check.
export function signaturePayload(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

export type AuthVerdict = { ok: true; namespace: string } | { ok: false; status: number; refusal: string };

// EVERY FAILURE PATH HERE REFUSES. There is no fall-through that admits a report
// because something was missing, which is the one property this function has to
// have: the arc's ruling is that any missing or unauthenticated score is treated
// as a revert, and a revert is what the caller does with a refusal.
export async function verifySignedReport(
  env: Pick<Env, "IMPROVE_SCORE_SECRET">,
  signed: SignedRequest,
  now: Date
): Promise<AuthVerdict> {
  if (!env.IMPROVE_SCORE_SECRET) {
    return { ok: false, status: 503, refusal: "score reporting is not configured: IMPROVE_SCORE_SECRET is unset" };
  }
  if (!/^[a-z0-9_-]{1,64}$/i.test(signed.namespace)) {
    return { ok: false, status: 400, refusal: "missing or malformed namespace header" };
  }
  const at = Date.parse(signed.timestamp);
  if (Number.isNaN(at)) return { ok: false, status: 400, refusal: "missing or unparseable timestamp header" };
  const age = now.getTime() - at;
  // Both directions. A timestamp far in the future is as much a replay handle as
  // one far in the past, and clock skew of a few minutes is what the tolerance
  // below is sized for.
  if (age > SIGNATURE_MAX_AGE_MS || age < -SIGNATURE_MAX_AGE_MS) {
    return { ok: false, status: 401, refusal: `report timestamp is ${Math.round(age / 1000)}s from now, outside the accepted window` };
  }
  const key = await deriveScoreKey(env.IMPROVE_SCORE_SECRET, signed.namespace);
  const expected = await hmacHex(key, signaturePayload(signed.timestamp, signed.body));
  if (!timingSafeEqual(signed.signature.trim().toLowerCase(), expected)) {
    return { ok: false, status: 401, refusal: "score report signature does not verify" };
  }
  return { ok: true, namespace: signed.namespace };
}

// ---- the holdout manifest ---------------------------------------------------

// The ONE read of the HOLDOUT binding in this Worker.
export async function readHoldoutManifest(env: Env, namespace: string): Promise<HoldoutManifest | null> {
  const object = await env.HOLDOUT.get(holdoutManifestKey(namespace));
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text()) as HoldoutManifest;
    if (typeof parsed?.total !== "number" || !Number.isFinite(parsed.total) || parsed.total < 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface HoldoutVerdict {
  ok: boolean;
  refusal: string | null;
  // The pass rate the loop should score, which is computed HERE from the
  // manifest's total rather than taken from the report. A report that ran 3 of 11
  // tests and passed all 3 does not get to call that 1.0.
  passRate: number | null;
}

// NO MANIFEST IS A REFUSAL. The alternative, trusting the report's own total when
// no manifest exists, means a namespace with no holdout set scores exactly like
// one with a passing holdout set, and the anchor becomes decorative for whichever
// namespace forgot to upload it.
export function checkHoldout(manifest: HoldoutManifest | null, report: ScoreReport): HoldoutVerdict {
  if (!manifest) {
    return {
      ok: false,
      refusal: `no holdout manifest for ${report.namespace}. Upload improve/holdout/${report.namespace}/manifest.json to the holdout bucket before the loop can score this namespace.`,
      passRate: null,
    };
  }
  if (report.holdout.total !== manifest.total) {
    return {
      ok: false,
      refusal:
        `holdout size mismatch for ${report.namespace}: the manifest declares ${manifest.total} tests and the report claims ${report.holdout.total}. ` +
        `Treated as a failed anchor. Shrinking the hidden suite is the cheapest way to pass it, so a disagreement here is refused rather than reconciled.`,
      passRate: null,
    };
  }
  if (report.holdout.passed < 0 || report.holdout.passed > manifest.total) {
    return {
      ok: false,
      refusal: `holdout report claims ${report.holdout.passed} of ${manifest.total} passed, which is not a possible result`,
      passRate: null,
    };
  }
  // Computed from the manifest's total, deliberately. See HoldoutVerdict.
  return { ok: true, refusal: null, passRate: manifest.total === 0 ? 1 : report.holdout.passed / manifest.total };
}

// ---- dispatch ---------------------------------------------------------------

// Ask the target repo's CI to score a branch. The workflow file is resolved on
// the DEFAULT branch, never on the attempt branch; see dispatchWorkflow for why.
export async function dispatchScorer(
  env: Env,
  namespace: string,
  inputs: { branch: string; run_id: string; attempt_id: string }
): Promise<{ repo: string; workflow: string; ref: string }> {
  const result = await dispatchWorkflow(env, namespace, SCORER_WORKFLOW, {
    branch: inputs.branch,
    run_id: inputs.run_id,
    attempt_id: inputs.attempt_id,
  });
  return { repo: result.repo, workflow: result.workflow, ref: result.ref };
}
