import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCOPE_FLAGS, defaultScopes } from "../src/agents-schema.ts";
import { adminAgent, legacyAgent, type Agent } from "../src/agents.ts";
import { missingForJob, parseRequiredScopes, serializeRequiredScopes } from "../src/jobs-schema.ts";
import { sourceFile } from "./source-files.ts";

// GROUP 5: THE QUEUE ASKS WHAT A DRIVER CAN DO BEFORE HANDING IT THE WORK.
//
// The claim used to authorize on one question: does this caller hold the write grant.
// Every driver did, because there was one headless credential and it could do
// everything. A job whose work ends in a merge was claimed by whoever asked first, and
// the mismatch surfaced four hours later when the lease expired, or did not surface at
// all because the driver could do it and nobody had decided that it should.

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0009_jobs_required_scopes.sql"), "utf8");

function driver(mutate: (scopes: ReturnType<typeof defaultScopes>) => void = () => {}): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  mutate(scopes);
  return { id: "agent_0123456789ab", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

test("the migration adds the column the queue reads, and says null means no requirement", () => {
  assert.match(MIGRATION, /ALTER TABLE jobs ADD COLUMN required_scopes TEXT/);
  assert.match(MIGRATION, /NULL MEANS NO REQUIREMENT/i, "a nullable column with no stated meaning is a column two readers will disagree about");
});

test("a job with no requirement is claimable by any write-grant driver, which is every job posted so far", () => {
  assert.equal(missingForJob(driver(), "capsid", null), null);
  assert.equal(missingForJob(driver(), "capsid", ""), null);
  assert.equal(missingForJob(driver(), "capsid", "{}"), null);
});

test("a job requiring a flag refuses a driver without it, by name", () => {
  const required = serializeRequiredScopes({ flags: ["can_merge"] });
  const refusal = missingForJob(driver(), "capsid", required);
  assert.match(String(refusal), /can_merge/);
  // And the same driver holding the flag is not refused: the innocent direction.
  const merger = driver((s) => {
    s.flags.can_merge = true;
  });
  assert.equal(missingForJob(merger, "capsid", required), null);
});

test("a job in a namespace the driver is not scoped to is refused at the claim", () => {
  const refusal = missingForJob(driver(), "foxing", null);
  assert.match(String(refusal), /not scoped to the 'foxing' namespace/);
});

test("a read-only agent cannot claim, even a job that requires nothing", () => {
  const readOnly = driver((s) => {
    s.grants = ["read"];
  });
  assert.match(String(missingForJob(readOnly, "capsid", null)), /requires the write grant/);
});

test("the legacy key and the admin can still claim anything, which is what keeps the queue working today", () => {
  const everything = serializeRequiredScopes({ flags: [...SCOPE_FLAGS] });
  assert.equal(missingForJob(legacyAgent("write", "opkey:0123456789ab"), "foxhound", everything), null);
  assert.equal(missingForJob(adminAgent("DrDustinEdwards"), "foxhound", everything), null);
});

test("a required_scopes blob that cannot be read demands nothing rather than everything", () => {
  // The opposite fail-closed direction from parseScopes, and deliberately so. A
  // corrupt AGENT row must grant nothing; a corrupt JOB requirement must not invent a
  // requirement nobody wrote, because that would strand the job in the queue with a
  // refusal no scope change can satisfy. The claim still checks the grant and the
  // namespace, which is the floor.
  assert.deepEqual(parseRequiredScopes("{"), { flags: [] });
  assert.deepEqual(parseRequiredScopes("[]"), { flags: [] });
  assert.deepEqual(parseRequiredScopes('{"flags":["can_fly","can_merge"],"grants":["admin"]}'), { flags: ["can_merge"] });
  assert.equal(missingForJob(driver(), "capsid", "{"), null);
});

test("the claim checks scopes BEFORE it takes the lease", () => {
  // Order is the property. A claim that takes the lease and then refuses has parked
  // the job on a driver that cannot do it, and the queue's own rule is that a caller
  // holds one claim at a time, so it has also blocked that driver from taking
  // anything else until the lease expires.
  const jobs = sourceFile("jobs.ts");
  const claim = jobs.slice(jobs.indexOf("export async function claimJob"), jobs.indexOf("// ---- the transitions"));
  assert.ok(claim.length > 500, "could not bound claimJob in src/jobs.ts");
  const check = claim.indexOf("missingForJob(");
  const lease = claim.indexOf("SET status = 'claimed'");
  assert.ok(check > 0, "claimJob no longer checks the job's required scopes");
  assert.ok(lease > 0, "claimJob no longer takes the lease, which cannot be right");
  assert.ok(check < lease, "claimJob takes the lease before checking the driver's scopes");
});

test("claimed_by speaks the audit vocabulary, so an agent claim is traceable to its rows", () => {
  // migrations/0006 states that claimed_by has the same shape as audit_log.actor, so
  // one query joins a job to what its driver did. An agent's actor is agent:<name>,
  // and the queue has to accept it or a minted driver cannot hold a lease at all.
  const jobs = sourceFile("jobs.ts");
  const shape = /const ACTOR_SHAPE = ([^;]+);/.exec(jobs);
  assert.ok(shape, "src/jobs.ts no longer states which actors can hold a lease");
  assert.match(shape[1], /agent:/, "the queue does not accept an agent identity as a lease holder");
  assert.match(shape[1], /github:/, "the queue stopped accepting an OAuth session");
  assert.match(shape[1], /opkey:/, "the queue stopped accepting the legacy operator key");
});
