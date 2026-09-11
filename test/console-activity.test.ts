import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVITY_LIMIT, activityFilterFrom, loadActivity } from "../src/console-activity.ts";
import { fakeD1 } from "./fakes.ts";

// GROUP 5: RECENT ACTIVITY.
//
// The last 50 audit rows across every namespace, filterable by namespace and by
// actor. The filter is the part worth testing: it is built from a query string a
// browser sends, so it is untrusted input reaching a SQL statement, and the whole
// defence is that both values are BOUND rather than interpolated. The tests below
// check the statement's shape as well as its results, because a bound parameter that
// later becomes a template literal passes every results-only test ever written.

test("no filter asks for the whole log, bounded", () => {
  const filter = activityFilterFrom(new URL("https://capsid.example/console"));
  assert.equal(filter.namespace, null);
  assert.equal(filter.actor, null);
});

test("the filter reads namespace and actor off the query string, trimmed", () => {
  const filter = activityFilterFrom(new URL("https://capsid.example/console?namespace=capsid&actor=%20agent%3Acapsid-driver%20"));
  assert.equal(filter.namespace, "capsid");
  assert.equal(filter.actor, "agent:capsid-driver");
});

test("an empty or whitespace filter value is no filter, not a filter on the empty string", () => {
  const filter = activityFilterFrom(new URL("https://capsid.example/console?namespace=&actor=%20%20"));
  assert.equal(filter.namespace, null);
  assert.equal(filter.actor, null);
});

test("the filter values are BOUND, never interpolated into the statement", async () => {
  const d1 = fakeD1();
  await loadActivity(d1.db, { namespace: "capsid'; DROP TABLE documents; --", actor: "agent:x" });
  const read = d1.reads.find((r) => /FROM audit_log/i.test(r.sql));
  assert.ok(read, "the activity query never reached the database");
  assert.doesNotMatch(read.sql, /DROP TABLE/, "a filter value was interpolated into the SQL");
  assert.ok(
    read.params.includes("capsid'; DROP TABLE documents; --"),
    `the namespace filter was not bound: ${JSON.stringify(read.params)}`
  );
  assert.ok(read.params.includes("agent:x"));
});

test("the read is bounded at the statement, not sliced afterwards", async () => {
  const d1 = fakeD1();
  await loadActivity(d1.db, { namespace: null, actor: null });
  const read = d1.reads.find((r) => /FROM audit_log/i.test(r.sql));
  assert.ok(read);
  assert.match(read.sql, /LIMIT/, "an unbounded read of audit_log would grow with the table");
  assert.ok(
    read.params.includes(ACTIVITY_LIMIT),
    `the limit should be bound, and should be ${ACTIVITY_LIMIT}: ${JSON.stringify(read.params)}`
  );
  assert.match(read.sql, /ORDER BY[\s\S]*DESC/i, "recent activity has to be the RECENT rows");
});

test("both filters narrow together, and each is its own clause", async () => {
  const d1 = fakeD1();
  await loadActivity(d1.db, { namespace: "capsid", actor: "github:DrDustinEdwards" });
  const read = d1.reads.find((r) => /FROM audit_log/i.test(r.sql));
  assert.ok(read);
  assert.match(read.sql, /namespace = \?/);
  assert.match(read.sql, /actor = \?/);
});

test("ACTIVITY_LIMIT is the 50 the job asked for", () => {
  assert.equal(ACTIVITY_LIMIT, 50);
});
