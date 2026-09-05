import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deriveScoreKey } from "../src/improve-scorer.ts";
import { ROSTER } from "../src/improve-schema.ts";

// THE SCRIPT AND THE WORKER MUST DERIVE THE SAME KEY.
//
// scripts/improve-derive-key.mjs computes the repo secret; src/improve-scorer.ts
// verifies reports against it. Two implementations of one derivation is exactly the
// shape that drifts, and the drift would be silent until a report failed to verify
// at 03:00. So the two are compared here directly, by running the script.
//
// The script is a plain .mjs with no build step, deliberately: it cannot import the
// TypeScript module, so it restates the derivation string, and this test is what
// keeps the restatement honest.

const SCRIPT = join(import.meta.dirname, "..", "scripts", "improve-derive-key.mjs");
const ROOT = "a-test-root-secret";

// spawnSync rather than execFileSync, because BOTH streams are needed on BOTH
// paths. execFileSync returns stdout only and throws on a non-zero exit, so the
// success path had no stderr to assert against and the assertion about it passed
// over an empty string. Caught by this test failing for its own reason.
function run(namespace: string, env: Record<string, string | undefined> = {}): { stdout: string; status: number; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, namespace], {
    encoding: "utf8",
    env: { ...process.env, IMPROVE_SCORE_SECRET: ROOT, ...env },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

test("THE SCRIPT DERIVES EXACTLY WHAT THE WORKER VERIFIES, for every roster namespace", async () => {
  for (const namespace of ROSTER) {
    const result = run(namespace);
    assert.equal(result.status, 0, `the script failed for ${namespace}: ${result.stderr}`);
    assert.equal(
      result.stdout.trim(),
      await deriveScoreKey(ROOT, namespace),
      `the script and src/improve-scorer.ts disagree for ${namespace}`
    );
  }
});

test("stdout is JUST the key, so it can be piped straight into gh secret set", () => {
  const result = run("capsid");
  assert.match(result.stdout, /^[0-9a-f]{64}\n$/, `stdout was not a bare key: ${JSON.stringify(result.stdout)}`);
  // Everything explanatory goes to stderr, which is why stdout stays pipeable.
  assert.match(result.stderr, /Set it as the repo secret IMPROVE_SCORE_KEY/);
});

test("IT NEVER PRINTS THE ROOT SECRET, on any path", () => {
  for (const args of [["capsid"], ["not-a-namespace"], [""]]) {
    const result = run(args[0]);
    assert.equal(result.stdout.includes(ROOT), false, "the root secret reached stdout");
    assert.equal(result.stderr.includes(ROOT), false, "the root secret reached stderr");
  }
});

test("an off-roster namespace is refused, so a secret cannot be set on the wrong repo", () => {
  const result = run("julieedwards");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not on the improve roster/);
  assert.equal(result.stdout.trim(), "");
});

test("a missing root secret is refused, and says there is no way to read one back", () => {
  const result = run("capsid", { IMPROVE_SCORE_SECRET: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IMPROVE_SCORE_SECRET is not set/);
  assert.match(result.stderr, /no way to read a Worker secret back/);
});

test("THE ROSTER IN THE SCRIPT MATCHES THE ROSTER IN SOURCE", () => {
  // The script cannot import the TypeScript module, so it restates the list. Two
  // copies of a list is the drift class this repo keeps ruling against, and here
  // the drift would refuse a legitimate namespace rather than admit an illegitimate
  // one, which is the safe direction but still wrong.
  const script = readFileSync(SCRIPT, "utf8");
  const declared = /const ROSTER = \[([^\]]+)\]/.exec(script);
  assert.ok(declared, "scripts/improve-derive-key.mjs no longer declares a ROSTER");
  const inScript = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(inScript, [...ROSTER].sort());
});

test("the derivation carries a VERSION segment, so every key can be rotated at once", () => {
  // Rotating all five derived keys without changing the root secret is then a
  // one-character change rather than a new secret and five re-pastes.
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /capsid-improve-score:v1:/);
});
