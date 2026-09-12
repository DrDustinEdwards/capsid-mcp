import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SELF_REPO } from "../src/github.ts";
import { sourceFiles } from "./source-files.ts";

// THE REPO NAME, PINNED ONCE AND GUARDED EVERYWHERE ELSE.
//
// The repository was renamed from capsid-mcp to capsid on 2026-09-12. GitHub
// redirects the old URL, so nothing breaks loudly: a missed reference keeps
// working until the redirect is retired or the old name is taken by someone
// else. That is the failure this file exists to catch, because it is the kind
// nothing else reports.
//
// The value lives in exactly one place the tests assert, SELF_REPO. Every other
// test that needs the self repo imports it rather than spelling it out, which is
// the lesson self-repo-attempt.test.ts was written to record: a hardcoded copy
// of a constant drifts one word away from the real mapping and then tests
// nothing at all. Three of those copies existed before this rename and all three
// went red against it; they now derive from SELF_REPO.

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("SELF_REPO names the renamed repository", () => {
  assert.equal(SELF_REPO, "DrDustinEdwards/capsid");
});

test("the package name is the repository name", () => {
  const pkg = JSON.parse(read("package.json")) as { name?: string };
  assert.equal(pkg.name, "capsid");
  // The lockfile carries the name twice and npm rewrites both. A lockfile still
  // naming the old package is a stale install away from a confusing diff.
  const lock = JSON.parse(read("package-lock.json")) as { name?: string; packages?: Record<string, { name?: string }> };
  assert.equal(lock.name, "capsid");
  assert.equal(lock.packages?.[""]?.name, "capsid");
});

// ---- the reappearance guard -------------------------------------------------

// The one occurrence of the old name that is CORRECT, written down with its
// reason rather than skipped quietly. The job that did the rename ruled the
// local clone folder stays where it is, so the scheduler's folder map still
// points at dev\capsid-mcp on this machine. It is a filesystem path, not a
// repository reference.
const ALLOWED: Array<{ file: string; line: RegExp; why: string }> = [
  {
    file: "scripts/schedule-drivers.mjs",
    line: /capsid: "C:/,
    why: "the LOCAL clone folder, deliberately not renamed; a path on this machine, not a repo reference",
  },
];

// src/ and scripts/ are the code paths: what the Worker runs and what CI and the
// operator execute. Comments in workflows, historical notes in migrations and the
// audit corpus are deliberately out of scope, because they name what the repo was
// called at the time and rewriting them would falsify a record.
function codePaths(): Array<{ rel: string; text: string }> {
  const files = sourceFiles().map((f) => ({ rel: `src/${f.name}`, text: f.text }));
  for (const name of readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs")).sort()) {
    files.push({ rel: `scripts/${name}`, text: read(`scripts/${name}`) });
  }
  files.push({ rel: "package.json", text: read("package.json") });
  return files;
}

test("the scan reads the code paths it claims to, so nothing below passes on an empty walk", () => {
  const files = codePaths();
  assert.ok(files.length >= 20, `the code-path scan found only ${files.length} files`);
  assert.ok(
    files.some((f) => f.rel.startsWith("scripts/")),
    "the scan never reached scripts/, where three of the rename's sites lived"
  );
  assert.ok(files.every((f) => f.text.length > 0), "a scanned file came back empty");
});

test("the old repository name does not reappear in a code path", () => {
  const violations: string[] = [];
  const matched = new Set<number>();

  for (const { rel, text } of codePaths()) {
    for (const [i, line] of text.split("\n").entries()) {
      if (!line.includes("capsid-mcp")) continue;
      const allowed = ALLOWED.findIndex((a) => a.file === rel && a.line.test(line));
      if (allowed >= 0) {
        matched.add(allowed);
        continue;
      }
      violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `the repository is DrDustinEdwards/capsid; these still name capsid-mcp:\n    ${violations.join("\n    ")}`
  );

  // A stale exemption is its own defect: it reads as "this is fine here" about a
  // line that no longer exists. Every entry must still match something.
  for (const [i, entry] of ALLOWED.entries()) {
    assert.ok(matched.has(i), `the exemption for ${entry.file} (${entry.why}) matched nothing and should be deleted`);
  }
});
