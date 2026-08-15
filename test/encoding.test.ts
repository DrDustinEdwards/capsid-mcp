import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlDecode, b64urlEncode, base64Decode, base64Encode, bytesToHex } from "../src/encoding.ts";
import { sourceFiles } from "./source-files.ts";

// src/encoding.ts: the byte encodings, defined once.
//
// Split out of limits.test.ts (quality audit 6.6), where it was one of five
// unrelated subjects under a name that described only one of them.

test("the shared encoders round-trip, including non-ASCII and padding cases", () => {
  for (const text of ["", "a", "ab", "abc", "hello world", "café ✓ 中文"]) {
    assert.equal(b64urlDecode(b64urlEncode(text)), text, `b64url round-trip failed for ${text}`);
    assert.equal(base64Decode(base64Encode(text)), text, `base64 round-trip failed for ${text}`);
  }
  // url-safe alphabet, no padding: this is what the JWT and the cookie depend on.
  const encoded = b64urlEncode("??>>??>>");
  assert.doesNotMatch(encoded, /[+/=]/);
  // GitHub wraps its base64 across lines; atob rejects that without the strip.
  assert.equal(base64Decode("aGVsbG8g\nd29ybGQ="), "hello world");
  assert.equal(bytesToHex(new Uint8Array([0, 15, 16, 255])), "000f10ff");
});

test("one base64 and one hex implementation, across ALL of src/", () => {
  // Widened from a two-file list to the whole directory (quality audit 1.1).
  // Duplicated crypto-adjacent helpers are not a tidiness problem: they drift, and
  // the copy nobody looked at is the one that mishandles the padding or the high
  // byte. A new module rolling its own was invisible to the old two-file check.
  const reimplementers = sourceFiles()
    .filter((f) => f.name !== "encoding.ts")
    .filter((f) => /btoa\(binary\)/.test(f.text) || /toString\(16\)\.padStart\(2, "0"\)/.test(f.text))
    .map((f) => `src/${f.name}`);
  assert.deepEqual(reimplementers, [], "these files re-implement an encoder that src/encoding.ts already exports");

  // Vacuity guard: encoding.ts must still BE the implementation, or the scan
  // above passes because nobody encodes anything anywhere.
  const encoding = sourceFiles().find((f) => f.name === "encoding.ts");
  assert.ok(encoding, "src/encoding.ts is gone");
  assert.match(encoding.text, /toString\(16\)\.padStart\(2, "0"\)/, "encoding.ts no longer implements the hex encoder");
  assert.match(encoding.text, /btoa\(binaryFromBytes/, "encoding.ts no longer implements base64");

  // And the consumers import it rather than having quietly stopped needing it.
  const importers = sourceFiles().filter((f) => /from "\.\/encoding"/.test(f.text)).map((f) => f.name);
  assert.ok(importers.length >= 3, `only ${importers.length} modules import the shared encoders: ${importers.join(", ")}`);
});
