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
