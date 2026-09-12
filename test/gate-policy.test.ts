import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  GATE_CLASSES,
  GATE_POLICY_PATH,
  approveByPolicy,
  classifyCommand,
  deniedReason,
  isAdditiveMigration,
  loadGatePolicy,
  parseGatePolicy,
  splitStatements,
} from "../src/gate-policy.ts";
import { commandFromSummary, RESUME_MARKER, resumeJob } from "../src/jobs.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { signTaskBody } from "../src/improve-task.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// PART 2 OF THE AUTONOMY ARC. The seat may send a blocked job back in on the signed
// gate policy instead of on a human saying yes, and only for a command that matches a
// class written down. These tests drive the refusals, because the refusal is the whole
// value: a matcher that has only been seen matching is a matcher nobody has verified.

const SECRET = "test-improve-secret";

const ADDITIVE_SQL = [
  "-- 0012: skill records",
  "CREATE TABLE IF NOT EXISTS skill_evaluations (",
  "  skill TEXT NOT NULL,",
  "  delta REAL",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_skill_evals ON skill_evaluations(skill);",
  "ALTER TABLE jobs ADD COLUMN skill_ids_used TEXT;",
].join("\n");

const MIGRATION_CMD = "npx wrangler d1 execute capsid --remote --file migrations/0012_skills.sql";

// ---- the never list, which runs before any class --------------------------------

// WHICH DENY ENTRIES ARE LOAD-BEARING, measured by plant rather than assumed.
// Removing the deny check from classifyCommand reddens exactly one of these tests: the
// default-branch push, because `git push origin master` is the only command here that
// WOULD otherwise match a class. The rest are refused twice, once by the deny list and
// once by matching no class at all, and they are kept because the second refusal is an
// accident of today's narrow matchers: widen push_branch or open_pr later and the deny
// list becomes the only thing standing in front of them.
test("the deny list is what stops a default-branch push, and it is checked before any class", () => {
  for (const branch of ["master", "main"]) {
    const cmd = `git push origin ${branch}`;
    assert.ok(deniedReason(cmd), `${cmd} must be on the never list`);
    const match = classifyCommand(cmd);
    assert.ok("refused" in match, `a push to ${branch} must not be pre-approved`);
    assert.match(match.refused, /never list/, "it must be the deny list refusing, not a failure to match");
  }
});

test("a secret command never matches, in either spelling", () => {
  for (const cmd of [
    "npx wrangler secret put IMPROVE_SCORE_SECRET",
    "wrangler secret delete OPERATOR_KEY_HASH",
    "gh secret set CF_API_TOKEN --repo DrDustinEdwards/capsid-mcp",
  ]) {
    assert.ok(deniedReason(cmd), `${cmd} must be denied outright`);
    const match = classifyCommand(cmd);
    assert.ok("refused" in match, `${cmd} must match no class`);
  }
});

test("a force push never matches, even though the same command without the flag would", () => {
  const plain = classifyCommand("git push -u origin feat/autonomy-policy-gates");
  assert.ok("klass" in plain && plain.klass === "push_branch", "the plain push is the class this test is contrasted against");

  for (const cmd of [
    "git push --force origin feat/autonomy-policy-gates",
    "git push --force-with-lease origin feat/autonomy-policy-gates",
    "git push origin +refs/heads/feat:refs/heads/feat",
  ]) {
    const match = classifyCommand(cmd);
    assert.ok("refused" in match, `${cmd} must not match push_branch`);
  }
});

test("deploying, rolling back, revoking, merging and deleting never match", () => {
  for (const cmd of [
    "npx wrangler deploy",
    "npx wrangler rollback",
    "node scripts/mint-agents.mjs --revoke capsid-driver",
    "gh pr merge 23 --merge --repo DrDustinEdwards/capsid-mcp",
    "rm -rf .improve-build",
  ]) {
    assert.ok(deniedReason(cmd), `${cmd} must be denied outright`);
  }
});

// ---- the three classes ----------------------------------------------------------

test("classifyCommand places each of the three classes and refuses anything else", () => {
  const migration = classifyCommand(MIGRATION_CMD);
  assert.ok("klass" in migration && migration.klass === "additive_migration");
  assert.equal("klass" in migration ? migration.migrationPath : null, "migrations/0012_skills.sql");

  const push = classifyCommand("git push -u origin feat/x");
  assert.ok("klass" in push && push.klass === "push_branch");

  const pr = classifyCommand("gh pr create --fill --base master");
  assert.ok("klass" in pr && pr.klass === "open_pr");

  for (const cmd of ["npm test", "node scripts/restore-rehearsal.mjs", ""]) {
    assert.ok("refused" in classifyCommand(cmd), `${cmd} must match no class`);
  }
});

test("a d1 execute against a file outside migrations/ is not a migration this policy covers", () => {
  const match = classifyCommand("npx wrangler d1 execute capsid --remote --file scratch/fix.sql");
  assert.ok("refused" in match);
  assert.match(match.refused, /not under migrations\//);
});

// ---- is the migration additive --------------------------------------------------

test("an additive migration matches, and every statement is named", () => {
  const verdict = isAdditiveMigration(ADDITIVE_SQL);
  assert.ok(verdict.ok, `expected additive: ${verdict.ok ? "" : verdict.reason}`);
  assert.deepEqual(verdict.statements, ["CREATE TABLE IF NOT EXISTS", "CREATE INDEX", "ALTER TABLE ADD COLUMN"]);
});

test("a DROP or an ALTER that removes matches nothing, even beside additive statements", () => {
  // The file is additive apart from one statement. A check that asked only whether an
  // additive statement was PRESENT would pass this, which is why every statement is
  // checked rather than any.
  for (const bad of [
    "DROP TABLE jobs;",
    "DROP INDEX idx_skill_evals;",
    "ALTER TABLE jobs DROP COLUMN priority;",
    "DELETE FROM documents WHERE namespace = 'capsid';",
    "UPDATE jobs SET status = 'done';",
  ]) {
    const verdict = isAdditiveMigration(`${ADDITIVE_SQL}\n${bad}`);
    assert.equal(verdict.ok, false, `${bad} must not be called additive`);
  }
});

test("a statement form the parser has never seen is a refusal, not a pass", () => {
  const verdict = isAdditiveMigration("CREATE TABLE skill_edits (skill TEXT);");
  assert.equal(verdict.ok, false, "CREATE TABLE without IF NOT EXISTS is not on the list");
});

test("an empty migration is a refusal", () => {
  assert.equal(isAdditiveMigration("-- nothing but a comment\n").ok, false);
});

test("splitStatements ignores a DROP that is only mentioned in a comment", () => {
  const sql = "-- this replaces the DROP TABLE we used to do;\nCREATE TABLE IF NOT EXISTS t (a TEXT);";
  assert.deepEqual(splitStatements(sql), ["CREATE TABLE IF NOT EXISTS t (a TEXT)"]);
  assert.equal(isAdditiveMigration(sql).ok, true);
});

// ---- the command comes back out of the blocked summary --------------------------

test("commandFromSummary reads back exactly what blockJob wrote", () => {
  const summary = `Finished up to the push.\n\n${RESUME_MARKER}\n\n    ${MIGRATION_CMD}`;
  assert.equal(commandFromSummary(summary), MIGRATION_CMD);
  assert.equal(commandFromSummary("blocked with no command recorded"), null);
  assert.equal(commandFromSummary(null), null);
});

// ---- the policy document --------------------------------------------------------

const GOOD_POLICY = [
  "# Pre-approved gates",
  "",
  "- version: 1",
  "- enabled: true",
  "",
  "## Classes",
  "",
  ...GATE_CLASSES.map((c) => `- \`${c}\` a bounded command.`),
  "",
].join("\n");

async function envWithPolicy(body: string | null) {
  const { db } = fakeD1({
    documents: body === null ? [] : [{ namespace: "capsid", path: GATE_POLICY_PATH, title: "gates", body }],
  });
  return fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
}

test("parseGatePolicy reads the version and the switch", () => {
  const parsed = parseGatePolicy(GOOD_POLICY);
  assert.ok("policy" in parsed);
  assert.equal(parsed.policy.version, "1");
  assert.equal(parsed.policy.enabled, true);
});

test("loadGatePolicy refuses an absent, unsigned or edited policy", async () => {
  assert.match(((await loadGatePolicy(await envWithPolicy(null))) as { error: string }).error, /no gate policy/);

  const unsigned = await loadGatePolicy(await envWithPolicy(GOOD_POLICY));
  assert.ok("error" in unsigned);
  assert.match(unsigned.error, /carries no capsid-task-signature/);

  const signed = await signTaskBody(SECRET, GOOD_POLICY);
  const tampered = signed.replace("- enabled: true", "- enabled: true\n- sneaky: yes");
  const edited = await loadGatePolicy(await envWithPolicy(tampered));
  assert.ok("error" in edited);
  assert.match(edited.error, /does not match its body/);
});

test("loadGatePolicy refuses a policy naming fewer classes than the code approves", async () => {
  const short = GOOD_POLICY.replace("- `additive_migration` a bounded command.\n", "");
  const refused = await loadGatePolicy(await envWithPolicy(await signTaskBody(SECRET, short)));
  assert.ok("error" in refused);
  assert.match(refused.error, /does not name additive_migration/);
});

test("the shipped gate document names exactly the classes the code approves", () => {
  const shipped = readFileSync(join(import.meta.dirname, "..", "docs", "policy", "gates.md"), "utf8");
  const parsed = parseGatePolicy(shipped);
  assert.ok("policy" in parsed, `the shipped policy must parse: ${"error" in parsed ? parsed.error : ""}`);
  assert.deepEqual([...parsed.policy.classes].sort(), [...GATE_CLASSES].sort());
});

// ---- the whole approval ---------------------------------------------------------

const readAdditive = async () => ADDITIVE_SQL;
const readNothing = async () => null;

test("approveByPolicy approves an additive migration and names what it matched", async () => {
  const env = await envWithPolicy(await signTaskBody(SECRET, GOOD_POLICY));
  const verdict = await approveByPolicy(env, "1", MIGRATION_CMD, readAdditive);
  assert.equal(verdict.approved, true);
  assert.equal(verdict.approved && verdict.klass, "additive_migration");
  assert.equal(
    verdict.approved && verdict.detail,
    "migrations/0012_skills.sql: CREATE TABLE IF NOT EXISTS, CREATE INDEX, ALTER TABLE ADD COLUMN"
  );
});

test("approveByPolicy refuses a migration it could not read", async () => {
  const env = await envWithPolicy(await signTaskBody(SECRET, GOOD_POLICY));
  const verdict = await approveByPolicy(env, "1", MIGRATION_CMD, readNothing);
  assert.equal(verdict.approved, false);
  assert.match(verdict.approved ? "" : verdict.reason, /could not be read/);
});

test("approveByPolicy refuses a disabled policy and a version that does not match", async () => {
  const disabled = await envWithPolicy(await signTaskBody(SECRET, GOOD_POLICY.replace("- enabled: true", "- enabled: false")));
  const off = await approveByPolicy(disabled, "1", "git push -u origin feat/x", readNothing);
  assert.equal(off.approved, false);
  assert.match(off.approved ? "" : off.reason, /disabled/);

  const env = await envWithPolicy(await signTaskBody(SECRET, GOOD_POLICY));
  const stale = await approveByPolicy(env, "0", "git push -u origin feat/x", readNothing);
  assert.equal(stale.approved, false);
  assert.match(stale.approved ? "" : stale.reason, /names policy version '0'/);
});

test("approveByPolicy refuses a job that blocked with no command", async () => {
  const env = await envWithPolicy(await signTaskBody(SECRET, GOOD_POLICY));
  const verdict = await approveByPolicy(env, "1", null, readNothing);
  assert.equal(verdict.approved, false);
  assert.match(verdict.approved ? "" : verdict.reason, /records no command/);
});

test("approveByPolicy refuses every command on the never list", async () => {
  const env = await envWithPolicy(await signTaskBody(SECRET, GOOD_POLICY));
  for (const cmd of [
    "npx wrangler secret put IMPROVE_SCORE_SECRET",
    "git push --force origin feat/x",
    "gh pr merge 23 --merge",
    "npx wrangler deploy",
  ]) {
    const verdict = await approveByPolicy(env, "1", cmd, readAdditive);
    assert.equal(verdict.approved, false, `${cmd} must not be pre-approved`);
  }
});

// ---- the audit row, driven through resumeJob ------------------------------------
//
// A small, honest stub for the handful of statements resume issues. It resolves the
// WHERE clauses from the BOUND PARAMS, so a handler asking for the wrong id gets
// nothing. The command under test is a branch push rather than a migration, so no
// repo read is involved and this fake needs no GitHub.

interface Recorded {
  sql: string;
  params: unknown[];
}

function resumeDb(job: Record<string, unknown>, policyBody: string) {
  const recorded: Recorded[] = [];
  const row = { ...job };
  const stmt = (sql: string, params: unknown[] = []): D1PreparedStatement => {
    const flat = sql.replace(/\s+/g, " ").trim();
    return {
      sql: flat,
      params,
      bind: (...bound: unknown[]) => stmt(sql, bound),
      first: async () => {
        if (/SELECT \* FROM jobs WHERE status = 'claimed' AND claimed_by/i.test(flat)) return null;
        if (/SELECT \* FROM jobs WHERE id = \?1/i.test(flat)) return params[0] === row.id ? { ...row } : null;
        if (/SELECT body FROM documents WHERE namespace = \?1 AND path = \?2/i.test(flat)) {
          return params[1] === GATE_POLICY_PATH ? { body: policyBody } : null;
        }
        if (/SELECT id, title, body FROM documents/i.test(flat)) return null;
        if (/^UPDATE jobs SET/i.test(flat)) {
          recorded.push({ sql: flat, params });
          if (params[0] !== row.id || row.status !== "blocked") return null;
          row.status = "claimed";
          return { id: row.id };
        }
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({}),
      raw: async () => [],
    } as unknown as D1PreparedStatement;
  };
  return {
    recorded,
    db: {
      prepare: (sql: string) => stmt(sql),
      batch: async (statements: unknown[]) => {
        for (const s of statements) recorded.push(s as Recorded);
        return [];
      },
    } as unknown as D1Database,
  };
}

function seatAgent() {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_aaaabbbbcccc", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

async function blockedJob(command: string) {
  const body = await signTaskBody(SECRET, "Do the thing.");
  return {
    id: "job_4c0ecc28548b",
    namespace: "capsid",
    title: "a job that hit a gate",
    body,
    priority: 0,
    status: "blocked",
    posted_by: "github:DrDustinEdwards",
    claimed_by: "agent:capsid-driver",
    claimed_at: "2026-09-12T00:00:00.000Z",
    lease_expires: null,
    result_ref: null,
    result_summary: `Finished up to the push.\n\n${RESUME_MARKER}\n\n    ${command}`,
    gate_required: 1,
    created_at: "2026-09-11T22:00:00.000Z",
    updated_at: "2026-09-12T00:00:00.000Z",
    resumed_count: 0,
    blocked_count: 1,
    // A real row always carries this (migrations/0016, DEFAULT 0). Spelled here
    // because atCorrectionCap FAILS CLOSED: a budget it cannot read is one it
    // cannot bound, so an absent column refuses the resume rather than allowing it.
    corrections_count: 0,
    required_scopes: null,
    min_record: null,
  };
}

// The mirror document write audits under the SAME action name, so there is more than
// one audit row per transition. The one this test is about is the job row, which is
// the one carrying `approved`.
function auditRow(recorded: Recorded[], action: string): Record<string, unknown> | null {
  for (const r of recorded) {
    if (!/INSERT INTO audit_log/i.test(r.sql) || r.params[1] !== action) continue;
    const parsed = JSON.parse(String(r.params[4])) as Record<string, unknown>;
    if ("approved" in parsed) return parsed;
  }
  return null;
}

test("a policy-approved resume records which class matched and what it matched on", async () => {
  const policy = await signTaskBody(SECRET, GOOD_POLICY);
  const { db, recorded } = resumeDb(await blockedJob("git push -u origin feat/autonomy-policy-gates"), policy);
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });

  const result = await resumeJob(env, seatAgent() as never, new Date("2026-09-12T03:00:00Z"), "job_4c0ecc28548b", "pre-approved branch push", "1");
  assert.equal(result.ok, true, `resume refused: ${result.ok ? "" : JSON.stringify(result)}`);

  const row = auditRow(recorded, "job-resumed");
  assert.ok(row, "a policy-approved resume must still write its audit row");
  assert.equal(row.approved_by_policy, "1");
  assert.equal(row.policy_class, "push_branch");
  assert.equal(row.policy_detail, "git push -u origin feat/autonomy-policy-gates");
  assert.equal(row.approved, "pre-approved branch push");
});

test("a resume with no policy records no policy fields, so the two cases are distinguishable", async () => {
  const policy = await signTaskBody(SECRET, GOOD_POLICY);
  const { db, recorded } = resumeDb(await blockedJob("git push -u origin feat/x"), policy);
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });

  const result = await resumeJob(env, seatAgent() as never, new Date("2026-09-12T03:00:00Z"), "job_4c0ecc28548b", "the human said yes");
  assert.equal(result.ok, true);
  const row = auditRow(recorded, "job-resumed");
  assert.ok(row);
  assert.equal(row.approved_by_policy, undefined, "a human-approved resume must not look policy-approved");
  assert.equal(row.policy_class, undefined);
});

test("a command on the never list refuses the resume and leaves the job blocked", async () => {
  const policy = await signTaskBody(SECRET, GOOD_POLICY);
  const job = await blockedJob("npx wrangler secret put IMPROVE_SCORE_SECRET");
  const { db, recorded } = resumeDb(job, policy);
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });

  const result = await resumeJob(env, seatAgent() as never, new Date("2026-09-12T03:00:00Z"), "job_4c0ecc28548b", "trying it on", "1");
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /not pre-approved/);
  assert.equal(
    recorded.some((r) => /^UPDATE jobs SET/i.test(r.sql)),
    false,
    "a refused approval must not have moved the job out of blocked"
  );
});
