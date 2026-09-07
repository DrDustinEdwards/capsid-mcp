import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// CLOUDFLARE PLATFORM PINS (arc of 2026-09-06, from
// capsid/references/cloudflare-changes-2026-09.md). Each block guards one
// platform deadline or contract so a regression is a red test, not an outage
// discovered on the deadline day.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(dir: string, ext: RegExp): Array<{ path: string; text: string }> {
  return readdirSync(join(ROOT, dir))
    .filter((name) => ext.test(name))
    .map((name) => ({ path: `${dir}/${name}`, text: readFileSync(join(ROOT, dir, name), "utf8") }));
}

// ---- KV REST routes (legacy path dead 2026-10-15) ---------------------------

// Assembled, not written literally, so this file cannot trip its own guard.
const LEGACY_KV_ROUTE = ["workers", "namespaces"].join("/");

test(`no Cloudflare API call uses the legacy KV route /${LEGACY_KV_ROUTE}/ (dead 2026-10-15)`, () => {
  const everywhere = [
    ...filesUnder("scripts", /\.mjs$/),
    ...filesUnder("src", /\.ts$/),
    ...filesUnder(".github/workflows", /\.ya?ml$/),
    ...filesUnder("test", /\.ts$/).filter((f) => !f.path.endsWith("cloudflare-platform.test.ts")),
  ];
  for (const file of everywhere) {
    assert.ok(
      !file.text.includes(`/${LEGACY_KV_ROUTE}/`),
      `${file.path} uses the legacy KV namespace REST route, which stops working 2026-10-15; use /storage/kv/namespaces/`
    );
  }
});

// ---- compatibility date and toolchain pins -----------------------------------

test("wrangler.jsonc.example and bindings.mjs agree on the compatibility date", () => {
  const example = readFileSync(join(ROOT, "wrangler.jsonc.example"), "utf8");
  const inExample = /"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/.exec(example);
  assert.ok(inExample, "wrangler.jsonc.example no longer sets compatibility_date");
  const bindings = readFileSync(join(ROOT, "scripts", "bindings.mjs"), "utf8");
  const inBindings = /export const COMPATIBILITY_DATE = "(\d{4}-\d{2}-\d{2})"/.exec(bindings);
  assert.ok(inBindings, "scripts/bindings.mjs no longer exports COMPATIBILITY_DATE");
  assert.equal(inExample[1], inBindings[1], "the example and bindings.mjs disagree on the compatibility date");
  // The date must stay at or past nodejs_compat's default-on threshold, or the
  // explicit flag in the example stops being redundant and starts being load-bearing.
  assert.ok(inExample[1] >= "2026-08-04", `compatibility date ${inExample[1]} fell behind the nodejs_compat default threshold`);
});

test("wrangler is pinned EXACT, and outside the d1-migrations-list 7404 bug window", () => {
  // ^4.107.0 was the hazard: a caret can float a fresh install into 4.120-4.121,
  // whose `d1 migrations list` answers error 7404 for an existing bound DB, and
  // the drift assertion would then fail against a healthy database. Newer pins
  // are walled off differently: every wrangler >= 4.108 peers workers-types v5,
  // which agents -> partyserver hard-blocks at ^4 until the deferred MCP/types
  // migration (see capsid work-queue).
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
  const pin = pkg.devDependencies.wrangler;
  assert.match(pin, /^\d+\.\d+\.\d+$/, `wrangler is not pinned exact: "${pin}" can drift into the 7404 bug window`);
  const minor = Number(pin.split(".")[1]);
  assert.ok(!(minor === 120 || minor === 121), `wrangler ${pin} is inside the 4.120-4.121 d1 migrations list bug window`);
});

// ---- the per-invocation CPU ceiling ------------------------------------------

test("wrangler.jsonc.example and bindings.mjs agree on limits.cpu_ms", () => {
  // The example is what CI writes wrangler.jsonc from; bindings.mjs is what the
  // scripts read. Two spellings of one measured number (backup max 1390ms CPU
  // plus 50%), pinned textually (bindings.mjs is untyped .mjs) so a retune of
  // one cannot silently leave the other.
  const example = readFileSync(join(ROOT, "wrangler.jsonc.example"), "utf8");
  const inExample = /"limits":\s*\{\s*"cpu_ms":\s*(\d+)\s*\}/.exec(example);
  assert.ok(inExample, "wrangler.jsonc.example no longer sets limits.cpu_ms: the runaway guard is gone");
  const bindings = readFileSync(join(ROOT, "scripts", "bindings.mjs"), "utf8");
  const inBindings = /export const LIMITS = \{ cpu_ms: (\d+) \}/.exec(bindings);
  assert.ok(inBindings, "scripts/bindings.mjs no longer exports LIMITS.cpu_ms");
  assert.equal(Number(inExample[1]), Number(inBindings[1]), "wrangler.jsonc.example and scripts/bindings.mjs disagree on cpu_ms");
  // Sanity floor: the ceiling must clear the largest measured invocation (the
  // 1390ms backup) or the guard kills the backup it exists to protect.
  assert.ok(Number(inBindings[1]) >= 1390 * 1.5, `cpu_ms ${inBindings[1]} is under the measured backup ceiling plus headroom`);
});

test("the two KV REST call sites exist and use /storage/kv/namespaces/", () => {
  // The guard above would pass vacuously if the canary and the reaper stopped
  // calling the REST API at all; this pins that they still do, on the new route.
  for (const name of ["verify-live.mjs", "reap-probe-clients.mjs"]) {
    const text = readFileSync(join(ROOT, "scripts", name), "utf8");
    assert.match(
      text,
      /storage\/kv\/namespaces/,
      `scripts/${name} no longer reaches KV over REST on the replacement route; if the call moved, move this pin with it`
    );
  }
});
