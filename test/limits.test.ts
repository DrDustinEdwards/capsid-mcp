import assert from "node:assert/strict";
import { test } from "node:test";
import { docPath, MAX_PATH, pathProblem } from "../src/limits.ts";
import { sourceFiles } from "./source-files.ts";

// src/limits.ts: the document path grammar and the input bounds.
//
// This file used to hold five unrelated subjects (quality audit 6.6): the path
// grammar, timingSafeEqual, the encoders, the REPORT_PREFIX dedupe and the
// confirmation wiring. It was named after one of them, so four of the five were
// findable only by reading it. They now live with the module they describe:
// timingSafeEqual in auth.test.ts, the encoders in encoding.test.ts, and the
// "one definition, imported rather than re-typed" guards in
// source-conventions.test.ts.

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

// src/limits.ts is where `bounded` and `docPath` are BUILT, so it is the one file
// that must contain a bare z.string(). Exempting it by name alone would hide a
// genuinely unbounded field declared there later, so the exemption is PINNED: the
// two definitional uses are named below, and a third one fails.
const BOUNDING_PRIMITIVES = [
  "export const docPath = z.string().superRefine",
  "export const bounded = (max: number) => z.string().max(max);",
];

const BARE_Z_STRING = /z\.string\(\)/;
const isComment = (line: string) => line.startsWith("//") || line.startsWith("*");

test("the bounding primitives are still exactly two, and still in limits.ts", () => {
  // The pin behind the exemption in the next test. A third bare z.string() in
  // limits.ts is not a primitive, it is an unbounded field, and it fails here.
  const limits = sourceFiles().find((f) => f.name === "limits.ts");
  assert.ok(limits, "src/limits.ts is gone");
  const uses = limits.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isComment(line) && BARE_Z_STRING.test(line));
  assert.equal(
    uses.length,
    BOUNDING_PRIMITIVES.length,
    `limits.ts has ${uses.length} bare z.string() uses: ${uses.join(" | ")}`
  );
  for (const primitive of BOUNDING_PRIMITIVES) {
    assert.ok(limits.text.includes(primitive), `the bounding primitive "${primitive}" is gone from limits.ts`);
  }
});

test("every tool argument is bounded: no bare z.string() anywhere in src/", () => {
  // Widened from server.ts to the whole directory (quality audit 1.1). An
  // unbounded field is unbounded wherever it is declared, and the day a tool
  // schema is written in another module a server.ts-only scan reports green over
  // a surface it never read.
  //
  // Widening it made the rule state itself for the first time. Scanning one file,
  // it never had to say what "bare z.string()" excludes; over the whole directory
  // it does, and the answer is: not a comment, and not the two primitives in
  // limits.ts that the rule is built out of. Both exclusions are guarded, the
  // second by the pin above, so neither can grow silently.
  const offenders = sourceFiles()
    .filter((f) => f.name !== "limits.ts")
    .flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
        .filter((l) => !isComment(l.text) && BARE_Z_STRING.test(l.text))
    );
  assert.deepEqual(
    offenders.map((o) => `src/${o.file}:${o.line} ${o.text}`),
    [],
    "an unbounded z.string() is back; use bounded(...) from src/limits.ts"
  );
  // Vacuity guards: the scan has to be looking at real schemas, and at the
  // grammar being wired up, or "no offenders" means "nothing was read".
  const all = sourceFiles().map((f) => f.text).join("\n");
  assert.ok(all.includes("bounded(MAX_BODY)"), "the scan matched nothing, so it proves nothing");
  assert.ok(all.split("docPath").length - 1 >= 8, "docPath is barely used, so the grammar is probably not wired up");
});
