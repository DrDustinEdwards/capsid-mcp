import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LINT_DESCRIPTION } from "../src/tools/lint.ts";
import { buildTruthReport } from "../src/truth-report.ts";

// THE TOOL DESCRIPTION IS DERIVED FROM THE REPORT, NOT RETYPED BESIDE IT.
//
// `lint`'s description told every connected client that mode 'report' measures
// "documents by type, contradictions, stale decisions, unbound specs, broken links,
// and doc-vs-code drift". Six items, five of them checks: `documents by type` is a
// count reported beside the checks, and `unconsolidated` was missing. docs/schema.md
// carried the same list, copied from here.
//
// A description that miscounts what sits beside it is the defect the count lint
// exists for, so it gets the same treatment: the list is DERIVED from a real
// buildTruthReport response rather than compared against a second copy of the
// names. That is why the description spells the ids as the response spells them.
// A paraphrase cannot be derived from anything, which is how this drifted.

// The report over an empty store. Every check is pushed whatever the input holds,
// so this is the full id list; `repoPaths: undefined` is the drift check's NOT RUN
// branch, which still pushes. Asserted non-empty below, because a build that
// returned no checks would make the loop pass by reading nothing.
function reportedCheckIds(): string[] {
  const report = buildTruthReport({
    namespace: "sample",
    now: new Date("2026-09-12T00:00:00Z"),
    docs: [],
    edges: [],
    danglingEdges: [],
    countClaims: [],
  });
  return report.checks.map((c) => c.check);
}

test("the report pushes every check whatever the input holds", () => {
  const ids = reportedCheckIds();
  assert.ok(ids.length >= 6, `buildTruthReport returned only ${ids.length} checks: ${ids.join(", ")}`);
  assert.equal(new Set(ids).size, ids.length, `duplicate check id: ${ids.join(", ")}`);
});

test("DERIVED: the lint description names every check the report returns", () => {
  for (const id of reportedCheckIds()) {
    assert.ok(
      LINT_DESCRIPTION.includes(`\`${id}\``),
      `the lint tool description never names the \`${id}\` check, so a client reading it is told about a report that does not exist`
    );
  }
});

test("DERIVED: the lint description states the number of checks the report runs", () => {
  const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const count = reportedCheckIds().length;
  const expected = words[count - 1];
  assert.ok(expected, `no count word for ${count} checks`);
  assert.match(
    LINT_DESCRIPTION,
    new RegExp(`\\b${expected} checks\\b`, "i"),
    `the description never says "${expected} checks" and the report runs ${count}`
  );
  for (const [i, word] of words.entries()) {
    if (i === count - 1) continue;
    assert.doesNotMatch(
      LINT_DESCRIPTION,
      new RegExp(`\\b${word} checks\\b`, "i"),
      `the description says "${word} checks" and the report runs ${count}`
    );
  }
});

test("documents by type is not described as one of the checks", () => {
  // The original defect, pinned by name. by_type is on the response and is a count,
  // so the description may mention it; what it may not do is list it among the
  // checks, which is how a reader learns to expect a check id that never arrives.
  assert.ok(
    !reportedCheckIds().includes("by_type"),
    "by_type is a check now; this test and the description both need rewriting"
  );
  assert.match(
    LINT_DESCRIPTION,
    /documents by type, which is reported beside the checks rather than being one of them/,
    "the description no longer says where documents-by-type sits, which is the sentence that stops it being read as a check"
  );
});

// The registration must actually use the exported constant, or the constant is a
// second copy that agrees with nothing. Read from source: registerLintTools needs a
// live McpServer to call, and this is one string.
test("the registration uses the exported description", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "tools", "lint.ts"), "utf8");
  assert.match(
    source,
    /description:\s*LINT_DESCRIPTION\s*,/,
    "src/tools/lint.ts no longer registers LINT_DESCRIPTION, so what clients see is not what this test checks"
  );
});
