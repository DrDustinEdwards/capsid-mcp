// Input bounds and the document path grammar (audit 2, F29 and F7).
//
// Every string a tool accepts was unbounded, so any of them could be handed
// megabytes, and document paths were whatever the caller typed: a leading slash, a
// "..", a newline, or an empty string all went straight into the UNIQUE(namespace,
// path) key and into every audit row and R2 mirror key derived from it.
//
// THE BOUNDS ARE MEASURED, NOT GUESSED. Read-only queries against the live store on
// 2026-08-17, 536 documents and 1,328 version rows:
//
//   field         largest stored   bound here   headroom
//   path                      83          512       6.2x
//   title                    382        1,024       2.7x
//   tags                     265        1,024       3.9x
//   namespace                 13           64       4.9x
//   body (documents)      74,625    1,000,000       13x
//   body (versions)      138,727    1,000,000        7x
//   repos JSON               165        4,096        25x
//   links JSON        4 edges/doc        8,192        ~20x
//
// The version-row figure is the one that sets the body bound, because restore
// writes a stored snapshot back through the write path: a bound under 138,727 would
// have made the largest snapshots unrestorable, which is the opposite of the point.
// The ceiling is also comfortably under D1's own 2,000,000 byte row limit.
//
// The same queries checked every existing row against the grammar below: zero
// leading slashes, zero "..", zero control characters, zero empty paths, zero
// double slashes, zero trailing slashes, in both documents and document_versions.
// Nothing in the store is bricked by enforcing this.
//
// NO archive/ RULE. The batch asked for archive/ to be allowed "only where
// archiving intends it" and the measurement is why that is not here: 219 of 536
// live documents already sit under archive/, so a rule against writing to that
// prefix would refuse every future append, patch or meta on 41% of the store, and
// would refuse restore of a deleted archived document, which is the one case
// restore exists for. archive/ is an ordinary directory to this grammar; what the
// grammar exists to stop is traversal, and it does.

import { z } from "zod";

// THE DOCUMENT PATH BOUND. Repo file paths are bounded by this number too, but
// they are deliberately NOT held to docPath's grammar (quality audit 7.2): a
// GitHub path is whatever the repo contains, and this grammar is about what may
// become a D1 key, an R2 object key and an edge endpoint. Repo tools take
// bounded(MAX_PATH); only Capsid documents take docPath.
export const MAX_PATH = 512;
export const MAX_TITLE = 1024;
export const MAX_TAGS = 1024;
export const MAX_NAMESPACE = 64;
export const MAX_DOC_TYPE = 64;
// `status` had been bounded by MAX_DOC_TYPE since there was one number and two
// fields (quality audit 2.3). They are different vocabularies, and a bound named
// after the other one is a rule nobody can check: the next person tightening
// document types would have silently retuned the status field too. Same value
// today, stated separately so they can move apart.
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

// brief's existing budget, unchanged, moved here so the number and the prose that
// quotes it cannot drift apart.
export const BRIEF_BUDGET = 40_000;

// gather's budget was already this number, but only as a WARNING threshold, and
// the packets measured over it: recova 213KB, dustinedwards 330KB. A warning that
// fires on the normal case is not a bound. Same number, now enforced by trimming
// the section gather itself tells the caller to batch.
export const GATHER_BUDGET = 150_000;

// search_code's ceiling, here rather than inside searchCode (quality audit 2.4).
// It lived as a local const, so the tool description quoting "max 200" was a
// second copy of the number that nothing could keep honest. Both the clamp and
// the prose read this now.
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

// The one document path schema. Every tool that names a document uses it, so the
// grammar cannot be enforced in one place and forgotten in another.
//
// It is NOT the GitHub path grammar and must not become it. A repo file path is
// whatever the repo already contains, and refusing to read one because Capsid
// dislikes its shape would make the repo tools unable to reach real files. This
// grammar governs what may become a D1 key, an R2 mirror key and a typed edge
// endpoint, which is a different question with a different blast radius.
export const docPath = z.string().superRefine((value, ctx) => {
  const problem = pathProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

// Every free-text input goes through this, so an unbounded z.string() in a tool
// schema is a visible anomaly rather than the default. test/limits.test.ts fails
// if one appears.
export const bounded = (max: number) => z.string().max(max);

export const nsName = bounded(MAX_NAMESPACE);
