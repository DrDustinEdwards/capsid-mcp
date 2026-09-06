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
