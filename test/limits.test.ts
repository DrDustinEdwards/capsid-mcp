import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { timingSafeEqual } from "../src/auth.ts";
import { b64urlDecode, b64urlEncode, base64Decode, base64Encode, bytesToHex } from "../src/encoding.ts";
import { REPORT_PREFIX } from "../src/headers.ts";
import { docPath, MAX_PATH, pathProblem } from "../src/limits.ts";

const src = (name: string) => readFileSync(join(import.meta.dirname, "..", "src", name), "utf8");

// ---- the document path grammar (F29) ----------------------------------------

test("the grammar accepts the paths the store actually holds", () => {
  // Shapes measured in the live store on 2026-08-17, including the longest path
  // (83 chars) and the archive/ prefix that 219 of 536 documents carry.
  for (const path of [
    "core.md",
    "conventions.md",
    "archive/session-2026-08-11-foxhound-ci-migrations-turnstile-and-the-staging-name.md",
    "recova/parity/INVENTORY-SEED.md",
    "a.md",
  ]) {
    assert.equal(pathProblem(path), null, `${path} was rejected`);
  }
});

test("the grammar refuses traversal, absolutes, control characters and empties", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /must not be empty/],
    ["/etc/passwd", /must not start/],
    ["notes/", /must not end/],
    ["../secrets.md", /must not contain '\.\.'/],
    ["a/../../b.md", /must not contain '\.\.'/],
    ["a//b.md", /empty segment/],
    ["a\nb.md", /control characters/],
    ["a\tb.md", /control characters/],
    [`a${String.fromCharCode(0)}b.md`, /control characters/],
    [`a${String.fromCharCode(127)}b.md`, /control characters/],
    [`${"x".repeat(MAX_PATH + 1)}.md`, /longer than/],
  ];
  for (const [path, expected] of cases) {
    const problem = pathProblem(path);
    assert.ok(problem, `${JSON.stringify(path)} was accepted`);
    assert.match(problem, expected);
  }
});

test("the zod schema carries the same grammar, with the reason", () => {
  // The schema and the function must not be able to disagree: every tool argument
  // goes through the schema, and only the function is unit-testable.
  assert.equal(docPath.safeParse("archive/note.md").success, true);
  const bad = docPath.safeParse("../escape.md");
  assert.equal(bad.success, false);
  assert.match(bad.error?.issues[0]?.message ?? "", /must not contain '\.\.'/);
});

test("every tool argument is bounded: no bare z.string() in the tool surface", () => {
  // The self-enforcing half. A NEW unbounded field is the thing this catches; the
  // fields fixed today are already fixed.
  const server = src("server.ts");
  const bare = server.split("\n").filter((line) => /z\.string\(\)/.test(line));
  assert.deepEqual(bare, [], "an unbounded z.string() is back in src/server.ts; use bounded(...) from src/limits.ts");
  // And the guard is not vacuous: the file must still contain schemas to check.
  assert.ok(server.includes("bounded(MAX_BODY)"), "the scan matched nothing, so it proves nothing");
  assert.ok(server.split("docPath").length - 1 >= 8, "docPath is barely used, so the grammar is probably not wired up");
});

// ---- constant-time compares (F1) --------------------------------------------

test("timingSafeEqual accumulates rather than short-circuiting", () => {
  // The behavioural test below pins the ANSWER, and an implementation of
  // `return a === b` would give the same answers. The property that matters here
  // is not observable from outside the function and timing assertions in a unit
  // test are flaky, so the shape is what gets guarded: a running xor over every
  // character, with no early return inside the loop.
  const auth = src("auth.ts");
  const body = auth.slice(auth.indexOf("export function timingSafeEqual"), auth.indexOf("export function isAdminUser"));
  assert.match(body, /diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/, "timingSafeEqual no longer accumulates");
  assert.doesNotMatch(body, /return a === b/, "timingSafeEqual short-circuits on ===");
});

test("timingSafeEqual agrees with === on the answer", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
  assert.equal(timingSafeEqual("", ""), true);
  // The first character differing must not be distinguishable by early return:
  // both of these compare the whole string.
  assert.equal(timingSafeEqual("zzz", "azz"), false);
  assert.equal(timingSafeEqual("azz", "azy"), false);
});

test("the secret compares go through timingSafeEqual, not ===", () => {
  // Shape check across both files, so a NEW compare of a secret is visible.
  const auth = src("auth.ts");
  const handler = src("github-handler.ts");
  assert.ok(auth.includes("timingSafeEqual(readonly ? entry.slice(3) : entry, hash)"));
  assert.match(handler, /timingSafeEqual\(sig, await hmacHex/);
  assert.match(handler, /timingSafeEqual\(csrfCookie, csrf\)/);
  assert.match(handler, /timingSafeEqual\(stateCookie, await sha256Hex/);
  for (const [name, text] of [
    ["auth.ts", auth],
    ["github-handler.ts", handler],
  ] as const) {
    assert.doesNotMatch(text, /!== *\(await hmacHex/, `${name} still compares an hmac with !==`);
    assert.doesNotMatch(text, /csrfCookie !== csrf/, `${name} still compares csrf with !==`);
  }
});

// ---- deduped helpers (F21, F22, F23) ----------------------------------------

test("one REPORT_PREFIX, imported by both the sink and the prune", () => {
  const backup = src("backup.ts");
  const handler = src("github-handler.ts");
  assert.equal(REPORT_PREFIX, "reports/csp/");
  for (const [name, text] of [
    ["backup.ts", backup],
    ["github-handler.ts", handler],
  ] as const) {
    assert.match(text, /from "\.\/headers"/, `${name} does not import the shared prefix`);
    assert.doesNotMatch(text, /= "reports\/csp\/"/, `${name} still defines its own report prefix`);
  }
});

test("one base64 and hex implementation, imported rather than re-typed", () => {
  for (const name of ["github.ts", "github-handler.ts"]) {
    const text = src(name);
    assert.match(text, /from "\.\/encoding"/, `${name} does not use the shared encoders`);
    assert.doesNotMatch(text, /btoa\(binary\)/, `${name} carries its own base64url encoder`);
    assert.doesNotMatch(text, /toString\(16\)\.padStart\(2, "0"\)/, `${name} carries its own hex encoder`);
  }
  assert.doesNotMatch(src("auth.ts"), /toString\(16\)\.padStart\(2, "0"\)/);
});

test("the shared encoders round-trip, including non-ASCII and padding cases", () => {
  for (const text of ["", "a", "ab", "abc", "hello world", "café ✓ 中文"]) {
    assert.equal(b64urlDecode(b64urlEncode(text)), text, `b64url round-trip failed for ${text}`);
    assert.equal(base64Decode(base64Encode(text)), text, `base64 round-trip failed for ${text}`);
  }
  // url-safe alphabet, no padding: this is what the JWT and the cookie depend on.
  const encoded = b64urlEncode("??>>??>>");
  assert.doesNotMatch(encoded, /[+/=]/);
  // GitHub wraps its base64 across lines; atob rejects that without the strip.
  assert.equal(base64Decode("aGVsbG8g\nd29ybGQ="), "hello world");
  assert.equal(bytesToHex(new Uint8Array([0, 15, 16, 255])), "000f10ff");
});

// ---- one confirmation helper, and who uses it (F25) -------------------------

test("every destructive tool goes through the one confirmation helper", () => {
  const server = src("server.ts");
  // confirmDestructive is called from exactly one place now: the helper.
  const direct = server.split("await confirmDestructive(").length - 1;
  assert.equal(direct, 1, "a tool still calls confirmDestructive directly instead of requireConfirmation");
  // And the five destructive-class tools all reach it.
  for (const marker of ["refusal", "restoreRefusal", "deleteRefusal", "moveRefusal", "finalizeRefusal"]) {
    assert.ok(server.includes(`${marker} = await requireConfirmation(`), `${marker} is missing`);
  }
});

test("move and lint finalize accept a confirm argument", () => {
  const server = src("server.ts");
  assert.match(server, /path: docPath, new_path: docPath, confirm: z\.boolean\(\)\.optional\(\)/);
  assert.match(server, /consumed: z\.array\(docPath\)\.optional\(\),\s*\n\s*confirm: z\.boolean\(\)\.optional\(\)/);
});
