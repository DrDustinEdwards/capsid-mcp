import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// GROUP 7 (dependencies). Two runtime deps with a thin publisher surface are
// exact-pinned so a compromised patch release cannot ride a caret into the
// bundle unattended. Renovate still proposes bumps as reviewable PRs (ruling 33,
// the portfolio's shared renovate-config); the pin only removes the silent path.
// This guard fails if a caret or tilde creeps back onto either.

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));

for (const name of ["agents", "zod"]) {
  test(`${name} is exact-pinned, not a range`, () => {
    const spec = pkg.dependencies[name];
    assert.ok(spec, `${name} is no longer a dependency`);
    assert.match(spec, /^\d+\.\d+\.\d+$/, `${name} is "${spec}"; a thin-surface runtime dep must be exact-pinned, not a caret/tilde range`);
  });
}

test("wrangler stays exact-pinned at the v5-peer wall", () => {
  // Not a group 7 change, but the reason npm audit fix could not --force here:
  // moving wrangler off 4.107.0 pulls workers-types v5, which collides with the
  // v4 that agents 0.17.3 hard-pins. Guarded so a future range bump is a decision.
  assert.match(pkg.devDependencies.wrangler, /^\d+\.\d+\.\d+$/, "wrangler is no longer exact-pinned");
});
