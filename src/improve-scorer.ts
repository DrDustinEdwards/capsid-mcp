import { hmacHex, timingSafeEqual } from "./auth";
import type { Env } from "./env";
import { HOLDOUT_PREFIX, holdoutManifestKey, ROSTER, type HoldoutManifest } from "./improve-schema";
import type { MetricMap } from "./improve-scores";

// HMAC, not operator key: an /ops/ path would invite adding the operator-key check.
export const SCORE_PATH = "/improve/score";

// The holdout-credential endpoint (platform arc 2026-09-06). Same auth as
// SCORE_PATH, same reasoning for not being under /ops/: it is opened by the
// per-namespace HMAC key, so a repo can mint read access to ITS OWN holdout
// prefix and nothing else, and no long-lived S3 secret sits in any repo.
export const CREDENTIAL_PATH = "/improve/holdout-credential";

// The backup-credential endpoint (session 3, off-account backup). Same envelope,
// but signed with a BACKUP-SPECIFIC key derived under its own context, so the
// mirror job's key opens read access to backups/json/ on the media bucket and
// nothing on the improve side, and no roster repo's score key opens this.
export const BACKUP_CREDENTIAL_PATH = "/backup/credential";

// A signature older than this is refused. Bounds replay to the window in which a
// report is still plausibly in flight; a CI job that takes longer than half an
// hour to POST its own result has a different problem.
export const SIGNATURE_MAX_AGE_MS = 30 * 60 * 1000;

// Bound on the report body. A score report is a few hundred bytes of numbers;
// this is three orders of magnitude of headroom and still refuses a body that is
// trying to be something else.
export const MAX_REPORT_BYTES = 16_384;

// ---- body cap and replay cache (audit 2026-09-06) ---------------------------

// Read a request body as text, stopping the moment it exceeds `max` bytes. Unlike
// request.text(), which buffers the whole body before its size can be checked, this
// pulls from the stream and aborts on overflow, so an oversized or lying-length
// body is refused before it is fully in memory and before any HMAC touches it.
export async function readBoundedText(
  request: { body: ReadableStream<Uint8Array> | null },
  max: number
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

// Claim a report's nonce, or refuse it. THE DATABASE DECIDES, not the code (audit
// 2026-09-07, Grok MAJOR 3).
//
// This was a KV get-then-put: two round trips with nothing atomic between them, so
// two requests carrying the same captured signature both read absent and both
// proceeded. The signature is valid for 30 minutes either side, so a captured POST
// could be replayed for an hour by racing it against itself, on all three signed
// endpoints.
//
// An INSERT against a PRIMARY KEY has no such window: it returns the row, meaning
// this call claimed the nonce, or nothing, meaning someone else already had it.
// RETURNING rather than meta.changes.
//
// FAILS CLOSED on a database error: these endpoints move the improve state machine.
export async function claimJti(
  db: D1Database,
  scope: string,
  jti: string
): Promise<{ ok: true } | { ok: false; status: number; refusal: string }> {
  try {
    const { results } = await db
      .prepare(
        `INSERT INTO improve_jti (scope, jti) VALUES (?1, ?2)
         ON CONFLICT(scope, jti) DO NOTHING
         RETURNING jti`
      )
      .bind(scope, jti)
      .all<{ jti: string }>();
    if (results.length === 1) return { ok: true };
    return { ok: false, status: 409, refusal: "replay: this signed request (jti) was already accepted" };
  } catch (err) {
    return {
      ok: false,
      status: 503,
      refusal: `could not verify replay status (${err instanceof Error ? err.message : String(err)}); refusing the request`,
    };
  }
}

// ---- the per-namespace key --------------------------------------------------

// ONE WORKER SECRET, N REPO SECRETS.
//
// IMPROVE_SCORE_SECRET never leaves the Worker. Each repo holds only
// HMAC(root, "capsid-improve-score:v1:<namespace>"), so a repo secret leaking from
// one repo's Actions logs authorises reports for that namespace and no other, and
// rotating one namespace does not touch the rest.
//
// The version segment is in the derivation string so rotating every derived key at
// once is a one-character change here rather than a new secret and five re-pastes.
export async function deriveScoreKey(rootSecret: string, namespace: string): Promise<string> {
  return hmacHex(rootSecret, `capsid-improve-score:v1:${namespace}`);
}

// The backup mirror's key, from the same root under a DIFFERENT context string,
// so it is unequal to every namespace score key by construction and rotates with
// the same one-character version bump. scripts/improve-derive-key.mjs
// --backup-credential performs the identical computation to set the repo secret.
export async function deriveBackupCredentialKey(rootSecret: string): Promise<string> {
  return hmacHex(rootSecret, "capsid-backup-credential:v1");
}

// ---- the report -------------------------------------------------------------

export interface ScoreReport {
  namespace: string;
  run_id: string;
  attempt_id: string;
  head_sha: string;
  // A per-report nonce, inside the signed body so it cannot be swapped. The Worker
  // keeps a KV replay cache keyed on (namespace, jti) for the signature window, so
  // a captured, still-in-window signed report cannot be posted twice (audit
  // 2026-09-06). The workflow generates a fresh uuid per post.
  jti: string;
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
  for (const field of ["namespace", "run_id", "attempt_id", "head_sha", "jti"]) {
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
      jti: r.jti as string,
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

type HmacFail = { ok: false; status: number; refusal: string };

async function verifyHmac(
  env: Pick<Env, "IMPROVE_SCORE_SECRET">,
  signed: { timestamp: string; signature: string; body: string },
  now: Date,
  opts: {
    deriveKey: (root: string) => Promise<string>;
    missingSecret: string;
    badSig: string;
    ageNoun: "report" | "request";
    afterSecret?: () => HmacFail | null;
  }
): Promise<{ ok: true } | HmacFail> {
  if (!env.IMPROVE_SCORE_SECRET) {
    return { ok: false, status: 503, refusal: opts.missingSecret };
  }
  const extra = opts.afterSecret?.();
  if (extra) return extra;
  const at = Date.parse(signed.timestamp);
  if (Number.isNaN(at)) return { ok: false, status: 400, refusal: "missing or unparseable timestamp header" };
  const age = now.getTime() - at;
  // Both directions. A timestamp far in the future is as much a replay handle as
  // one far in the past, and clock skew of a few minutes is what the tolerance
  // below is sized for.
  if (age > SIGNATURE_MAX_AGE_MS || age < -SIGNATURE_MAX_AGE_MS) {
    return { ok: false, status: 401, refusal: `${opts.ageNoun} timestamp is ${Math.round(age / 1000)}s from now, outside the accepted window` };
  }
  const key = await opts.deriveKey(env.IMPROVE_SCORE_SECRET);
  const expected = await hmacHex(key, signaturePayload(signed.timestamp, signed.body));
  if (!timingSafeEqual(signed.signature.trim().toLowerCase(), expected)) {
    return { ok: false, status: 401, refusal: opts.badSig };
  }
  return { ok: true };
}

// EVERY FAILURE PATH HERE REFUSES. There is no fall-through that admits a report
// because something was missing. The arc's ruling is that any missing or
// unauthenticated score is treated as a revert, which is what the caller does with a
// refusal.
export async function verifySignedReport(
  env: Pick<Env, "IMPROVE_SCORE_SECRET">,
  signed: SignedRequest,
  now: Date
): Promise<AuthVerdict> {
  const hmac = await verifyHmac(env, signed, now, {
    deriveKey: (root) => deriveScoreKey(root, signed.namespace),
    missingSecret: "score reporting is not configured: IMPROVE_SCORE_SECRET is unset",
    badSig: "score report signature does not verify",
    ageNoun: "report",
    afterSecret: () =>
      /^[a-z0-9_-]{1,64}$/i.test(signed.namespace)
        ? null
        : { ok: false, status: 400, refusal: "missing or malformed namespace header" },
  });
  if (!hmac.ok) return hmac;
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

// EVERY ROSTER NAMESPACE'S MANIFEST, for the nightly dump (residual 4). A manifest is
// a COUNT and a date, never a test, so a backup that leaves the account discloses
// nothing the loop's refusals do not state out loud. It is here rather than in
// src/backup.ts because only this module may name the HOLDOUT binding
// (test/improve-holdout.test.ts), and the dump is the only copy of the hidden suites'
// sizes outside one R2 bucket: lose the bucket and every namespace refuses.
export async function readHoldoutManifests(env: Env): Promise<Record<string, HoldoutManifest | null>> {
  const manifests: Record<string, HoldoutManifest | null> = {};
  for (const namespace of ROSTER) {
    try {
      manifests[namespace] = await readHoldoutManifest(env, namespace);
    } catch {
      // A bucket that cannot be read is a null beside the others rather than a
      // thrown backup: the D1 dump is the part that must not be lost.
      manifests[namespace] = null;
    }
  }
  return manifests;
}

export interface HoldoutVerdict {
  ok: boolean;
  refusal: string | null;
  // The pass rate the loop should score, which is computed HERE from the
  // manifest's total rather than taken from the report. A report that ran 3 of 11
  // tests and passed all 3 does not get to call that 1.0.
  passRate: number | null;
}

// NO MANIFEST IS A REFUSAL. Trusting the report's own total when no manifest exists
// means a namespace with no holdout set scores exactly like one with a passing set,
// and the anchor becomes decorative for whichever namespace forgot to upload it.
export function checkHoldout(manifest: HoldoutManifest | null, report: ScoreReport): HoldoutVerdict {
  if (!manifest) {
    return {
      ok: false,
      refusal: `no holdout manifest for ${report.namespace}. Upload improve/holdout/${report.namespace}/manifest.json to the holdout bucket before the loop can score this namespace.`,
      passRate: null,
    };
  }
  // ZERO TESTS IS A REFUSAL, exactly like no manifest (audit 2026-09-06). An empty
  // hidden suite scores 1.0 by arithmetic, so a manifest saying total: 0 would pass
  // the one anchor the loop rests on with no hidden test running. An empty manifest is
  // indistinguishable from forgetting to write the suite.
  if (manifest.total === 0) {
    return {
      ok: false,
      refusal:
        `the holdout manifest for ${report.namespace} declares zero tests. An empty hidden suite scores exactly like a passing one, ` +
        `so it is refused until the suite exists. Upload real tests and a manifest with their count to the holdout bucket.`,
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
  // total is > 0 here: the zero-test manifest was refused above.
  return { ok: true, refusal: null, passRate: report.holdout.passed / manifest.total };
}

// ---- temporary holdout credentials (platform arc 2026-09-06) ----------------

// The bucket NAME, named here and nowhere else in src/ (the guard in
// test/improve-holdout.test.ts exempts exactly this module, which already holds
// the binding). It has to be spelled for the temp-access-credentials API, which
// scopes by bucket name, not by binding.
export const HOLDOUT_BUCKET_NAME = "capsid-improve-holdout";

// One hour. The score job pulls the suite within minutes of asking; an hour is
// generous headroom and three orders of magnitude under the API's 7-day ceiling.
export const HOLDOUT_CREDENTIAL_TTL_SECONDS = 3600;

// What the credential request body must say: which namespace (bound to the
// signing key by the same rule as a score report) and a jti so a captured
// request cannot be replayed inside the signature window.
function parseJsonBody(body: string): { ok: true; parsed: unknown } | { ok: false; refusal: string } {
  try {
    return { ok: true, parsed: JSON.parse(body) };
  } catch {
    return { ok: false, refusal: "the credential request body is not JSON" };
  }
}

function jtiOf(parsed: unknown): { ok: true; jti: string } | { ok: false; refusal: string } {
  const jti = (parsed as { jti?: unknown } | null)?.jti;
  if (typeof jti !== "string" || jti.length < 8 || jti.length > 128) {
    return { ok: false, refusal: "the credential request body must carry a jti of 8 to 128 characters" };
  }
  return { ok: true, jti };
}

export function parseCredentialRequest(
  body: string
): { ok: true; namespace: string; jti: string } | { ok: false; refusal: string } {
  const json = parseJsonBody(body);
  if (!json.ok) return json;
  const record = json.parsed as { namespace?: unknown; jti?: unknown };
  if (typeof record?.namespace !== "string" || record.namespace.length === 0) {
    return { ok: false, refusal: "the credential request body must name a namespace" };
  }
  const jti = jtiOf(json.parsed);
  if (!jti.ok) return jti;
  return { ok: true, namespace: record.namespace, jti: jti.jti };
}

// What the score job receives: everything it needs to run `aws s3 sync` with no
// repo secret at all. The endpoint is included so the account id does not have
// to live in any repo either.
export interface HoldoutCredential {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  expires_in: number;
}

// The ONE call to the temp-access-credentials API, shared by the holdout and backup
// mints: object-read-only, one hour, one bucket, one prefix, derived from the named
// parent token. Both parents' secrets never leave the dashboard; the Worker holds
// only their ACCESS KEY IDS plus the API token that authorizes the mint, and those
// live outside AttemptEnv, the same structural withholding as the HOLDOUT binding.
async function mintScopedCredential(
  env: Env,
  scope: { bucket: string; prefix: string; parentAccessKeyId: string }
): Promise<{ ok: true; credential: HoldoutCredential } | { ok: false; status: number; refusal: string }> {
  const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.R2_ACCOUNT_ID}/r2/temp-access-credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.R2_TEMP_CRED_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket: scope.bucket,
      parentAccessKeyId: scope.parentAccessKeyId,
      permission: "object-read-only",
      ttlSeconds: HOLDOUT_CREDENTIAL_TTL_SECONDS,
      prefixes: [scope.prefix],
    }),
  });
  if (!resp.ok) {
    return { ok: false, status: 502, refusal: `the temp-access-credentials API answered ${resp.status}: ${(await resp.text()).slice(0, 300)}` };
  }
  const data = (await resp.json()) as { result?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } };
  const minted = data.result;
  if (!minted?.accessKeyId || !minted.secretAccessKey || !minted.sessionToken) {
    return { ok: false, status: 502, refusal: "the temp-access-credentials API answered without the three credential fields" };
  }
  return {
    ok: true,
    credential: {
      access_key_id: minted.accessKeyId,
      secret_access_key: minted.secretAccessKey,
      session_token: minted.sessionToken,
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      bucket: scope.bucket,
      prefix: scope.prefix,
      expires_in: HOLDOUT_CREDENTIAL_TTL_SECONDS,
    },
  };
}

// Mint a one-hour, object-read-only credential scoped to ONE namespace's
// holdout prefix.
export async function mintHoldoutCredential(
  env: Env,
  namespace: string
): Promise<{ ok: true; credential: HoldoutCredential } | { ok: false; status: number; refusal: string }> {
  if (!env.R2_TEMP_CRED_TOKEN || !env.R2_TEMP_CRED_PARENT_ACCESS_KEY_ID || !env.R2_ACCOUNT_ID) {
    return {
      ok: false,
      status: 503,
      refusal:
        "holdout credential minting is not configured. Set R2_TEMP_CRED_TOKEN, R2_TEMP_CRED_PARENT_ACCESS_KEY_ID and R2_ACCOUNT_ID with wrangler secret put.",
    };
  }
  return mintScopedCredential(env, {
    bucket: HOLDOUT_BUCKET_NAME,
    prefix: `${HOLDOUT_PREFIX}${namespace}/`,
    parentAccessKeyId: env.R2_TEMP_CRED_PARENT_ACCESS_KEY_ID,
  });
}

// The backup dumps bucket, named here for the same reason as the holdout bucket
// name above: the temp-credential API scopes by name. It is bindings.mjs's R2
// pin; the two cannot drift without the off-account mirror going dark loudly.
export const BACKUP_BUCKET_NAME = "capsid-media";
export const BACKUP_DUMP_PREFIX = "backups/json/";

// Mint a one-hour, object-read-only credential scoped to the JSON dump prefix,
// derived from ITS OWN parent token (object-read-only on capsid-media): the
// holdout parent must not be able to read backups and vice versa.
export async function mintBackupCredential(
  env: Env
): Promise<{ ok: true; credential: HoldoutCredential } | { ok: false; status: number; refusal: string }> {
  if (!env.R2_TEMP_CRED_TOKEN || !env.R2_BACKUP_PARENT_ACCESS_KEY_ID || !env.R2_ACCOUNT_ID) {
    return {
      ok: false,
      status: 503,
      refusal:
        "backup credential minting is not configured. Set R2_TEMP_CRED_TOKEN, R2_BACKUP_PARENT_ACCESS_KEY_ID and R2_ACCOUNT_ID with wrangler secret put.",
    };
  }
  return mintScopedCredential(env, {
    bucket: BACKUP_BUCKET_NAME,
    prefix: BACKUP_DUMP_PREFIX,
    parentAccessKeyId: env.R2_BACKUP_PARENT_ACCESS_KEY_ID,
  });
}

// What the backup mirror's request body must say: a jti so a captured request
// cannot be replayed inside the signature window. No namespace: the scope is
// fixed by the endpoint.
export function parseBackupCredentialRequest(body: string): { ok: true; jti: string } | { ok: false; refusal: string } {
  const json = parseJsonBody(body);
  if (!json.ok) return json;
  return jtiOf(json.parsed);
}

// The backup mirror's request, verified under the SAME rules as a score report
// (window both directions, timing-safe compare, refuse on anything missing) but
// against the backup-specific derived key, so no roster repo's score key opens
// this and this key opens nothing on the improve side.
export async function verifyBackupCredentialRequest(
  env: Pick<Env, "IMPROVE_SCORE_SECRET">,
  signed: { timestamp: string; signature: string; body: string },
  now: Date
): Promise<{ ok: true } | { ok: false; status: number; refusal: string }> {
  return verifyHmac(env, signed, now, {
    deriveKey: deriveBackupCredentialKey,
    missingSecret: "backup credentials are not configured: IMPROVE_SCORE_SECRET is unset",
    badSig: "backup credential signature does not verify",
    ageNoun: "request",
  });
}
