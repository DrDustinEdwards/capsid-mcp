import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error a plain .mjs script with no type declarations, imported for its pure helpers
import { LOG_BUDGET, chicagoDay, keyPath, logPath, renderLog, selected, taskName } from "../scripts/schedule-drivers.mjs";
import { ROSTER } from "../src/improve-schema.ts";

// PART 3 OF THE AUTONOMY ARC, as ruled 2026-09-12: a Windows Task Scheduler task per
// project folder rather than a cloud routine, because a routine can only reach Capsid
// as the OAuth admin and the whole arc exists to stop that.

const SOURCE = readFileSync(join(import.meta.dirname, "..", "scripts", "schedule-drivers.mjs"), "utf8");

test("every roster namespace has a repo folder, so none is silently unschedulable", () => {
  assert.deepEqual([...selected(undefined)].sort(), [...ROSTER].sort());
});

test("the task name and the key path are per namespace, so one task is one driver", () => {
  assert.equal(taskName("capsid"), "Capsid improve driver (capsid)");
  assert.notEqual(taskName("capsid"), taskName("foxing"));
  assert.match(String(keyPath("foxing")), /agent-foxing-driver\.key$/);
});

// ---- off by default, which is the point ----------------------------------------

test("nothing is created without --apply, and an installed task is created DISABLED", () => {
  // Both halves are asserted against the source because the alternative is creating a
  // real scheduled task on this machine to watch it not be enabled.
  assert.match(SOURCE, /if \(!apply\) \{[\s\S]*?return `\$\{exists \? "REPLACE" : "CREATE "\}/, "install must have a dry-run branch that creates nothing");
  const install = /function install\([\s\S]*?\n\}/.exec(SOURCE);
  assert.ok(install, "the install function is gone");
  assert.match(install[0], /"\/Change",\s*"\/TN",\s*taskName\(ns\),\s*"\/DISABLE"/, "a newly installed task must be disabled");
  assert.match(install[0], /\/ENABLE/, "the operator must be told how to switch it on");
  assert.equal(
    /"\/Change"[\s\S]*?"\/ENABLE"/.test(install[0]),
    false,
    "install must never enable the task itself, only print the command"
  );
});

test("the scheduled command runs this script rather than claude directly", () => {
  // A task invoking `claude` straight could not post a log for a session that died,
  // which is exactly the run whose log matters.
  const command = /function installCommand\([\s\S]*?\n\}/.exec(SOURCE);
  assert.ok(command);
  assert.match(command[0], /--run --namespace/);
  assert.equal(/"claude"/.test(command[0]), false);
});

test("the key is read only to post the log, and every use of its VALUE is a bearer header", () => {
  // The precise property, not a keyword ban: the variable holding key material is
  // `key`, from readKey. Every interpolation of it must be an Authorization header,
  // which is the only place it legitimately goes. Naming the word "key" in a message
  // about a missing FILE is fine, and an earlier version of this test wrongly failed
  // on exactly that.
  const uses = (SOURCE.match(/\$\{key\}/g) ?? []).length;
  const bearers = (SOURCE.match(/Authorization: `Bearer \$\{key\}`/g) ?? []).length;
  assert.ok(uses > 0, "the guard must be reading a file that still uses the value");
  assert.equal(bearers, uses, "every interpolation of the key must be a bearer header and nothing else");
  assert.equal(/\$\{readKey\(/.test(SOURCE), false, "the key must not be read straight into a template");
  for (const call of SOURCE.match(/console\.(log|error)\([\s\S]{0,160}?\);/g) ?? []) {
    assert.equal(/\$\{key\}/.test(call), false, `a console call interpolates the key: ${call}`);
  }
});

// ---- the run log ----------------------------------------------------------------

test("the log is named by the Chicago day, not the UTC day", () => {
  // 04:00 Chicago in CDT is 09:00 UTC the same day, but 23:00 Chicago is the NEXT day
  // in UTC. A log named by the UTC day would file runs under the wrong date.
  assert.equal(chicagoDay(new Date("2026-09-12T04:30:00Z")), "2026-09-11", "23:30 Chicago is still the 11th locally");
  assert.equal(chicagoDay(new Date("2026-09-12T09:00:00Z")), "2026-09-12");
  assert.equal(logPath("2026-09-12"), "jobs/nightly-2026-09-12.md");
});

test("a failed run still renders a log, and the exit code is in it", () => {
  const body = renderLog("capsid", {
    exitCode: 1,
    output: "the driver could not reach the queue",
    started: "2026-09-12T09:00:00.000Z",
    finished: "2026-09-12T09:00:04.000Z",
  });
  assert.match(body, /# Nightly driver run, capsid/);
  assert.match(body, /claude exit code: 1 \(exited 1\)/);
  assert.match(body, /could not reach the queue/);
});

test("a long transcript is trimmed to its TAIL, because the end says how the run finished", () => {
  const output = `${"a".repeat(LOG_BUDGET + 500)}THE-END`;
  const body = renderLog("capsid", { exitCode: 0, output, started: "s", finished: "f" });
  assert.ok(body.includes("THE-END"), "the tail must survive trimming");
  assert.match(body, /earlier characters omitted/);
  assert.ok(body.length < output.length, "an unbounded transcript must not land in a document whole");
});

test("a short transcript is not trimmed and carries no omission note", () => {
  const body = renderLog("capsid", { exitCode: 0, output: "one job, done", started: "s", finished: "f" });
  assert.equal(/omitted/.test(body), false);
});

test("an empty transcript is recorded as such rather than as an empty document", () => {
  assert.match(SOURCE, /\|\| "\(no output\)"/, "a run that printed nothing still gets a log that says so");
});
