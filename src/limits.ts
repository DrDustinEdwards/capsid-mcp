// Input bounds and the document path grammar.
//
// Every string a tool accepts was unbounded, so any of them could be handed
// megabytes, and document paths were whatever the caller typed: a leading slash,
// a "..", a newline, or an empty string all went straight into the
// UNIQUE(namespace, path) key and into every audit row and R2 mirror key derived
// from it.
//
// THE BOUNDS ARE MEASURED, NOT GUESSED, against the live store on 2026-08-17.
// The one that matters is `body`: it is set from the largest VERSION row, not the
// largest document, because restore writes a stored snapshot back through the
// write path and a bound under that figure would make the largest snapshots
// unrestorable. The ceiling stays under D1's own row limit. The full table, and
// the measurement that the whole store already satisfies the grammar below, is in
// capsid/archive/TASK-capsid-audit-2026-08-17.md (finding F29).
//
// NO archive/ RULE, and that is a measurement rather than an oversight: 41% of
// the live store already sits under that prefix, so a rule against writing there
// would refuse every future append, patch or meta on it, and would refuse restore
// of a deleted archived document, which is the one case restore exists for. What
// the grammar exists to stop is traversal, and it does.

import { z } from "zod";

// Repo file paths take this bound too, but are deliberately NOT held to docPath's
// grammar: a GitHub path is whatever the repo contains, and the grammar is about
// what may become a D1 key, an R2 object key and an edge endpoint.
export const MAX_PATH = 512;
export const MAX_TITLE = 1024;
export const MAX_TAGS = 1024;
export const MAX_NAMESPACE = 64;
export const MAX_DOC_TYPE = 64;
// Separate from MAX_DOC_TYPE despite the same value: different vocabularies, and
// a bound named after the other one silently retunes both.
export const MAX_DOC_STATUS = 64;
export const MAX_BODY = 1_000_000;
export const MAX_LINKS_JSON = 8192;
export const MAX_REPOS_JSON = 4096;
export const MAX_QUERY = 512;
export const MAX_GLOB = 512;
export const MAX_REF = 255;
export const MAX_REPO_SELECTOR = 256;
export const MAX_SHA = 128;
export const MAX_COMMIT_MESSAGE = 4096;
export const MAX_PR_TITLE = 512;
export const MAX_PR_BODY = 65_536;

// OUTPUT BOUNDS. Everything above bounds what a caller may SEND. These bound what
// the server may RETURN, which until 2026-08-17 only `search` and `brief` did.
//
// MEASURED, not guessed (live store, 2026-08-17): 557 documents across 8
// namespaces, the largest namespace holding 245. MAX_ROWS is set above that and
// below the total on purpose, so a namespace-scoped list or find never truncates
// today while the unfiltered whole-store read does, and is told to add a filter.
// An unbounded read is not a bug until the store grows, which is exactly why it
// gets bounded before it does.
export const MAX_ROWS = 500;

// search ranks by bm25 and has always returned 25. Unchanged; what changed is that
// it now SAYS when there were more, which a bare array could not.
export const SEARCH_ROWS = 25;

// Here rather than at the call site so the number and the prose quoting it cannot
// drift apart.
export const BRIEF_BUDGET = 40_000;

// Enforced by trimming, not warned about: real packets measured 213KB and 330KB
// against this threshold, and a warning that fires on the normal case is not a
// bound.
export const GATHER_BUDGET = 150_000;

// Four statements per path plus an audit row: 20 paths is 81, under D1's
// 100-statement batch ceiling with the archive still ATOMIC. Chunking was
// rejected because a partial archive silently drops documents out of the lint
// loop's view.
export const LINT_CONSUMED_MAX = 20;

// GitHub's own workflow_dispatch ceiling, so a larger map can never be valid.
export const CI_DISPATCH_MAX_INPUTS = 10;

// Retention is 90 days, so 100 rows covers better than a snapshot a day.
export const HISTORY_ROWS = 100;

// Here rather than inside searchCode, so the clamp and the tool description that
// quotes it are the same number.
export const MAX_SCAN_CAP = 200;
export const DEFAULT_SCAN_RESULTS = 20;
export const DEFAULT_SCAN_FILES = 200;

// Control characters, including the newline and tab that would otherwise ride
// through a path and out into an R2 key and every log line that quotes it.
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// Returns a caller-facing reason, or null when the path is acceptable. Written as
// a plain function rather than a regex so each rejection can say which rule it
// broke; a path refused with "invalid path" is a support ticket.
export function pathProblem(path: string): string | null {
  if (path.length === 0) return "path must not be empty";
  if (path.length > MAX_PATH) return `path is longer than ${MAX_PATH} characters`;
  if (path.startsWith("/")) return "path must not start with '/': paths are relative to the namespace";
  if (path.endsWith("/")) return "path must not end with '/': it names a document, not a directory";
  if (path.includes("..")) return "path must not contain '..'";
  if (path.includes("//")) return "path must not contain an empty segment ('//')";
  if (hasControlChar(path)) return "path must not contain control characters (including newlines and tabs)";
  return null;
}

// THE GITHUB REPO ARGUMENT GRAMMAR, for repo paths, branches, refs and workflow
// filenames. Deliberately LOOSER than docPath, because a repo path is whatever
// the repo contains, and it rejects only what lets a caller walk out of the
// mapped repo once the string is concatenated into an API URL: a segment that IS
// "." or "..", and control characters.
//
// A WHOLE-SEGMENT check, not includes(".."), because "a..b" is a legal file name
// and only a segment that is exactly ".." moves the URL. This closed a real
// traversal: encodeURIComponent leaves "." and ".." untouched, so
// "../../other-repo/contents/x" reached fetch() intact and URL normalization
// walked it into a repo the namespace never mapped.
export function repoPathProblem(value: string): string | null {
  if (value.length === 0) return "must not be empty";
  if (value.length > MAX_PATH) return `is longer than ${MAX_PATH} characters`;
  if (hasControlChar(value)) return "must not contain control characters (including newlines and tabs)";
  if (value.startsWith("/")) return "must not start with '/'";
  if (value.endsWith("/")) return "must not end with '/'";
  if (value.includes("//")) return "must not contain an empty segment ('//')";
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") return "must not contain a '.' or '..' path segment";
  }
  return null;
}

// The one document path schema, so the grammar cannot be enforced in one place
// and forgotten in another. It is NOT the GitHub grammar above and must not
// become it: this one governs what may become a D1 key, an R2 mirror key and an
// edge endpoint.
export const docPath = z.string().superRefine((value, ctx) => {
  const problem = pathProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

// Every free-text input goes through this, so a bare z.string() in a tool schema
// is a visible anomaly. test/limits.test.ts fails if one appears.
export const bounded = (max: number) => z.string().max(max);

export const nsName = bounded(MAX_NAMESPACE);
