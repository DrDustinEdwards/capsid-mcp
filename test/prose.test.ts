import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// THE MANNERED-PROSE GUARD (hard rule 12).
//
// Mannered prose substitutes metaphor and flourish for direct statement. The rule
// governs every piece of prose this repo carries; this guard covers the two that
// a machine can check, README.md and docs/. It is deliberately narrower than the
// rule: a phrase list cannot catch a flourish it has never seen, and comments and
// commit messages are scanned by nothing. A hit here is not a style opinion, it is
// a phrase the rule names.
//
// Adding a phrase to this list is cheap. Removing one needs a reason written down.

const ROOT = join(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");

const BANNED: Array<[RegExp, string]> = [
  [/\bload[- ]bearing\b/i, '"load-bearing" (say "important", or name what breaks without it)'],
  [/\bearns its keep\b/i, '"earns its keep" (say "still matters")'],
  [/\btapestry\b/i, '"tapestry"'],
  [/\bdelve\w*\b/i, '"delve" (say "read", "look at", "go through")'],
  [/\bjourney\b/i, '"journey"'],
  [/\blandscape\b/i, '"landscape"'],
  [/\bnavigat\w*\b/i, '"navigate" (say "move through", "get to", "handle")'],
  [/\btestament\b/i, '"testament"'],
  // The "it's not X, it's Y" construction, in both contractions and both tenses.
  [
    /\b(?:it's|it is|this isn't|this is not)\s+not\b[^.!?\n]{1,60}?,\s*(?:it's|it is)\b/i,
    'the "it\'s not X, it\'s Y" construction (state what it is, and stop)',
  ],
];

function scannable(): Array<{ rel: string; text: string }> {
  const files = [{ rel: "README.md", text: readFileSync(join(ROOT, "README.md"), "utf8") }];
  for (const name of readdirSync(DOCS).filter((f) => f.endsWith(".md")).sort()) {
    files.push({ rel: `docs/${name}`, text: readFileSync(join(DOCS, name), "utf8") });
  }
  return files;
}

// The count check that stops this suite passing by reading nothing. A glob that
// silently matches zero files, or a docs/ that moved, would otherwise report
// "no banned phrases" as loudly as a clean repo does.
test("the prose guard actually read the files it claims to scan", () => {
  const files = scannable();
  assert.ok(files.length >= 4, `expected README.md plus the docs, scanned ${files.length} files`);
  assert.ok(
    files.every((f) => f.text.length > 1000),
    `a scanned file came back nearly empty: ${files.map((f) => `${f.rel}=${f.text.length}`).join(", ")}`
  );
  assert.ok(BANNED.length >= 9, "the banned-phrase list was emptied out");
});

test("no mannered prose in README.md or docs/", () => {
  const hits: string[] = [];
  for (const { rel, text } of scannable()) {
    const lines = text.split("\n");
    for (const [pattern, what] of BANNED) {
      for (const [i, line] of lines.entries()) {
        const m = pattern.exec(line);
        if (m) hits.push(`${rel}:${i + 1} uses ${what}\n      ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `mannered prose found (hard rule 12):\n    ${hits.join("\n    ")}`);
});
