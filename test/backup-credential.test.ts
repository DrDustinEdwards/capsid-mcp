import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BACKUP_CREDENTIAL_PATH,
  deriveBackupCredentialKey,
  deriveScoreKey,
  mintBackupCredential,
  parseBackupCredentialRequest,
  verifyBackupCredentialRequest,
} from "../src/improve-scorer.ts";
import { ROSTER } from "../src/improve-schema.ts";
import { fakeEnv, withFetch } from "./fakes.ts";
import { sourceFile, sourceFiles } from "./source-files.ts";

// THE OFF-ACCOUNT BACKUP CREDENTIAL (session 3, group 1). The mirror job in the
// private capsid-backups repo holds no long-lived R2 secret: it signs a request
// with a BACKUP-SPECIFIC derived key and receives a one-hour object-read-only
// credential scoped to backups/json/ on capsid-media. Same envelope as the
// holdout credential, different key, different bucket, different parent token.

test("the backup credential key derives from the root with its own context, unequal to every score key", async () => {
  const root = "root-secret";
  const backup = await deriveBackupCredentialKey(root);
  assert.match(backup, /^[0-9a-f]{64}$/);
  assert.equal(backup, await deriveBackupCredentialKey(root), "derivation must be deterministic");
  for (const namespace of ROSTER) {
    assert.notEqual(backup, await deriveScoreKey(root, namespace), `the backup key collides with the ${namespace} score key`);
  }
});

test("the mint asks for object-read-only, one hour, backups/json/ on capsid-media, from the BACKUP parent", async () => {
  await withFetch(
    {
      "POST /client/v4/accounts/acct-1/r2/temp-access-credentials": (body: unknown) => {
        const request = body as Record<string, unknown>;
        assert.equal(request.bucket, "capsid-media");
        assert.equal(request.permission, "object-read-only");
        assert.equal(request.ttlSeconds, 3600);
        assert.equal(request.parentAccessKeyId, "backup-parent-key-id");
        assert.deepEqual(request.prefixes, ["backups/json/"]);
        return { body: { success: true, result: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" } } };
      },
    },
    async () => {
      const env = fakeEnv({
        R2_TEMP_CRED_TOKEN: "cf-api-token",
        R2_BACKUP_PARENT_ACCESS_KEY_ID: "backup-parent-key-id",
        R2_ACCOUNT_ID: "acct-1",
      });
      const minted = await mintBackupCredential(env);
      assert.ok(minted.ok, `mint refused: ${minted.ok ? "" : minted.refusal}`);
      assert.equal(minted.credential.bucket, "capsid-media");
      assert.equal(minted.credential.prefix, "backups/json/");
      assert.equal(minted.credential.endpoint, "https://acct-1.r2.cloudflarestorage.com");
      assert.equal(minted.credential.session_token, "ST");
    }
  );
});

test("an unconfigured backup mint is a clear 503 naming R2_BACKUP_PARENT_ACCESS_KEY_ID", async () => {
  await withFetch({}, async (calls) => {
    const minted = await mintBackupCredential(fakeEnv({ R2_TEMP_CRED_TOKEN: "t", R2_ACCOUNT_ID: "a" }));
    assert.equal(minted.ok, false);
    assert.equal(minted.ok ? 0 : minted.status, 503);
    assert.match(minted.ok ? "" : minted.refusal, /R2_BACKUP_PARENT_ACCESS_KEY_ID/);
    assert.equal(calls.length, 0);
  });
});

test("verification refuses a bad signature and admits a good one", async () => {
  const env = fakeEnv({ IMPROVE_SCORE_SECRET: "root-secret" });
  const now = new Date("2026-09-07T06:00:00Z");
  const timestamp = "2026-09-07T05:59:00Z";
  const body = JSON.stringify({ jti: "0123456789" });
  const key = await deriveBackupCredentialKey("root-secret");
  const { createHmac } = await import("node:crypto");
  const good = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");

  const bad = await verifyBackupCredentialRequest(env, { timestamp, signature: "0".repeat(64), body }, now);
  assert.equal(bad.ok, false);

  const ok = await verifyBackupCredentialRequest(env, { timestamp, signature: good, body }, now);
  assert.equal(ok.ok, true, `a correctly signed request was refused: ${ok.ok ? "" : ok.refusal}`);

  // A ROSTER key must not open the backup endpoint: the derivation contexts differ.
  const scoreKey = await deriveScoreKey("root-secret", "capsid");
  const cross = createHmac("sha256", scoreKey).update(`${timestamp}.${body}`).digest("hex");
  const refused = await verifyBackupCredentialRequest(env, { timestamp, signature: cross, body }, now);
  assert.equal(refused.ok, false, "a namespace score key signed its way into the backup credential");
});

test("a stale timestamp is refused in both directions", async () => {
  const env = fakeEnv({ IMPROVE_SCORE_SECRET: "root-secret" });
  const now = new Date("2026-09-07T06:00:00Z");
  const body = JSON.stringify({ jti: "0123456789" });
  const key = await deriveBackupCredentialKey("root-secret");
  const { createHmac } = await import("node:crypto");
  for (const timestamp of ["2026-09-07T04:00:00Z", "2026-09-07T08:00:00Z"]) {
    const sig = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
    const verdict = await verifyBackupCredentialRequest(env, { timestamp, signature: sig, body }, now);
    assert.equal(verdict.ok, false, `timestamp ${timestamp} was admitted against now=${now.toISOString()}`);
  }
});

test("the request body must carry a jti", () => {
  assert.equal(parseBackupCredentialRequest("not json").ok, false);
  assert.equal(parseBackupCredentialRequest(JSON.stringify({})).ok, false);
  assert.equal(parseBackupCredentialRequest(JSON.stringify({ jti: "short" })).ok, false);
  const good = parseBackupCredentialRequest(JSON.stringify({ jti: "0123456789" }));
  assert.ok(good.ok && good.jti === "0123456789");
});

test("ONLY src/improve-scorer.ts names the backup parent key id", () => {
  const offenders = sourceFiles()
    .filter((f) => f.name !== "improve-scorer.ts" && f.name !== "env.ts")
    .flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
        .filter((l) => !l.text.startsWith("//") && l.text.includes("R2_BACKUP_PARENT_ACCESS_KEY_ID"))
    );
  assert.deepEqual(offenders.map((o) => `src/${o.file}:${o.line}`), []);
  const env = sourceFile("env.ts");
  assert.match(env, /R2_BACKUP_PARENT_ACCESS_KEY_ID\?: string;/);
  assert.match(env, /"R2_BACKUP_PARENT_ACCESS_KEY_ID">/, "AttemptEnv no longer omits the backup parent key");
});

test("the endpoint path is wired into routes and the derive script offers the flag", () => {
  assert.equal(BACKUP_CREDENTIAL_PATH, "/backup/credential");
  const routes = sourceFile("routes.ts");
  assert.match(routes, /BACKUP_CREDENTIAL_PATH/, "routes.ts never serves the backup credential endpoint");
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "improve-derive-key.mjs"), "utf8");
  assert.match(script, /--backup-credential/, "the derive script cannot produce the backup credential key");
  assert.match(script, /capsid-backup-credential:v1/, "the script and the Worker disagree on the derivation context");
});
