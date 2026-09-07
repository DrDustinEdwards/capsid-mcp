import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HOLDOUT_PREFIX, holdoutManifestKey } from "../src/improve-schema.ts";
import { sourceFile, sourceFiles } from "./source-files.ts";

// THE HOLDOUT ISOLATION GUARD.
//
// The property: code that generates and pushes attempts must have no read path to
// the hidden test suite. It is enforced at three layers and this file asserts all
// three, because each can be defeated on its own.
//
//   infrastructure  a separate R2 bucket, so there is a binding to withhold
//   type            AttemptEnv is Omit<Env, "HOLDOUT">, so a reference will not compile
//   source scan     only src/improve-scorer.ts may name it (this file)
//
// A type can be cast away, a scan can be evaded by an alias, and a shared bucket
// would defeat both. Hence three.

const HOLDOUT_BINDING = "HOLDOUT";
const BUCKET_NAME = "capsid-improve-holdout";

// THE EXEMPTION IS PINNED TO ITS LINES, not granted by filename.
//
// src/env.ts has to name the binding: it declares the environment. Exempting the
// whole file would let a later field there reach for it, so the exact permitted
// occurrences are listed and a third one in that file fails. Same technique as
// the bounding-primitive pin in test/limits.test.ts.
const ENV_PERMITTED = [
  "  HOLDOUT: R2Bucket;",
  'export type AttemptEnv = Omit<Env, "HOLDOUT" | "R2_TEMP_CRED_TOKEN" | "R2_TEMP_CRED_PARENT_ACCESS_KEY_ID" | "R2_BACKUP_PARENT_ACCESS_KEY_ID">;',
];

// A COMMENT IS NOT A USE. Several modules explain this isolation at length, and
// naming the binding while doing so is the opposite of the problem. Same
// exclusion test/limits.test.ts applies to its bare-z.string() scan, and it is
// stated here rather than assumed because a scan that counted comments would be
// red on the day the isolation was best documented.
const isComment = (line: string) => line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");

test("ONLY src/improve-scorer.ts uses the holdout binding", () => {
  const offenders = sourceFiles()
    .filter((f) => f.name !== "improve-scorer.ts" && f.name !== "env.ts")
    .flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
        .filter((l) => !isComment(l.text) && new RegExp(`\\b${HOLDOUT_BINDING}\\b`).test(l.text))
    );
  assert.deepEqual(
    offenders.map((o) => `src/${o.file}:${o.line} ${o.text}`),
    [],
    "a module other than the scorer names the holdout binding. Attempt code must have no read path to the hidden suite."
  );
});

test("src/env.ts names it exactly twice, on the two pinned lines", () => {
  const env = sourceFile("env.ts");
  const uses = env
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => new RegExp(`\\b${HOLDOUT_BINDING}\\b`).test(line))
    // Comments explain the binding at length and are not uses of it.
    .filter((line) => !line.trim().startsWith("//"));
  assert.deepEqual(
    uses,
    ENV_PERMITTED,
    "src/env.ts's holdout occurrences moved. The exemption is pinned to these exact lines so a new field cannot widen it."
  );
});

test("the guard is NOT VACUOUS: the scorer really does use the binding", () => {
  // Without this the test above would pass by matching nothing the day the
  // subsystem stopped reading the manifest at all.
  const scorer = sourceFile("improve-scorer.ts");
  assert.match(scorer, /env\.HOLDOUT\.get\(/, "the scorer no longer reads the holdout bucket");
});

test("no source file hardcodes the bucket NAME either, except the scorer", () => {
  // The binding is what is withheld, but a module that reached the bucket by name
  // through some other path would be just as wrong, and would pass the binding
  // scan above. improve-scorer.ts is exempt since the platform arc (2026-09-06):
  // it already holds the binding, and the temp-access-credentials API it calls
  // scopes by bucket NAME, which therefore has to be spelled somewhere the
  // attempt path cannot reach.
  const offenders = sourceFiles()
    .filter((f) => f.name !== "improve-scorer.ts")
    .filter((f) =>
      f.text
        .split("\n")
        .map((line) => line.trim())
        .some((line) => !isComment(line) && line.includes(BUCKET_NAME))
    )
    .map((f) => `src/${f.name}`);
  assert.deepEqual(offenders, [], "a source file outside the scorer hardcodes the holdout bucket name");
});

test("the attempt module takes AttemptEnv, and AttemptEnv omits the binding", () => {
  const env = sourceFile("env.ts");
  assert.match(env, /export type AttemptEnv = Omit<Env, "HOLDOUT" \| "R2_TEMP_CRED_TOKEN" \| "R2_TEMP_CRED_PARENT_ACCESS_KEY_ID" \| "R2_BACKUP_PARENT_ACCESS_KEY_ID">;/);
  const attempt = sourceFile("improve-attempt.ts");
  assert.match(attempt, /import type \{ AttemptEnv \} from "\.\/env";/);
  // Both exported entry points take it. A helper that took Env would hand the
  // whole environment back to the attempt path through the side door.
  assert.match(attempt, /export async function proposeChange\(env: AttemptEnv,/);
  assert.match(attempt, /export async function pushAttempt\(\n?\s*env: AttemptEnv,/);
});

test("THE CI R2 READ TOKEN IS NOT IN THE WORKER'S ENVIRONMENT AT ALL", () => {
  // CI pulls the holdout tests with its own read-only R2 token, held as a repo
  // secret. If that token were also a Worker binding, the attempt path could read
  // the suite over the R2 API and every layer above would be decoration.
  const env = sourceFile("env.ts");
  for (const forbidden of ["R2_ACCESS_KEY", "R2_SECRET", "HOLDOUT_TOKEN", "R2_TOKEN"]) {
    assert.equal(env.includes(forbidden), false, `src/env.ts declares ${forbidden}; the R2 read token must live only in CI`);
  }
});

test("the two buckets are pinned to DIFFERENT buckets, and CI refuses if they converge", () => {
  const bindings = readFileSync(join(import.meta.dirname, "..", "scripts", "bindings.mjs"), "utf8");
  const media = /export const R2 = \{ name: "([^"]+)" \}/.exec(bindings)?.[1];
  const holdout = /export const HOLDOUT_R2 = \{ name: "([^"]+)" \}/.exec(bindings)?.[1];
  assert.ok(media, "the MEDIA bucket pin is gone from scripts/bindings.mjs");
  assert.ok(holdout, "the HOLDOUT bucket pin is gone from scripts/bindings.mjs");
  assert.notEqual(media, holdout, "MEDIA and HOLDOUT are pinned to the same bucket, which undoes the isolation");

  // And the deploy asserts it, so a later edit that converges them cannot ship.
  const ciConfig = readFileSync(join(import.meta.dirname, "..", "scripts", "ci-config.mjs"), "utf8");
  assert.match(ciConfig, /MEDIA and HOLDOUT are pinned to the SAME bucket/);
  assert.match(ciConfig, /EXPECTED\.r2\.name === EXPECTED\.holdoutR2\.name/);
});

test("wrangler.jsonc.example binds both buckets, with a placeholder for each", () => {
  const example = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc.example"), "utf8");
  assert.match(example, /"binding": "MEDIA"/);
  assert.match(example, /"binding": "HOLDOUT"/);
  assert.match(example, /YOUR_HOLDOUT_R2_BUCKET/);
});

test("the manifest key is namespaced under the holdout prefix", () => {
  assert.equal(holdoutManifestKey("foxing"), `${HOLDOUT_PREFIX}foxing/manifest.json`);
  // A namespace cannot read out of another's prefix by construction of the key.
  assert.ok(holdoutManifestKey("foxing").startsWith(`${HOLDOUT_PREFIX}foxing/`));
});

// ---- temporary credentials (platform arc 2026-09-06) ------------------------
//
// The score job no longer holds a long-lived S3 key: it asks the Worker for a
// one-hour object-read-only credential scoped to its own namespace's prefix.
// The mint needs two secrets, and those secrets are exactly as dangerous as the
// binding, so the same three-layer isolation applies: AttemptEnv omits them
// (asserted above), and this scan keeps them out of every module but the scorer.

const TEMP_CRED_SECRETS = ["R2_TEMP_CRED_TOKEN", "R2_TEMP_CRED_PARENT_ACCESS_KEY_ID"];

test("ONLY src/improve-scorer.ts names the temp-credential secrets", () => {
  const offenders = sourceFiles()
    .filter((f) => f.name !== "improve-scorer.ts" && f.name !== "env.ts")
    .flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
        .filter((l) => !isComment(l.text) && TEMP_CRED_SECRETS.some((s) => l.text.includes(s)))
    );
  assert.deepEqual(
    offenders.map((o) => `src/${o.file}:${o.line} ${o.text}`),
    [],
    "a module other than the scorer names a temp-credential secret. Attempt code must not be able to mint read access to the suite."
  );
});

test("the credential mint asks for object-read-only, one hour, this namespace's prefix only", async () => {
  const { mintHoldoutCredential } = await import("../src/improve-scorer.ts");
  const { fakeEnv, withFetch } = await import("./fakes.ts");
  await withFetch(
    {
      "POST /client/v4/accounts/acct-1/r2/temp-access-credentials": (body: unknown) => {
        const request = body as Record<string, unknown>;
        assert.equal(request.bucket, BUCKET_NAME);
        assert.equal(request.permission, "object-read-only");
        assert.equal(request.ttlSeconds, 3600);
        assert.equal(request.parentAccessKeyId, "parent-key-id");
        assert.deepEqual(request.prefixes, [`${HOLDOUT_PREFIX}foxing/`]);
        return { body: { success: true, result: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" } } };
      },
    },
    async () => {
      const env = fakeEnv({
        R2_TEMP_CRED_TOKEN: "cf-api-token",
        R2_TEMP_CRED_PARENT_ACCESS_KEY_ID: "parent-key-id",
        R2_ACCOUNT_ID: "acct-1",
      });
      const minted = await mintHoldoutCredential(env, "foxing");
      assert.ok(minted.ok, `mint refused: ${minted.ok ? "" : minted.refusal}`);
      assert.equal(minted.credential.access_key_id, "AK");
      assert.equal(minted.credential.session_token, "ST");
      assert.equal(minted.credential.endpoint, "https://acct-1.r2.cloudflarestorage.com");
      assert.equal(minted.credential.bucket, BUCKET_NAME);
      assert.equal(minted.credential.prefix, `${HOLDOUT_PREFIX}foxing/`);
    }
  );
});

test("an unconfigured mint is a clear 503, not a crash and not a wider credential", async () => {
  const { mintHoldoutCredential } = await import("../src/improve-scorer.ts");
  const { fakeEnv, withFetch } = await import("./fakes.ts");
  await withFetch({}, async (calls) => {
    const minted = await mintHoldoutCredential(fakeEnv({}), "foxing");
    assert.equal(minted.ok, false);
    assert.equal(minted.ok ? 0 : minted.status, 503);
    assert.match(minted.ok ? "" : minted.refusal, /wrangler secret put/);
    assert.equal(calls.length, 0, "an unconfigured mint still called the Cloudflare API");
  });
});

test("a credential request without a namespace or jti is refused at the parse", async () => {
  const { parseCredentialRequest } = await import("../src/improve-scorer.ts");
  assert.equal(parseCredentialRequest("not json").ok, false);
  assert.equal(parseCredentialRequest(JSON.stringify({ jti: "0123456789" })).ok, false);
  assert.equal(parseCredentialRequest(JSON.stringify({ namespace: "foxing" })).ok, false);
  assert.equal(parseCredentialRequest(JSON.stringify({ namespace: "foxing", jti: "short" })).ok, false);
  const good = parseCredentialRequest(JSON.stringify({ namespace: "foxing", jti: "0123456789" }));
  assert.ok(good.ok && good.namespace === "foxing");
});

test("the scorer workflow holds NO long-lived R2 secret and asks the Worker instead", () => {
  const yml = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "improve-score.yml"), "utf8");
  for (const secret of ["IMPROVE_HOLDOUT_R2_ACCESS_KEY_ID", "IMPROVE_HOLDOUT_R2_SECRET_ACCESS_KEY", "IMPROVE_HOLDOUT_R2_ACCOUNT_ID"]) {
    assert.ok(!yml.includes(secret), `improve-score.yml still references the long-lived repo secret ${secret}`);
  }
  assert.match(yml, /\/improve\/holdout-credential/, "the Pull step no longer asks the Worker for a temporary credential");
});
