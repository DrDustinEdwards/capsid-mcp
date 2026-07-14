import assert from "node:assert/strict";
import { test } from "node:test";
import { isAdminUser, operatorGrant, sha256Hex } from "../src/auth.ts";

const req = (key?: string) =>
  new Request("https://capsid.example/ops/mcp", {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });

test("single write key still grants write (backwards compatible)", async () => {
  const env = { OPERATOR_KEY_HASH: await sha256Hex("full-key") };
  assert.equal(await operatorGrant(req("full-key"), env), "write");
});

test("ro: entry grants read only", async () => {
  const env = { OPERATOR_KEY_HASH: `ro:${await sha256Hex("agent-key")}` };
  assert.equal(await operatorGrant(req("agent-key"), env), "read");
});

test("comma-separated list resolves each key to its own grant", async () => {
  const env = {
    OPERATOR_KEY_HASH: `${await sha256Hex("full-key")}, ro:${await sha256Hex("agent-key")}`,
  };
  assert.equal(await operatorGrant(req("full-key"), env), "write");
  assert.equal(await operatorGrant(req("agent-key"), env), "read");
});

test("removing a hash revokes that key without touching the others", async () => {
  const env = { OPERATOR_KEY_HASH: await sha256Hex("full-key") };
  assert.equal(await operatorGrant(req("agent-key"), env), null);
  assert.equal(await operatorGrant(req("full-key"), env), "write");
});

test("uppercase hashes and stray whitespace in the secret still match", async () => {
  const env = {
    OPERATOR_KEY_HASH: ` ${(await sha256Hex("full-key")).toUpperCase()} ,, RO:${await sha256Hex("agent-key")} `,
  };
  assert.equal(await operatorGrant(req("full-key"), env), "write");
  assert.equal(await operatorGrant(req("agent-key"), env), "read");
});

test("missing header, non-bearer auth, or empty secret all deny", async () => {
  const env = { OPERATOR_KEY_HASH: await sha256Hex("full-key") };
  assert.equal(await operatorGrant(req(), env), null);
  assert.equal(
    await operatorGrant(
      new Request("https://capsid.example/ops/mcp", { headers: { Authorization: "Basic abc" } }),
      env
    ),
    null
  );
  assert.equal(await operatorGrant(req("full-key"), { OPERATOR_KEY_HASH: "" }), null);
});

test("a raw key pasted as the secret never matches (hashes only)", async () => {
  const env = { OPERATOR_KEY_HASH: "full-key" };
  assert.equal(await operatorGrant(req("full-key"), env), null);
});

test("isAdminUser matches login case-insensitively and numeric ids exactly", () => {
  assert.equal(isAdminUser({ ADMIN_GITHUB_LOGIN: "DrDustinEdwards" }, { id: 1, login: "drdustinedwards" }), true);
  assert.equal(isAdminUser({ ADMIN_GITHUB_LOGIN: "12345" }, { id: 12345, login: "whoever" }), true);
  assert.equal(isAdminUser({ ADMIN_GITHUB_LOGIN: "12345" }, { id: 54321, login: "12345" }), false);
  assert.equal(isAdminUser({ ADMIN_GITHUB_LOGIN: "" }, { id: 1, login: "anyone" }), false);
});
