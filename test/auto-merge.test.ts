import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTO_MERGE_POLICY_PATH,
  POLICY_CHECKS,
  ciVerdict,
  declineParams,
  evaluatePolicy,
  jobIdFromBody,
  loadMergePolicy,
  mergeParams,
  parseMergePolicy,
  type PrFacts,
} from "../src/auto-merge.ts";
import { signTaskBody } from "../src/improve-task.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// PART 1 OF THE AUTONOMY ARC. The Worker may merge a pull request with no human when
// every check in capsid/policy/auto-merge.md passes. These tests drive each check to
// its refusal on its own, because a policy whose checks have only ever been seen
// passing together is a policy nobody has verified: capsid/conventions.md, "a guard
// that has never been observed failing has not been verified".

const SECRET = "test-improve-secret";

// A PR that passes every check. Each test below breaks exactly one field of it, so a
// refusal can only come from the check that field feeds.
function greenPr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 23,
    repo: "DrDustinEdwards/capsid-mcp",
    namespace: "capsid",
    baseRef: "master",
    defaultBranch: "master",
    headSha: "bfae8ca9012345678901234567890123456789ab",
    body: "Closes job_4c0ecc28548b.\n\nRefuse a swallowed parameter tag.",
    changedPaths: ["src/jobs.ts", "docs/schema.md"],
    ciConclusion: "success",
    ciNote: "3 check(s) green",
    jobId: "job_4c0ecc28548b",
    jobClaimedBy: "agent:capsid-driver",
    driverAgent: { name: "capsid-driver", kind: "driver", revoked: false },
    ...over,
  };
}

// ---- the baseline, which every plant below is measured against ------------------

test("the unmodified green PR merges, and passes every check the code enforces", () => {
  const verdict = evaluatePolicy(greenPr());
  assert.equal(verdict.merge, true);
  assert.deepEqual(
    verdict.merge ? [...verdict.passed].sort() : [],
    [...POLICY_CHECKS].sort(),
    "the merging path must report every check as passed, or the audit row understates what was verified"
  );
});

// ---- each check, refused on its own ---------------------------------------------

test("body_names_job: a PR body with no job id never merges", () => {
  const verdict = evaluatePolicy(greenPr({ body: "a tidy little change", jobId: null }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "body_names_job");
});

test("author_is_driver: a job nobody claimed never merges", () => {
  const verdict = evaluatePolicy(greenPr({ jobClaimedBy: null, driverAgent: null }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
});

test("author_is_driver: a PR from a non-driver author never merges", () => {
  // The seat is a real minted agent and still not a driver. This is the check that
  // stops a human's own PR being merged by the Worker on the seat's credential.
  const verdict = evaluatePolicy(
    greenPr({ jobClaimedBy: "agent:seat", driverAgent: { name: "seat", kind: "seat", revoked: false } })
  );
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
  assert.match(verdict.merge === false ? verdict.why : "", /kind 'seat', not a driver/);
});

test("author_is_driver: a revoked driver's open work waits for the seat", () => {
  const verdict = evaluatePolicy(
    greenPr({ driverAgent: { name: "capsid-driver", kind: "driver", revoked: true } })
  );
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
  assert.match(verdict.merge === false ? verdict.why : "", /revoked/);
});

test("author_is_driver: a claim by an opkey rather than an agent never merges", () => {
  const verdict = evaluatePolicy(greenPr({ jobClaimedBy: "opkey:9f2c1a", driverAgent: null }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
});

test("base_is_default_branch: a PR onto a side branch never merges", () => {
  const verdict = evaluatePolicy(greenPr({ baseRef: "release/2026-09" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "base_is_default_branch");
});

test("ci_green: a failing head sha never merges", () => {
  const verdict = evaluatePolicy(greenPr({ ciConclusion: "failure", ciNote: "checks=failure" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
});

test("ci_green: a PR nothing has reported on never merges", () => {
  const verdict = evaluatePolicy(greenPr({ ciConclusion: null, ciNote: "no check run has reported on this commit" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
});

test("paths_unprotected: a green PR touching a protected path never merges", () => {
  const verdict = evaluatePolicy(greenPr({ changedPaths: ["src/jobs.ts", "test/jobs.test.ts"] }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "paths_unprotected");
  assert.match(verdict.merge === false ? verdict.why : "", /test\/jobs\.test\.ts/);
});

test("paths_unprotected: CLAUDE.md is protected, so a docs-looking change still waits", () => {
  const verdict = evaluatePolicy(greenPr({ changedPaths: ["CLAUDE.md"] }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "paths_unprotected");
});

test("paths_not_money: a billing surface never merges", () => {
  // Not on the protected list, so this check is the only thing refusing it. A path
  // that both lists cover would not prove this check runs at all.
  const verdict = evaluatePolicy(greenPr({ changedPaths: ["src/billing/invoice.ts"] }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "paths_not_money");
});

test("no_migration_workflow_lockfile: each of the three refuses on its own", () => {
  for (const path of ["migrations/0012_skills.sql", ".github/workflows/ci.yml", "package-lock.json"]) {
    const verdict = evaluatePolicy(greenPr({ changedPaths: [path] }));
    assert.equal(verdict.merge, false, `${path} must not merge`);
    // The protected list catches all three first, which is the point: two independent
    // statements of the same refusal. What matters is that none of them merges.
    assert.ok(
      verdict.merge === false && ["paths_unprotected", "no_migration_workflow_lockfile"].includes(verdict.failed),
      `${path} refused by ${verdict.merge === false ? verdict.failed : "nothing"}`
    );
  }
});

test("a failing check reports only the checks that actually passed before it", () => {
  const verdict = evaluatePolicy(greenPr({ ciConclusion: "failure", ciNote: "checks=failure" }));
  assert.equal(verdict.merge, false);
  // ci_green sits fourth, so exactly the three before it passed. An audit row that
  // claimed the path checks passed would be claiming a check that never ran.
  assert.deepEqual(verdict.merge === false ? verdict.passed : [], [
    "body_names_job",
    "author_is_driver",
    "base_is_default_branch",
  ]);
});

// ---- the job id in a PR body ----------------------------------------------------

test("jobIdFromBody finds the id in prose and refuses a malformed one", () => {
  assert.equal(jobIdFromBody("Closes job_4c0ecc28548b."), "job_4c0ecc28548b");
  assert.equal(jobIdFromBody("job_4c0ecc28548"), null, "eleven hex digits is not a job id");
  assert.equal(jobIdFromBody("no id here"), null);
  assert.equal(jobIdFromBody(""), null);
});

// ---- CI, where an unreported check is not a pass --------------------------------

test("ciVerdict calls no checks, pending checks and a failure all not-green", () => {
  assert.equal(ciVerdict([]).conclusion, null);
  assert.equal(ciVerdict([{ name: "checks", status: "in_progress", conclusion: null }]).conclusion, "pending");
  assert.equal(ciVerdict([{ name: "checks", status: "completed", conclusion: "failure" }]).conclusion, "failure");
  assert.equal(ciVerdict([{ name: "checks", status: "completed", conclusion: "success" }]).conclusion, "success");
  assert.equal(
    ciVerdict([
      { name: "checks", status: "completed", conclusion: "success" },
      { name: "deploy", status: "completed", conclusion: "failure" },
    ]).conclusion,
    "failure",
    "one red check among green ones is still red"
  );
});

// ---- the policy document --------------------------------------------------------

const GOOD_POLICY = [
  "# Auto-merge policy",
  "",
  "- version: 1",
  "- enabled: true",
  "- namespaces: capsid",
  "",
  "## Checks",
  "",
  ...POLICY_CHECKS.map((c) => `- \`${c}\` refuses on its own.`),
  "",
].join("\n");

test("parseMergePolicy reads the version, the switch and the namespaces", () => {
  const parsed = parseMergePolicy(GOOD_POLICY);
  assert.ok("policy" in parsed);
  assert.equal(parsed.policy.version, "1");
  assert.equal(parsed.policy.enabled, true);
  assert.deepEqual(parsed.policy.namespaces, ["capsid"]);
});

test("parseMergePolicy refuses a policy with no version, no switch or no namespace", () => {
  for (const drop of ["- version: 1", "- enabled: true", "- namespaces: capsid"]) {
    const parsed = parseMergePolicy(GOOD_POLICY.replace(`${drop}\n`, ""));
    assert.ok("error" in parsed, `dropping "${drop}" must refuse`);
  }
});

test("parseMergePolicy refuses a namespace that is not on the improve roster", () => {
  const parsed = parseMergePolicy(GOOD_POLICY.replace("- namespaces: capsid", "- namespaces: capsid, julieedwards"));
  assert.ok("error" in parsed);
  assert.match(parsed.error, /julieedwards/);
});

async function envWithPolicy(body: string | null) {
  const { db } = fakeD1({
    documents: body === null ? [] : [{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "policy", body }],
  });
  return fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
}

test("loadMergePolicy refuses a policy that is absent, unsigned, or edited after signing", async () => {
  assert.match(((await loadMergePolicy(await envWithPolicy(null))) as { error: string }).error, /no merge policy/);

  const unsigned = await loadMergePolicy(await envWithPolicy(GOOD_POLICY));
  assert.ok("error" in unsigned);
  assert.match(unsigned.error, /carries no capsid-task-signature/);

  const signed = await signTaskBody(SECRET, GOOD_POLICY);
  const tampered = signed.replace("- namespaces: capsid", "- namespaces: capsid, foxhound");
  const edited = await loadMergePolicy(await envWithPolicy(tampered));
  assert.ok("error" in edited, "a policy edited after signing must not load");
  assert.match(edited.error, /does not match its body/);
});

test("loadMergePolicy accepts the signed policy and refuses one that names fewer checks than the code enforces", async () => {
  const ok = await loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, GOOD_POLICY)));
  assert.ok("policy" in ok, "the signed policy must load");
  assert.equal(ok.policy.version, "1");

  // A check the Worker enforces and the document does not describe. The document is
  // what a human reads to know what the machine may do alone, so a code check it does
  // not name is a merge nobody authorised.
  const short = GOOD_POLICY.replace(`- \`ci_green\` refuses on its own.\n`, "");
  const refused = await loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, short)));
  assert.ok("error" in refused);
  assert.match(refused.error, /does not name ci_green/);
});

// ---- the document that actually ships -------------------------------------------

test("the shipped policy document names exactly the checks the code enforces", () => {
  const shipped = readFileSync(join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"), "utf8");
  const parsed = parseMergePolicy(shipped);
  assert.ok("policy" in parsed, `the shipped policy must parse: ${"error" in parsed ? parsed.error : ""}`);
  assert.deepEqual(
    [...parsed.policy.checks].sort(),
    [...POLICY_CHECKS].sort(),
    "the shipped document and the code must name the same checks, in both directions"
  );
});

// ---- the audit rows -------------------------------------------------------------

test("the decline audit row names the policy version, the PR, the failing check and why", () => {
  const facts = greenPr({ ciConclusion: "failure", ciNote: "checks=failure" });
  const verdict = evaluatePolicy(facts);
  assert.equal(verdict.merge, false);
  const row = declineParams("1", facts, verdict as Extract<typeof verdict, { merge: false }>, new Date("2026-09-12T03:00:00Z"));
  assert.deepEqual(row, {
    policy_version: "1",
    repo: "DrDustinEdwards/capsid-mcp",
    pr: 23,
    head_sha: "bfae8ca9012345678901234567890123456789ab",
    failed: "ci_green",
    why: "CI on bfae8ca is failure: checks=failure",
    passed: ["body_names_job", "author_is_driver", "base_is_default_branch"],
    at: "2026-09-12T03:00:00.000Z",
  });
});

test("the merge audit row names the policy version, the job, the driver and both shas", () => {
  const facts = greenPr();
  const verdict = evaluatePolicy(facts);
  assert.equal(verdict.merge, true);
  const row = mergeParams("1", facts, verdict.merge ? verdict.passed : [], "f852780aabbccddeeff0011223344556677889900", new Date("2026-09-12T03:00:00Z"));
  assert.deepEqual(row, {
    policy_version: "1",
    repo: "DrDustinEdwards/capsid-mcp",
    pr: 23,
    head_sha: "bfae8ca9012345678901234567890123456789ab",
    job: "job_4c0ecc28548b",
    driver: "agent:capsid-driver",
    merge_sha: "f852780aabbccddeeff0011223344556677889900",
    passed: [...POLICY_CHECKS],
    at: "2026-09-12T03:00:00.000Z",
  });
});
