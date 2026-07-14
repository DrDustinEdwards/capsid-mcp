import assert from "node:assert/strict";
import { test } from "node:test";
import { hasWideDash, normalizeDashes } from "../src/normalize.ts";

test("prose em dash collapses to a comma-space", () => {
  assert.equal(normalizeDashes("the shell — the capsid"), "the shell, the capsid");
});

test("word-hugging em dash collapses to a comma-space", () => {
  assert.equal(normalizeDashes("word—word"), "word, word");
});

test("horizontal bar is treated like an em dash", () => {
  assert.equal(normalizeDashes("a ― b"), "a, b");
});

test("title mode uses a spaced hyphen", () => {
  assert.equal(normalizeDashes("capsid — core", "title"), "capsid - core");
});

test("markdown heading lines in a body use a spaced hyphen, prose uses a comma", () => {
  assert.equal(
    normalizeDashes("# capsid — core\nthe shell — the capsid"),
    "# capsid - core\nthe shell, the capsid"
  );
});

test("numeric en-dash range becomes a plain hyphen", () => {
  assert.equal(normalizeDashes("built 2014–2018 in total"), "built 2014-2018 in total");
});

test("spaced en dash used as an em dash collapses to a comma-space", () => {
  assert.equal(normalizeDashes("a – b"), "a, b");
});

test("text with no wide dashes is returned unchanged", () => {
  assert.equal(normalizeDashes("plain ascii text, with a comma"), "plain ascii text, with a comma");
});

test("empty input is returned as-is", () => {
  assert.equal(normalizeDashes(""), "");
});

test("output never contains a wide dash", () => {
  const dirty = "one — two – three ― four, range 2001–2002";
  const clean = normalizeDashes(dirty);
  assert.equal(hasWideDash(clean), false);
});

test("hasWideDash detects each wide-dash character", () => {
  assert.equal(hasWideDash("a — b"), true);
  assert.equal(hasWideDash("a – b"), true);
  assert.equal(hasWideDash("a ― b"), true);
  assert.equal(hasWideDash("a - b"), false);
});
