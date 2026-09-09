import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// THE WORKFLOW SUPPLY-CHAIN GUARD (residual 6, closed 2026-09-08).
//
// Two properties, one scan, and both were violated in this repo when it was
// written: restore-rehearsal.yml took actions/checkout@v4 and actions/setup-node@v4
// by TAG, in the job that holds BACKUP_CREDENTIAL_KEY, and not one job in ci.yml or
// restore-rehearsal.yml carried a timeout-minutes.
//
//   pin      a tag is a moving pointer its owner can repoint at any time. These
//            jobs check out this repository and sit beside a job holding Cloudflare
//            credentials and a backup credential that reads the whole corpus.
//   timeout  a job with no timeout-minutes inherits GitHub's 360-minute default, so
//            a hung step burns six hours of the Actions budget the improve loop's
//            kill switch is metered against, and holds the concurrency group.
//
// SCOPE, STATED RATHER THAN IMPLIED: this guard reads THIS repository's workflows.
// The same two properties were fixed by hand in the other five roster repos on
// 2026-09-08 (foxhound ci.yml, foxing ci-cf.yml, germomics ci.yml, capsid-backups
// mirror.yml; dustinedwards-info already satisfied both), and nothing offline can
// assert that from here. A guard scoped to one repo is a guess about where the next
// bug will be written, and this is the half of it that can run.

const WORKFLOWS = join(import.meta.dirname, "..", ".github", "workflows");

interface Job {
  workflow: string;
  id: string;
  lines: string[];
}

function workflowFiles(): Array<{ name: string; text: string }> {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(WORKFLOWS, name), "utf8") }));
}

// Jobs are the two-space keys under `jobs:`. Parsed by indentation rather than with
// a YAML library on purpose: the suite takes no dependencies, and the shape being
// checked is exactly the shape a reader sees.
function jobs(): Job[] {
  const found: Job[] = [];
  for (const { name, text } of workflowFiles()) {
    const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
    const start = lines.findIndex((l) => l === "jobs:");
    if (start === -1) continue;
    let current: Job | null = null;
    for (const line of lines.slice(start + 1)) {
      const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (header) {
        if (current) found.push(current);
        current = { workflow: name, id: header[1], lines: [] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (current) found.push(current);
  }
  return found;
}

test("the scan is NOT VACUOUS: it finds every workflow and parses jobs out of each", () => {
  const files = workflowFiles();
  assert.ok(files.length >= 3, `only ${files.length} workflow files found; the scan is reading the wrong directory`);
  const parsed = jobs();
  assert.ok(parsed.length >= files.length, `${parsed.length} jobs parsed from ${files.length} workflows`);
  // Every workflow contributes at least one job, so a file whose shape the parser
  // cannot read is a failure rather than a silent zero.
  for (const file of files) {
    assert.ok(
      parsed.some((j) => j.workflow === file.name),
      `no job parsed out of ${file.name}; the guard would pass over it without checking anything`
    );
  }
  // And the pin scan reads something too: an `uses:` count of zero would make the
  // pin assertion below pass against a file it never opened.
  const uses = files.flatMap(({ text }) => [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)]);
  assert.ok(uses.length >= 6, `only ${uses.length} action references found across ${files.length} workflows`);
});

test("every third-party action is pinned by commit sha, never by tag", () => {
  const offenders: string[] = [];
  for (const { name, text } of workflowFiles()) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
      if (!m) return;
      const ref = m[1];
      // A local action (./path) and a reusable workflow in this repo are this
      // repository's own bytes and carry no upstream pointer to repoint.
      if (ref.startsWith("./")) return;
      const at = ref.lastIndexOf("@");
      const version = at === -1 ? "" : ref.slice(at + 1);
      if (!/^[0-9a-f]{40}$/.test(version)) {
        offenders.push(`${name}:${i + 1} ${ref}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "an action is referenced by tag. A tag is a moving pointer; pin the commit sha and leave the version in a trailing comment."
  );
});

test("every job declares timeout-minutes", () => {
  const offenders = jobs()
    .filter((job) => !job.lines.some((l) => /^\s{4,}timeout-minutes:\s*\d+/.test(l)))
    .map((job) => `${job.workflow}:${job.id}`);
  assert.deepEqual(
    offenders,
    [],
    "a job has no timeout-minutes and inherits GitHub's 360-minute default. A hung step burns the Actions budget the improve loop is metered against."
  );
});

test("the two credential-holding jobs are pinned, which is the case this guard was written for", () => {
  // Named explicitly so the guard cannot go quiet by no longer finding these two.
  // The mirror job lives in capsid-backups and is out of reach from here; this is
  // its sibling, and the one that holds BACKUP_CREDENTIAL_KEY in this repo.
  const rehearsal = readFileSync(join(WORKFLOWS, "restore-rehearsal.yml"), "utf8");
  assert.match(rehearsal, /BACKUP_CREDENTIAL_KEY/, "the rehearsal no longer holds the backup credential");
  for (const line of rehearsal.split("\n").filter((l) => /uses:/.test(l))) {
    assert.match(line, /@[0-9a-f]{40}/, `restore-rehearsal.yml takes an action by tag: ${line.trim()}`);
  }
  const deployJob = jobs().find((j) => j.workflow === "ci.yml" && j.id === "deploy");
  assert.ok(deployJob, "ci.yml no longer has a deploy job");
  assert.ok(
    deployJob.lines.some((l) => /timeout-minutes:/.test(l)),
    "the deploy job, which holds CLOUDFLARE_API_TOKEN, has no timeout"
  );
});
