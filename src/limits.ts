import { z } from "zod";

// Repo file paths take this bound too, but are not held to docPath's grammar:
// a GitHub path is whatever the repo contains.
export const MAX_PATH = 512;
export const MAX_TITLE = 1024;
export const MAX_TAGS = 1024;
export const MAX_NAMESPACE = 64;
export const MAX_DOC_TYPE = 64;
// Separate from MAX_DOC_TYPE despite the same value: different vocabularies.
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
// A review comment. Smaller than a PR body on purpose: a verdict plus its reasons is
// a paragraph, and GitHub's own comment ceiling is 65_536 either way.
export const MAX_PR_COMMENT = 16_384;

export const MAX_ROWS = 500;
export const SEARCH_ROWS = 25;
export const BRIEF_BUDGET = 40_000;
// Enforced by trimming, not warned about.
export const GATHER_BUDGET = 150_000;
// Four statements per path plus an audit row: 20 paths is 81, under D1's
// 100-statement batch ceiling.
export const LINT_CONSUMED_MAX = 20;
export const CI_DISPATCH_MAX_INPUTS = 10;
export const HISTORY_ROWS = 100;
export const MAX_SCAN_CAP = 200;
export const DEFAULT_SCAN_RESULTS = 20;
export const DEFAULT_SCAN_FILES = 200;

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

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

// Whole-segment check, not includes(".."): "a..b" is a legal file name.
// encodeURIComponent leaves "." and ".." untouched.
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

export const docPath = z.string().superRefine((value, ctx) => {
  const problem = pathProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

// Every free-text input goes through this, so a bare z.string() in a tool schema
// is a visible anomaly. test/limits.test.ts fails if one appears.
export const bounded = (max: number) => z.string().max(max);

export const nsName = bounded(MAX_NAMESPACE);

// A job's result_ref is "where the work landed", and that is two different kinds
// of thing: a document key inside the store, or a pull request URL outside it.
// It was wired to docPath, which refuses every URL on the '//' after the scheme,
// so the field was unusable for one of the two shapes its own description
// advertises. Two jobs recorded their PR link in result_summary prose instead.
//
// The URL half is deliberately narrow. This value is rendered into the job's
// mirror document as a link a human may click, so the scheme is pinned to https
// (the old grammar accepted "javascript:alert(1)" as a path) and embedded
// credentials are refused, being a phishing shape rather than a reference.
export function resultRefProblem(value: string): string | null {
  if (value.length === 0) return "result ref must not be empty";
  if (value.length > MAX_PATH) return `result ref is longer than ${MAX_PATH} characters`;
  if (hasControlChar(value)) return "result ref must not contain control characters (including newlines and tabs)";
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return pathProblem(value);

  if (!value.startsWith("https://")) return "a result ref URL must use https";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "result ref is not a valid URL";
  }
  if (url.username || url.password) return "a result ref URL must not carry credentials";
  if (!url.hostname) return "a result ref URL must name a host";
  return null;
}

export const resultRef = bounded(MAX_PATH).superRefine((value, ctx) => {
  const problem = resultRefProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
