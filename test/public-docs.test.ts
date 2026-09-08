import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { improveControl } from "../src/improve-run.ts";
import { sha256Hex } from "../src/auth.ts";
import { operatorIdentity } from "../src/auth.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";

// THE PUBLIC DOCS, AND THE ONE THING THAT MUST NEVER BE IN THEM.
//
// docs/ exists so a stranger can understand this system from the repository
// alone. That makes it the one directory in a public MIT repo whose whole purpose
// is to describe a private store, which is exactly the shape that leaks something.
// These tests are the guard on that boundary: they assert the docs exist, cover
// what they claim to, and carry no real content, no secret, and no namespace
// inventory.

const ROOT = join(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");
const read = (name: string) => readFileSync(join(DOCS, name), "utf8");

test("the three public docs exist and are substantial", () => {
  const files = readdirSync(DOCS).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(files, ["bootstrap.md", "improve.md", "schema.md"]);
  for (const file of files) {
    assert.ok(read(file).length > 2000, `docs/${file} is too short to explain anything`);
  }
});

test("PLANT: no public doc carries a secret, a key or a real credential", () => {
  // The shapes that would actually matter. A hash is included because
  // OPERATOR_KEY_HASH is the verifier: publishing one is publishing the check.
  const forbidden: Array<[RegExp, string]> = [
    [/sk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic key"],
    [/ghp_[A-Za-z0-9]{20,}/, "a GitHub token"],
    [/github_pat_[A-Za-z0-9_]{20,}/, "a GitHub fine-grained token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
    [/\bro:[0-9a-f]{32,}/, "a minted read-only operator key"],
    [/\b[0-9a-f]{64}\b/, "something shaped like a sha256 hash"],
  ];
  for (const file of readdirSync(DOCS).filter((f) => f.endsWith(".md"))) {
    const text = read(file);
    for (const [pattern, what] of forbidden) {
      assert.doesNotMatch(text, pattern, `docs/${file} contains ${what}`);
    }
  }
});

test("PLANT: no public doc carries private infrastructure identifiers", () => {
  // A Cloudflare resource id is not a secret, and it is also not something a
  // public doc needs. The example config carries placeholders for exactly this
  // reason; the docs should not undo that.
  for (const file of readdirSync(DOCS).filter((f) => f.endsWith(".md"))) {
    const text = read(file);
    assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/, `docs/${file} contains something shaped like a Cloudflare resource id`);
    // A UUID, which is what a D1 database id looks like.
    assert.doesNotMatch(
      text,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
      `docs/${file} contains a UUID`
    );
  }
});

test("the docs describe the model without naming the private inventory", () => {
  // The roster and the namespace list are the store's contents, not its model.
  // The improve doc says so about itself; this asserts it stayed true.
  const improve = read("improve.md");
  assert.match(improve, /redacted from the private canon/i);
  assert.match(improve, /off by default/i);
  assert.match(improve, /never merges/i);
  const schema = read("schema.md");
  assert.match(schema, /redacted from the private canon/i);
});

test("bootstrap names every binding the Worker actually declares", () => {
  // Derived from src/env.ts rather than listed, so a binding added to the Worker
  // and not to the setup guide is a build failure. That is the whole failure mode
  // a bootstrap document has: it is right on the day it is written.
  const envSource = sourceFile("env.ts");
  const declared = [...envSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
  const bindings = declared.filter((name) => ["DB", "APP_KV", "OAUTH_KV", "MEDIA", "HOLDOUT"].includes(name));
  assert.equal(bindings.length, 5, `expected the five bindings in src/env.ts, found ${bindings.join(", ")}`);
  const bootstrap = read("bootstrap.md");
  for (const binding of bindings) {
    assert.match(bootstrap, new RegExp(`\`${binding}\``), `docs/bootstrap.md does not name the ${binding} binding`);
  }
});

test("bootstrap names every secret the Worker reads", () => {
  const envSource = sourceFile("env.ts");
  const secrets = ["GITHUB_APP_PRIVATE_KEY", "GITHUB_CLIENT_SECRET", "OPERATOR_KEY_HASH", "IMPROVE_SCORE_SECRET", "ANTHROPIC_API_KEY"];
  const bootstrap = read("bootstrap.md");
  for (const secret of secrets) {
    assert.ok(envSource.includes(secret), `${secret} is no longer read by src/env.ts; the bootstrap doc is describing a ghost`);
    assert.ok(bootstrap.includes(secret), `docs/bootstrap.md does not name ${secret}`);
  }
});

// ---- the mint action --------------------------------------------------------

function mintEnv(existing?: string) {
  return fakeEnv({
    DB: fakeD1({}).db,
    APP_KV: fakeKv({}).kv,
    ...(existing === undefined ? {} : { OPERATOR_KEY_HASH: existing }),
  });
}

test("PLANT: mint_operator_key returns a READ-ONLY key, and the prefix is what makes it one", async () => {
  const result = await improveControl(mintEnv(""), "mint_operator_key", {});
  assert.equal(result.action, "mint_operator_key");
  if (result.action !== "mint_operator_key") return;
  assert.match(result.key, /^capsid_[0-9a-f]{64}$/, "32 bytes of entropy, and recognisable as one of ours");
  assert.equal(result.grant, "read-only");
  assert.equal(result.entry, `ro:${result.hash}`, "the tier lives on the LIST ENTRY, not on the key");

  // THE ASSERTION THAT MATTERS. The label on this response is a claim; resolving
  // the minted key through the real verifier is the check. Getting the prefix
  // backwards (onto the key instead of the entry) mints a WRITE key from a helper
  // whose whole purpose is the read-only tier, and every assertion above would
  // still pass.
  const request = new Request("https://capsid.test/ops/mcp", { headers: { Authorization: `Bearer ${result.key}` } });
  const identity = await operatorIdentity(request, { OPERATOR_KEY_HASH: result.entry });
  assert.equal(identity.grant, "read", "the minted key must resolve to the read-only tier through the real verifier");

  // And the negative: the same key listed WITHOUT the prefix is a write key, which
  // is what makes the prefix load-bearing rather than cosmetic.
  const asWrite = await operatorIdentity(request, { OPERATOR_KEY_HASH: result.hash });
  assert.equal(asWrite.grant, "write", "a bare hash entry is the write tier; that is the thing the prefix opts out of");
});

test("PLANT: the mint does not install the key, and says why", async () => {
  const before = "aa".repeat(32);
  const env = mintEnv(before);
  const result = await improveControl(env, "mint_operator_key", {});
  if (result.action !== "mint_operator_key") throw new Error("wrong action");

  // The secret is untouched. A Worker that can widen its own authorization list
  // does not have one, and every guard downstream of it inherits that.
  assert.equal(
    (env as unknown as { OPERATOR_KEY_HASH: string }).OPERATOR_KEY_HASH,
    before,
    "the mint must not modify OPERATOR_KEY_HASH itself"
  );
  assert.match(result.next_step, /does NOTHING until its hash is in OPERATOR_KEY_HASH/);
  assert.match(result.next_step, /widen its own authorization list/);
  assert.match(result.command, /wrangler secret put OPERATOR_KEY_HASH/);
  // The printed command carries the EXISTING hashes plus the new one, so pasting
  // it does not revoke every other key.
  assert.ok(result.command.includes(before), "the printed list must preserve the hashes already installed");
  assert.ok(result.command.includes(result.entry), "and add the new one, with its read-only prefix");
  assert.equal(result.already_listed, false);
});

test("PLANT: the key is returned once and never written anywhere the key could read", async () => {
  const { db, recorded } = fakeD1({});
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, OPERATOR_KEY_HASH: "" });
  const result = await improveControl(env, "mint_operator_key", {});
  if (result.action !== "mint_operator_key") throw new Error("wrong action");

  const written = recorded.map((r) => JSON.stringify(r.params)).join("\n");
  assert.ok(!written.includes(result.key), "the KEY reached a database row");
  // And not the hash either. OPERATOR_KEY_HASH is the verifier, so a hash in
  // audit_log would copy the verifier into a table this very key can read.
  assert.ok(!written.includes(result.hash), "the HASH reached a database row; that is the verifier");
  assert.ok(written.includes("operator-key-minted"), "the mint must still leave an audit row saying it happened");
  assert.ok(written.includes(result.hash.slice(0, 8)), "with a fingerprint, so two mints are distinguishable");
});

test("two mints are different keys", async () => {
  const a = await improveControl(mintEnv(""), "mint_operator_key", {});
  const b = await improveControl(mintEnv(""), "mint_operator_key", {});
  if (a.action !== "mint_operator_key" || b.action !== "mint_operator_key") throw new Error("wrong action");
  assert.notEqual(a.key, b.key);
  assert.equal(await sha256Hex(a.key), a.hash, "the reported hash is really the hash of the reported key");
});

test("the mint is a control action on the existing tool, not a new tool", () => {
  // Hard rule 1: the surface is 30 tools and stays small. A key mint is a control
  // verb on a tool that already has four of them, and adding a 31st tool for it
  // would need its own ruling.
  const server = sourceFile("server.ts");
  const registrations = [...server.matchAll(/server\.registerTool\(/g)];
  assert.equal(registrations.length, 30, `the surface moved to ${registrations.length} tools`);
  assert.match(server, /"mint_operator_key"/, "the action must be reachable from the tool schema");
});
