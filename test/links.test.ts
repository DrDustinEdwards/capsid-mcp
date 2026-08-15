import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_NAMESPACE } from "../src/limits.ts";
import { LINK_TYPES, parseLinks } from "../src/links.ts";

test("parseLinks accepts an edge and defaults to_ns to the source namespace", () => {
  const result = parseLinks('[{"type":"references","to_path":"decisions.md"}]', "capsid");
  assert.deepEqual(result, { edges: [{ type: "references", to_ns: "capsid", to_path: "decisions.md" }] });
});

test("parseLinks keeps an explicit to_ns", () => {
  const result = parseLinks('[{"type":"governs","to_path":"core.md","to_ns":"recova"}]', "capsid");
  assert.deepEqual(result, { edges: [{ type: "governs", to_ns: "recova", to_path: "core.md" }] });
});

test("parseLinks treats an empty array as clear", () => {
  assert.deepEqual(parseLinks("[]", "capsid"), { edges: [] });
});

test("parseLinks rejects a non-array", () => {
  const result = parseLinks('{"type":"references","to_path":"x"}', "capsid");
  assert.ok("error" in result && /must be a JSON array/.test(result.error));
});

test("parseLinks rejects an unknown type", () => {
  const result = parseLinks('[{"type":"mentions","to_path":"x"}]', "capsid");
  assert.ok("error" in result && /type in governs/.test(result.error));
});

test("parseLinks rejects a missing to_path", () => {
  const result = parseLinks('[{"type":"references"}]', "capsid");
  assert.ok("error" in result && /to_path/.test(result.error));
});

test("parseLinks rejects invalid JSON", () => {
  const result = parseLinks("{not json", "capsid");
  assert.ok("error" in result && /invalid links JSON/.test(result.error));
});

// THE ENDPOINT GRAMMAR (quality audit 3.6). Ruled 2026-08-17: an edge endpoint is
// a document key, so it is held to the SAME grammar as a document path. Before
// this, write refused '../x' as a path and stored it happily as an edge.
test("an edge endpoint is held to the document path grammar", () => {
  const cases: Array<[string, RegExp]> = [
    ["../escape.md", /must not contain '\.\.'/],
    ["/etc/passwd", /must not start/],
    ["a//b.md", /empty segment/],
    ["notes/", /must not end/],
  ];
  for (const [to_path, expected] of cases) {
    const result = parseLinks(JSON.stringify([{ type: "references", to_path }]), "capsid");
    assert.ok("error" in result, `${to_path} was accepted as an edge endpoint`);
    assert.match(result.error, /is not a document path/);
    assert.match(result.error, expected);
  }
});

test("an edge namespace is held to the SAME namespace rule the tools use", () => {
  // That rule is nsName, which today bounds LENGTH and nothing else: there is no
  // character grammar for a namespace anywhere in the server, unlike paths. This
  // asserts what the shared rule actually does rather than what the name suggests,
  // so it keeps passing if nsName is tightened later and fails if it is dropped.
  const tooLong = "n".repeat(MAX_NAMESPACE + 1);
  const result = parseLinks(JSON.stringify([{ type: "references", to_path: "core.md", to_ns: tooLong }]), "capsid");
  assert.ok("error" in result, "an unbounded namespace was accepted on an edge");
  assert.match(result.error, /is not a namespace name/);
});

test("the shapes the live store actually holds still parse", () => {
  // Measured 2026-08-17 before enforcing: all 96 edges resolve to real documents
  // and none would be rejected. These are the shapes among them, including the
  // archive/ prefix and a nested path, so the rule cannot tighten past the data.
  for (const to_path of ["core.md", "archive/session-2026-08-09.md", "parity/PARITY-LEDGER.md", "TASK-brake-followup-3.md"]) {
    const result = parseLinks(JSON.stringify([{ type: "governs", to_path }]), "capsid");
    assert.ok("edges" in result, `${to_path} was rejected but exists in the live store`);
    assert.equal(result.edges[0].to_path, to_path);
  }
});

test("the link vocabulary is closed, and the error names the whole set", () => {
  const result = parseLinks('[{"type":"mentions","to_path":"core.md"}]', "capsid");
  assert.ok("error" in result);
  for (const type of LINK_TYPES) assert.match(result.error, new RegExp(type));
});

