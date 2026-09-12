import assert from "node:assert/strict";
import { test } from "node:test";
import { signPolicyDocument } from "../src/policy-sign.ts";
import { splitSignedTask, verifySignedBody } from "../src/improve-task.ts";
import { loadMergePolicy, AUTO_MERGE_POLICY_PATH, POLICY_CHECKS } from "../src/auto-merge.ts";
import { sourceFile } from "./source-files.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// THE ONE THING THAT MINTS POLICY AUTHORITY. Before this, verifySignedBody had no
// counterpart that could produce what it verifies, so both policies were inert. The
// tests below are mostly refusals, because the value of a signer is entirely in what
// it declines to sign.

const SECRET = "test-improve-secret";

const POLICY_BODY = [
  "# Auto-merge policy",
  "",
  "- version: 1",
  "- enabled: false",
  "- namespaces: capsid",
  "",
  "## Checks",
  "",
  ...POLICY_CHECKS.map((c) => `- \`${c}\` refuses on its own.`),
  "",
].join("\n");

// The body the signer committed, read out of the documents upsert it recorded.
// documentUpsert binds (namespace, path, title, body, ...), so the body is params[3].
function signedBodyFrom(recorded: Array<{ sql: string; params: unknown[] }>): string {
  const upsert = recorded.find((r) => /INSERT INTO documents/i.test(r.sql));
  assert.ok(upsert, "the signer must write the document");
  return String(upsert.params[3]);
}

function envWith(documents: Array<{ namespace: string; path: string; title: string; body: string }>, secret = SECRET) {
  const fake = fakeD1({ documents });
  return { fake, env: fakeEnv({ DB: fake.db, IMPROVE_SCORE_SECRET: secret }) };
}

// ---- what it refuses to sign ----------------------------------------------------

test("sign_policy refuses a namespace other than capsid", async () => {
  const { env } = envWith([{ namespace: "foxhound", path: "policy/auto-merge.md", title: "p", body: POLICY_BODY }]);
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "foxhound", "policy/auto-merge.md");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /only signs documents in 'capsid'/);
});

test("sign_policy refuses any path outside policy/, including a traversal", async () => {
  const { env } = envWith([{ namespace: "capsid", path: "core.md", title: "core", body: "# core" }]);
  for (const path of ["core.md", "improve/scores.md", "decisions.md", "policy/../core.md"]) {
    const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", path);
    assert.equal(result.ok, false, `${path} must not be signable`);
  }
});

test("sign_policy refuses a document that does not exist", async () => {
  const { env } = envWith([]);
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /no document at capsid\/policy\/auto-merge\.md/);
});

test("sign_policy refuses an empty policy, which would otherwise be a valid signature over nothing", async () => {
  const { env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: "   \n\n" }]);
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /empty body/);
});

test("sign_policy refuses when the Worker has no signing secret", async () => {
  const { env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }], "");
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /signing is not configured/);
});

// ---- what it produces -----------------------------------------------------------

test("a signed policy verifies, and the same store then loads it", async () => {
  const { fake, env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }]);
  const result = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(result.ok && result.resigned, false, "a first signature is not a re-sign");
  assert.match(result.ok ? result.signature : "", /^[0-9a-f]{64}$/);

  // The fake does not apply upserts back onto its rows, so the bytes that were
  // written are read from the statement the signer committed rather than from the
  // table. That is the value under test either way: it is what would land in D1.
  const written = signedBodyFrom(fake.recorded);
  const verdict = await verifySignedBody(SECRET, written, "merge policy");
  assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);

  // The end of the chain the whole part exists for: the verifier that decides whether
  // a pull request may merge now accepts this document. Fed back in as the stored row.
  const { env: reloaded } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: written }]);
  const loaded = await loadMergePolicy(reloaded);
  assert.ok("policy" in loaded, `the signed policy must load: ${"error" in loaded ? loaded.error : ""}`);
  assert.equal(loaded.policy.version, "1");
  assert.equal(loaded.policy.enabled, false, "the shipped policy is disabled, and signing does not enable it");
});

test("signing an already-signed policy replaces the frontmatter rather than nesting it", async () => {
  const { fake, env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }]);
  const first = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(first.ok, true);
  const onceSigned = signedBodyFrom(fake.recorded);

  // The already-signed body fed back in, which is what a second call would read.
  const { fake: again, env: envAgain } = envWith([
    { namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: onceSigned },
  ]);
  const second = await signPolicyDocument(envAgain, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.resigned, true, "the second call must report that it replaced a signature");
  assert.equal(first.ok && second.ok ? second.signature : "", first.ok ? first.signature : "x", "the same bytes must sign the same way");

  const twiceSigned = signedBodyFrom(again.recorded);
  assert.equal(twiceSigned.split("capsid-task-signature").length - 1, 1, "a nested signature would leave two frontmatter lines");
  assert.equal(twiceSigned, onceSigned, "re-signing unchanged bytes is a no-op in content");
  assert.equal(splitSignedTask(twiceSigned).body, POLICY_BODY, "the signed body must be the original bytes, unchanged");
});

test("signing a tampered policy produces a signature for the tampered bytes, and the old one stops verifying", async () => {
  const { fake, env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }]);
  const first = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  const firstSignature = first.ok ? first.signature : "";

  const row = fake.rows.documents.find((d) => d.path === AUTO_MERGE_POLICY_PATH);
  assert.ok(row);
  row.body = String(row.body).replace("- enabled: false", "- enabled: true");
  const tampered = await verifySignedBody(SECRET, String(row.body), "merge policy");
  assert.equal(tampered.ok, false, "an edit after signing must stop verifying, or the signature means nothing");

  const second = await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);
  assert.equal(second.ok, true);
  assert.notEqual(second.ok ? second.signature : "", firstSignature, "different bytes must sign differently");
});

// ---- the write invariants -------------------------------------------------------

test("signing snapshots the prior body and writes an audit row, in one batch", async () => {
  const { fake, env } = envWith([{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "p", body: POLICY_BODY }]);
  await signPolicyDocument(env, "github:DrDustinEdwards", "capsid", AUTO_MERGE_POLICY_PATH);

  const sqls = fake.recorded.map((r) => r.sql.replace(/\s+/g, " "));
  assert.ok(
    sqls.some((s) => /INSERT INTO document_versions/i.test(s)),
    "an overwrite that does not snapshot is a write path that skips the invariant"
  );
  const audit = fake.recorded.find((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.ok(audit, "signing must be audit-logged");
  assert.equal(audit.params[1], "capsid");
  assert.equal(audit.params[2], AUTO_MERGE_POLICY_PATH);
  const params = JSON.parse(String(audit.params[3])) as Record<string, unknown>;
  assert.match(String(params.signature), /^[0-9a-f]{64}$/);
  assert.equal(params.resigned, false);
  assert.equal(
    typeof params.sha256,
    "string",
    "the audit row records which bytes were blessed, so a reader can check the document against the log"
  );
  assert.equal(Object.hasOwn(params, "body"), false, "the audit row must not copy the policy body");
  assert.equal(fake.batches.length, 1, "the snapshot, the write and the audit row go in together or not at all");
});

// ---- admin only -----------------------------------------------------------------

test("sign_policy is admin only at the tool layer, and says why", () => {
  const tool = sourceFile("tools/improve.ts");
  const guard = /if \(action === "sign_policy"\)[\s\S]*?\n        \}/.exec(tool);
  assert.ok(guard, "the sign_policy branch is gone from src/tools/improve.ts");
  assert.match(guard[0], /ctx\.agent\.admin/, "signing a policy must be gated on admin, not on the write grant");
  assert.match(guard[0], /widen itself/i, "the refusal should say why, not only that it refused");
});

test("the signer takes no body argument, so it cannot be used to sign arbitrary bytes", () => {
  const source = sourceFile("policy-sign.ts");
  const signature = /export async function signPolicyDocument\([\s\S]*?\): Promise/.exec(source);
  assert.ok(signature, "signPolicyDocument is gone from src/policy-sign.ts");
  assert.equal(/\bbody\s*:/.test(signature[0]), false, "a body parameter would make this an oracle for signing anything");
});
