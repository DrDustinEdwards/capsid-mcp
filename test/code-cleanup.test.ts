import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSourceFiles, sourceFiles } from "./source-files.ts";

// GROUP 6 (code). Two cleanups made enforceable.
//
// (a) The anchor-pin KV key had four spellings of the same literal; improve-schema
//     owns the constant anchorKey() and every other site now calls it. This guard
//     fails if a raw `improve:anchor:` literal reappears anywhere but the constant.
// (b) The source walk is recursive, so a tool moved into a src/ subdirectory
//     cannot hide from the guards that read through it. This proves the recursion
//     against a fixture tree, so it does not depend on src/ actually being nested.

test("the anchor KV key literal lives only in the improve-schema constant", () => {
  const offenders = sourceFiles()
    .filter((f) => f.name !== "improve-schema.ts")
    .filter((f) => f.text.includes("improve:anchor:"))
    .map((f) => `src/${f.name}`);
  assert.deepEqual(offenders, [], `these files inline the anchor key instead of calling anchorKey(): ${offenders.join(", ")}`);
  // And the constant is genuinely there, so the guard is not passing because the
  // key was renamed out from under it.
  assert.ok(sourceFiles().some((f) => f.name === "improve-schema.ts" && /anchorKey = /.test(f.text)));
});

test("the write-integrity core lives in store-guards.ts, and server.ts imports it", () => {
  const guards = sourceFiles().find((f) => f.name === "store-guards.ts");
  assert.ok(guards, "src/store-guards.ts is missing; the write-integrity core was not extracted");
  // The commit protocol and its guards are defined there.
  for (const symbol of ["export function guardedCommit", "export function requireExists", "export function requireBodyUnchanged", "export function isMissingRowAbort"]) {
    assert.ok(guards.text.includes(symbol), `store-guards.ts no longer defines ${symbol}`);
  }
  // server.ts imports them rather than redefining them: a redefinition would give
  // the store two commit protocols that could drift.
  const server = sourceFiles().find((f) => f.name === "server.ts")!.text;
  assert.match(server, /import \{[^}]*guardedCommit[^}]*\} from "\.\/store-guards"/, "server.ts does not import the extracted core");
  assert.doesNotMatch(server, /function guardedCommit\(/, "server.ts redefines guardedCommit instead of importing it");
});

test("the source walk descends into subdirectories", () => {
  const root = mkdtempSync(join(tmpdir(), "srcwalk-"));
  try {
    writeFileSync(join(root, "top.ts"), "export const a = 1;");
    writeFileSync(join(root, "notes.md"), "ignored");
    mkdirSync(join(root, "tools"));
    writeFileSync(join(root, "tools", "nested.ts"), "export const b = 2;");
    mkdirSync(join(root, "tools", "deep"));
    writeFileSync(join(root, "tools", "deep", "deeper.ts"), "export const c = 3;");

    const found = collectSourceFiles(root);
    const names = found.map((f) => f.name);
    // A top-level file keeps its basename; nested files are addressable by path.
    assert.deepEqual(names, ["tools/deep/deeper.ts", "tools/nested.ts", "top.ts"]);
    // Non-.ts files are not collected.
    assert.ok(!names.includes("notes.md"));
    // The text comes back with the file, so a nested guard target is scannable.
    assert.equal(found.find((f) => f.name === "tools/nested.ts")?.text, "export const b = 2;");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
