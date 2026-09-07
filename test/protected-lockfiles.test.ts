import assert from "node:assert/strict";
import { test } from "node:test";
import { protectedHits, PROTECTED_PATH_PATTERNS } from "../src/improve-schema.ts";

// LOCKFILES THE SCORER INSTALLS FROM, audit 2026-09-07 (Opus CRITICAL 5.2, Grok
// MAJOR 4). Every path in EXECUTED_AT_INSTALL is refused by the path monitor at
// 257e625 for exactly one of them, package-lock.json. The rest were live: the
// scorer's install step is package-manager agnostic and installs from whichever
// lockfile it finds, so a lockfile an attempt can edit is arbitrary code
// execution inside the job that holds the signing key.
//
// The list is DERIVED FROM WHAT A PACKAGE MANAGER READS, not from the spellings
// that happen to exist in these five repos today, so a sixth repo on a different
// toolchain is covered before anyone notices it joined.

const EXECUTED_AT_INSTALL = [
  "package.json",
  "package-lock.json",
  // npm PREFERS this over package-lock.json, so its absence was a bypass of the
  // pattern beside it rather than a gap next to it.
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  "yarn.lock",
  ".yarnrc.yml",
  ".yarnrc",
  "bun.lockb",
  "deno.lock",
  ".npmrc",
  ".gitmodules",
];

const STEERS_THE_MEASURED_BUILD = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
  // foxing's Job A copies this into place before `wrangler types`, so it reaches
  // the measured build even though it is not itself the config.
  "wrangler.jsonc.example",
  "apps/web/wrangler.jsonc.example",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "Makefile",
  "scripts/build.sh",
];

test("PLANT: every lockfile a package manager reads is a protected path", () => {
  const unprotected = EXECUTED_AT_INSTALL.filter((p) => protectedHits([p]).length === 0);
  assert.deepEqual(
    unprotected,
    [],
    "an attempt editing any of these gets code execution in the job that holds IMPROVE_SCORE_KEY"
  );
});

test("PLANT: lockfiles are protected in a workspace subdirectory too", () => {
  // foxing is a pnpm workspace; a nested lockfile installs the same way.
  const nested = EXECUTED_AT_INSTALL.map((p) => `packages/core/${p}`);
  const unprotected = nested.filter((p) => protectedHits([p]).length === 0);
  assert.deepEqual(unprotected, [], "the patterns must anchor on a path segment, not on the repo root");
});

test("PLANT: config that steers the measured build is protected", () => {
  const unprotected = STEERS_THE_MEASURED_BUILD.filter((p) => protectedHits([p]).length === 0);
  assert.deepEqual(unprotected, []);
});

test("every protected hit names a reason a human can act on", () => {
  for (const path of [...EXECUTED_AT_INSTALL, ...STEERS_THE_MEASURED_BUILD]) {
    const [hit] = protectedHits([path]);
    assert.ok(hit, `${path} must hit`);
    assert.ok(hit.why.length > 8, `${path} must explain WHY, got '${hit.why}'`);
  }
});

test("the guard has not become a blanket refusal", () => {
  // If everything matches, nothing is measured. These are the ordinary files an
  // attempt is supposed to be able to change.
  const ordinary = [
    "src/links.ts",
    "src/normalize.ts",
    "app/routes/home.tsx",
    "packages/core/src/index.ts",
    "README.md",
    "docs/architecture.md",
    "public/favicon.svg",
    // Named to look like a lockfile without being one.
    "src/pnpm-lock-parser.ts",
    "src/package.json.d.ts",
    "notes/yarn.lock.md",
  ];
  const wrongly = ordinary.filter((p) => protectedHits([p]).length > 0);
  assert.deepEqual(wrongly, [], "these must stay editable or the loop has nothing to do");
});

test("the pattern list is shaped, not spelled: each entry is a regex with a reason", () => {
  for (const entry of PROTECTED_PATH_PATTERNS) {
    assert.ok(entry.pattern instanceof RegExp, "every entry is a RegExp");
    assert.ok(entry.pattern.flags.includes("i"), `${entry.pattern} must be case-insensitive`);
    assert.equal(typeof entry.why, "string");
  }
});
