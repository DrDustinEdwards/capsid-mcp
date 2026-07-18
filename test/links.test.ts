import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLinks } from "../src/links.ts";

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
