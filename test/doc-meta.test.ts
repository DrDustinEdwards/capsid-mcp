import assert from "node:assert/strict";
import { test } from "node:test";
import { DOC_STATUSES, DOC_TYPES, validateDocStatus, validateDocType } from "../src/doc-meta.ts";

// Pinned so adding or removing a status is a deliberate edit here, not a silent
// widening. Fails in both directions: a missing entry and an orphaned one.
test("DOC_STATUSES is exactly the five statuses in live use", () => {
  assert.deepEqual([...DOC_STATUSES].sort(), ["active", "draft", "published", "ready", "superseded"]);
});

test("every valid status is accepted", () => {
  for (const status of DOC_STATUSES) {
    assert.equal(validateDocStatus(status), null, `expected '${status}' to be accepted`);
  }
});

test("every valid type is accepted", () => {
  for (const type of DOC_TYPES) {
    assert.equal(validateDocType(type), null, `expected '${type}' to be accepted`);
  }
});

// The planted violation. Before this validation existed, a write carrying any
// string at all was stored, and the lint loop then filtered on status, so a
// plausible-looking value took the doc out of memory with no error anywhere.
test("an off-schema status is rejected and the message lists the valid set", () => {
  const error = validateDocStatus("in-progress");
  assert.ok(error, "expected 'in-progress' to be rejected");
  assert.match(error, /unknown status 'in-progress'/);
  assert.match(error, /published/);
});

test("an off-schema type is rejected and the message names episodic", () => {
  const error = validateDocType("session");
  assert.ok(error, "expected 'session' to be rejected");
  assert.match(error, /unknown type 'session'/);
  assert.match(error, /episodic/);
});

// 'active' is VALID, and that is the point of the fix. The 22 recova episodics
// written as 'active' were never malformed; the defect was that the counter and
// gather treated status as a visibility filter. Rejecting 'active' here would
// "fix" the incident by breaking the callers instead.
test("'active' is a valid status, not the thing that was wrong", () => {
  assert.equal(validateDocStatus("active"), null);
});

test("status validation does not accept the empty string", () => {
  assert.ok(validateDocStatus(""), "expected the empty string to be rejected");
});
