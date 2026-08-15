import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_PREFIX } from "../src/headers.ts";
import { sourceFiles } from "./source-files.ts";

// ONE DEFINITION, IMPORTED. The conventions that are about the SHAPE of src/
// rather than the behaviour of any one module.
//
// Every guard here answers the same question: is this fact still stated once? Each
// was added after the same fact was found stated twice and the two copies had
// drifted or were about to. They were scattered through limits.test.ts under a
// name that described none of them (quality audit 6.6), and each scanned a
// hardcoded list of two or three files, which made the guard's scope a guess about
// where the next copy would be written (quality audit 1.1). They scan all of src/
// now, which is also what lets server.ts be split later without losing them.

test("one REPORT_PREFIX, and no file defines its own", () => {
  assert.equal(REPORT_PREFIX, "reports/csp/");
  const offenders = sourceFiles()
    .filter((f) => f.name !== "headers.ts")
    .filter((f) => /= "reports\/csp\//.test(f.text))
    .map((f) => `src/${f.name}`);
  assert.deepEqual(
    offenders,
    [],
    "these files define their own report prefix; intake and prune must agree or reports accumulate under a prefix nothing reaps"
  );
  // Both sides of the agreement still import it: the sink that writes and the
  // cron that prunes. A guard that only checked for duplicates would pass if both
  // sides simply stopped using the prefix.
  const importers = sourceFiles().filter((f) => /REPORT_PREFIX/.test(f.text) && f.name !== "headers.ts").map((f) => f.name);
  assert.ok(
    importers.includes("backup.ts") && importers.includes("routes.ts"),
    `expected both the prune and the sink to use REPORT_PREFIX, found: ${importers.join(", ")}`
  );
});

test("every secret compare goes through timingSafeEqual, in every file", () => {
  // The specific compares, still where they belong.
  const auth = sourceFiles().find((f) => f.name === "auth.ts")!.text;
  const handler = sourceFiles().find((f) => f.name === "routes.ts")!.text;
  assert.ok(auth.includes("timingSafeEqual(readonly ? entry.slice(3) : entry, hash)"));
  assert.match(handler, /timingSafeEqual\(sig, await hmacHex/);
  assert.match(handler, /timingSafeEqual\(csrfCookie, csrf\)/);
  assert.match(handler, /timingSafeEqual\(stateCookie, await sha256Hex/);

  // And no file anywhere has gone back to a short-circuiting compare of a secret.
  // Matched by SHAPE rather than by the three spellings that exist today, since a
  // fourth secret compared with !== is the thing this is here to catch.
  const offenders = sourceFiles().flatMap((f) =>
    f.text
      .split("\n")
      .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
      .filter((l) => /(!==|===)\s*(await\s+)?(hmacHex|sha256Hex)\(/.test(l.text) || /(csrfCookie|stateCookie|clientSecret)\s*(!==|===)/.test(l.text))
  );
  assert.deepEqual(
    offenders.map((o) => `src/${o.file}:${o.line} ${o.text}`),
    [],
    "a secret is compared with === or !== instead of timingSafeEqual"
  );
});

test("every destructive tool goes through the one confirmation helper", () => {
  const all = sourceFiles();
  // confirmDestructive is called from exactly one place: the helper.
  const direct = all.reduce((n, f) => n + (f.text.split("await confirmDestructive(").length - 1), 0);
  assert.equal(direct, 1, "a tool calls confirmDestructive directly instead of requireConfirmation");
  // And the five destructive-class tools all reach it, wherever they now live.
  const text = all.map((f) => f.text).join("\n");
  for (const marker of ["refusal", "restoreRefusal", "deleteRefusal", "moveRefusal", "finalizeRefusal"]) {
    assert.ok(text.includes(`${marker} = await requireConfirmation(`), `${marker} is missing`);
  }
});

test("move and lint finalize still accept a confirm argument", () => {
  const text = sourceFiles().map((f) => f.text).join("\n");
  assert.match(text, /path: docPath, new_path: docPath, confirm: z\.boolean\(\)\.optional\(\)/);
  assert.match(text, /consumed: z\.array\(docPath\)\.optional\(\),\s*\n\s*confirm: z\.boolean\(\)\.optional\(\)/);
});
