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
const ENV_PERMITTED = ["  HOLDOUT: R2Bucket;", 'export type AttemptEnv = Omit<Env, "HOLDOUT">;'];

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

test("no source file hardcodes the bucket NAME either", () => {
  // The binding is what is withheld, but a module that reached the bucket by name
  // through some other path would be just as wrong, and would pass the binding
  // scan above.
  const offenders = sourceFiles()
    .filter((f) =>
      f.text
        .split("\n")
        .map((line) => line.trim())
        .some((line) => !isComment(line) && line.includes(BUCKET_NAME))
    )
    .map((f) => `src/${f.name}`);
  assert.deepEqual(offenders, [], "a source file hardcodes the holdout bucket name");
});

test("the attempt module takes AttemptEnv, and AttemptEnv omits the binding", () => {
  const env = sourceFile("env.ts");
  assert.match(env, /export type AttemptEnv = Omit<Env, "HOLDOUT">;/);
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
