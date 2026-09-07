// GitHub App repo access for Capsid's repo fallthrough.
//
// Mints short-lived installation tokens from the App private key (RS256 JWT via
// Web Crypto) and caches them in APP_KV for ~55 minutes. Resolves the target
// repo per namespace from the D1 namespaces table, then reads and writes files
// over the live GitHub REST API. No PAT, no clone.

import { b64urlFromBytes, b64urlEncode, base64Decode, base64Encode } from "./encoding";
import { IMPROVE_BRANCH_PREFIX, isImproveBranch, SCORER_WORKFLOW } from "./improve-schema";
import { DEFAULT_SCAN_FILES, DEFAULT_SCAN_RESULTS, MAX_SCAN_CAP, pathProblem, repoPathProblem } from "./limits";
// AttemptEnv, not Env, and the narrowing is deliberate rather than cosmetic.
//
// Nothing in this module needs the holdout bucket, and saying so in the type is
// what lets src/improve-attempt.ts push a branch while remaining structurally
// unable to read the hidden suite. Env is assignable to AttemptEnv, so every
// pre-existing caller is unaffected; what changes is that a future edit here
// cannot quietly reach for env.HOLDOUT, because on this type it does not exist.
import type { AttemptEnv as Env } from "./env";

const GH = "https://api.github.com";
const GH_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "capsid-mcp",
};

const TOKEN_TTL_SECONDS = 3300; // installation tokens live 60 min; refresh a little early
const INSTALL_TTL_SECONDS = 86400; // installation id is stable
const READ_CACHE_TTL_SECONDS = 60; // brief cache for read tools

// EVERY APP_KV KEY THIS MODULE OWNS IS BUILT HERE. A call site that spells a key
// inline is a key the invalidator below cannot find, and the read cache is exactly
// the place where an unfindable key means serving a body that no longer exists.
//
// The v2 on the install and token keys is a rollout guard, not decoration. Until
// 2026-08-17 a pinned GITHUB_APP_INSTALLATION_ID was written to gh:install:<owner>
// for EVERY owner (see getInstallationId), so an entry written before this deploy
// can hold one owner's installation id under another owner's name, with 24 hours
// to run. Fixing the writer does not fix the entries it already wrote, so the
// reader stops looking at them.
const installKey = (owner: string) => `gh:install:v2:${owner}`;
// v3 and keyed per owner AND repo (audit 2026-09-06, Grok MAJOR 10): tokens are
// minted scoped to one repo below, so a cached one must never answer for a
// sibling repo, and the v2 unscoped tokens age out rather than being reused.
const tokenKey = (owner: string, repo: string) => `gh:token:v3:${owner}/${repo}`;
const readKey = (path: string) => `gh:get:${path}`;
// The trailing slash matters: without it, owner/r would also match owner/repo2.
const readPrefix = (owner: string, repo: string) => `gh:get:/repos/${owner}/${repo}/`;

export interface RepoRef {
  owner: string;
  repo: string;
  full: string;
}

// ---- base64url + key handling ------------------------------------------------

let cachedKey: { pem: string; key: CryptoKey } | null = null;

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.pem === pem) return cachedKey.key;
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  cachedKey = { pem, key };
  return key;
}

async function createAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App not configured: set GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify({ iss: env.GITHUB_APP_CLIENT_ID, iat: now - 60, exp: now + 540 }));
  const signingInput = `${header}.${payload}`;
  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`;
}

// ---- installation token ------------------------------------------------------

async function appFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const jwt = await createAppJwt(env);
  return fetch(`${GH}${path}`, {
    ...init,
    headers: { ...GH_HEADERS, ...(init?.headers as Record<string, string>), Authorization: `Bearer ${jwt}` },
  });
}

// RESOLVED PER OWNER AND REPO, ALWAYS (audit 2, F20).
//
// This used to short-circuit on a pinned GITHUB_APP_INSTALLATION_ID and write that
// one id under gh:install:<owner> for whatever owner was asked for. One id cannot be
// right for two owners: a namespace mapped to a second owner then minted tokens
// against the first owner's installation and kept doing it for 24 hours, and the
// symptom is a 404 on a repo that plainly exists.
//
// The pin is gone rather than kept as a hint. It was a mirror of something GitHub
// answers authoritatively for the exact repo being asked about, one cached call per
// owner per day, and a mirror that can disagree with the source eventually does.
// Keeping it would have meant adding a second secret naming the owner it applies to,
// which is more configuration for no capability.
async function getInstallationId(env: Env, owner: string, repo: string): Promise<string> {
  const cached = await env.APP_KV.get(installKey(owner));
  if (cached) return cached;
  const resp = await appFetch(env, `/repos/${owner}/${repo}/installation`);
  if (!resp.ok) {
    // 404 here is diagnostic rather than opaque: a valid App JWT with no
    // installation covering the repo answers 404, while a bad JWT answers 401
    // (measured 2026-07-06). So a 404 means the credentials are fine and the App
    // is not installed on that repo.
    throw new Error(
      `could not resolve GitHub App installation for ${owner}/${repo} (${resp.status}): ${await resp.text()}` +
        (resp.status === 404 ? " (404 means the App is not installed on this repo; the credentials are fine)" : "")
    );
  }
  const data = (await resp.json()) as { id: number };
  const id = String(data.id);
  await env.APP_KV.put(installKey(owner), id, { expirationTtl: INSTALL_TTL_SECONDS });
  return id;
}

async function getInstallationToken(env: Env, owner: string, repo: string): Promise<string> {
  const cacheKey = tokenKey(owner, repo);
  const cached = await env.APP_KV.get(cacheKey);
  if (cached) return cached;
  const installationId = await getInstallationId(env, owner, repo);
  // SCOPED TO THE ONE REPO BEING ASKED ABOUT (audit 2026-09-06, Grok MAJOR 10).
  // An access_tokens POST with no body mints a token for every repo the
  // installation covers, and that token then sits in APP_KV: anything that can
  // read the KV entry holds the whole portfolio. With `repositories` it holds
  // exactly the repo the caller resolved, which is all any call path here needs.
  const resp = await appFetch(env, `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [repo] }),
  });
  if (!resp.ok) throw new Error(`installation token request failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { token: string };
  await env.APP_KV.put(cacheKey, data.token, { expirationTtl: TOKEN_TTL_SECONDS });
  return data.token;
}

// One installation covers every repo under a single owner, but each minted token
// is scoped to one repo, so the cache is per owner+repo to match.
// THE URL BUILT FOR A REPO CALL CANNOT ESCAPE /repos/<owner>/<repo>/ (audit
// 2026-09-06, CRITICAL). Every ghFetch/cachedGet path in this module is under that
// prefix; a "../.." smuggled through a file path or branch used to normalize out of
// it once fetch() parsed the string as a URL. This is the belt-and-suspenders check
// that runs AFTER assembly and AFTER WHATWG normalization, so it sees the escape the
// input-level repoPathProblem guard is also there to stop. owner and repo come from
// the namespace mapping (REPO_SHAPE excludes "." and ".."), so the expected base is
// itself traversal-free.
//
// It builds the same URL new URL() will, which is exactly why a fake fetch keyed on
// the raw concatenated string cannot substitute for this guard: the raw string still
// contains the "..", the parsed pathname does not.
function repoApiUrl(owner: string, repo: string, path: string): string {
  const url = `${GH}${path}`;
  const base = `/repos/${owner}/${repo}`;
  const { pathname } = new URL(url);
  if (pathname !== base && !pathname.startsWith(`${base}/`)) {
    throw new Error(`refusing GitHub request that escapes ${base}: it resolves to ${pathname}`);
  }
  return url;
}

async function ghFetch(env: Env, owner: string, repo: string, path: string, init?: RequestInit): Promise<Response> {
  const url = repoApiUrl(owner, repo, path);
  const call = (token: string) =>
    fetch(url, {
      ...init,
      headers: { ...GH_HEADERS, ...(init?.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
  let resp = await call(await getInstallationToken(env, owner, repo));
  if (resp.status === 401) {
    await env.APP_KV.delete(tokenKey(owner, repo));
    resp = await call(await getInstallationToken(env, owner, repo));
  }
  return resp;
}

// The cache key is the full API path, which already carries owner, repo, the file
// path and the ref (as the literal ?ref= query), so entries for different refs are
// different keys and cannot collide. What was missing was deletion.
async function cachedGet(env: Env, owner: string, repo: string, path: string): Promise<Response> {
  // Assert the URL is in-bounds before it is ever used as a cache key, so a
  // traversal path cannot be stored under a key the invalidator will not find.
  repoApiUrl(owner, repo, path);
  const cacheKey = readKey(path);
  const cached = (await env.APP_KV.get(cacheKey, "json")) as { status: number; body: string } | null;
  if (cached) return new Response(cached.body, { status: cached.status });
  const resp = await ghFetch(env, owner, repo, path);
  const body = await resp.text();
  if (resp.ok) {
    await env.APP_KV.put(cacheKey, JSON.stringify({ status: resp.status, body }), { expirationTtl: READ_CACHE_TTL_SECONDS });
  }
  return new Response(body, { status: resp.status });
}

// INVALIDATION AFTER A WRITE (audit 2, F15). Nothing deleted these entries, so for
// up to READ_CACHE_TTL_SECONDS after a commit, read_repo_file returned the body the
// write replaced and list_repo_tree the listing it changed. Capsid writes to a repo
// and then reads it back, so this is the ordinary path, not a corner.
//
// Swept by REPO PREFIX rather than by computed key, deliberately. A key-precise
// invalidation has to reproduce the exact spelling of every entry the write
// affected: the file path through encodePath, the parent directory listing, the
// root listing's trailing slash, and each of those in both the no-ref spelling and
// the ?ref=<branch> spelling. Miss one spelling and the stale read survives while
// the code reads as though it were handled. The prefix sweep matches the SHAPE
// instead, so it cannot be defeated by a spelling, and it covers a merge, where the
// affected paths are not known here at all without another API call. It
// over-invalidates: a write on a work branch also drops the default branch's
// entries for that repo. That costs one GitHub GET on the next read, which is the
// cheaper side to be wrong on.
async function invalidateRepoReads(env: Env, owner: string, repo: string): Promise<number> {
  const prefix = readPrefix(owner, repo);
  let cursor: string | undefined;
  let deleted = 0;
  try {
    do {
      const page = await env.APP_KV.list({ prefix, cursor });
      // Per PAGE, not per key (quality audit 9.4). The deletes within a page are
      // independent of each other, and this runs on the write path where a caller
      // is waiting. Pages stay sequential because the next cursor is only known
      // once the current page returns.
      await Promise.all(page.keys.map((key) => env.APP_KV.delete(key.name)));
      deleted += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err) {
    // The commit already landed. Reporting the tool call as failed because a cache
    // sweep failed would be a lie about the write, so this is logged by name and
    // the stale window stays bounded by the 60 second TTL.
    console.error(
      `GH_CACHE_INVALIDATION_FAILED ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return deleted;
}

// ---- repo resolution ---------------------------------------------------------

// The shape of a single repos entry: "owner/name". Tightened 2026-09-06 from
// /^[^/\s]+\/[^/\s]+$/, which admitted "../other" as a legal mapping and made the
// authorization boundary itself traversable. GitHub owner and repo names are drawn
// from [A-Za-z0-9._-]; a segment that is exactly "." or ".." is additionally
// rejected by repoTokenOk below, because the charset alone still matches "..".
export const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// Neither side of an owner/name may be "." or "..": those are the tokens that walk
// a URL out of /repos/<owner>/<repo>/ even though they satisfy the charset.
export function repoTokenOk(repoFull: string): boolean {
  if (!REPO_SHAPE.test(repoFull)) return false;
  const [owner, name] = repoFull.split("/");
  return owner !== "." && owner !== ".." && name !== "." && name !== "..";
}

export interface RepoEntry {
  repo: string;
  label: string;
}

// Parse and validate a repos JSON array, shared by register_namespace and
// update_namespace: a non-empty array of { repo: "owner/name", label? } with
// label defaulting to "primary". Returns the normalized list or a caller-facing
// error string. It does NOT enforce a single primary; update_namespace layers
// that check on top.
export function parseReposList(reposJson: string): { list: RepoEntry[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reposJson);
  } catch (err) {
    return { error: `invalid repos JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "repos must be a non-empty JSON array of { repo, label } entries" };
  }
  const list: RepoEntry[] = [];
  for (const r of parsed) {
    if (!r || typeof r.repo !== "string" || !repoTokenOk(r.repo)) {
      return { error: `each repos entry needs a "repo" of the form owner/name (got ${JSON.stringify(r)})` };
    }
    list.push({ repo: r.repo, label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : "primary" });
  }
  return { list };
}

// update_namespace requires exactly one primary (register_namespace does not, so
// this is not folded into parseReposList). Returns an error string or null.
export function requireSinglePrimary(list: RepoEntry[]): string | null {
  const primaries = list.filter((r) => r.label === "primary").length;
  return primaries === 1 ? null : `repos must have exactly one entry labeled "primary" (found ${primaries})`;
}

// Resolve a namespace to one of its mapped repos. `selector` is the optional
// `repo` tool argument: a label from the namespace's repos array ("primary",
// "legacy") or a full "owner/name" that MUST appear in that array. The namespace
// mapping is the authorization boundary, so an unknown selector is rejected with
// the valid values rather than falling through to an arbitrary repo. With no
// selector the default is the entry labeled "primary" (or the first entry).
export async function resolveRepo(env: Env, namespace: string, selector?: string): Promise<RepoRef> {
  const row = await env.DB.prepare("SELECT repos FROM namespaces WHERE namespace = ?1")
    .bind(namespace)
    .first<{ repos: string }>();
  if (!row) throw new Error(`unknown namespace: ${namespace}`);
  // FAILS CLOSED (audit 2, F25). A corrupt repos column used to be swallowed into
  // an empty array and then reported as "has no repo mapping", which is a
  // different fact with a different fix: one says register a repo, the other says
  // a stored row is damaged. Worse, the two are indistinguishable to the caller,
  // so the damage reads as an unconfigured namespace and gets "fixed" by
  // overwriting the mapping.
  let list: Array<{ repo: string; label?: string }>;
  try {
    list = JSON.parse(row.repos || "[]");
  } catch (err) {
    throw new Error(
      `namespace ${namespace} has a CORRUPT repos mapping: the stored value is not valid JSON (${err instanceof Error ? err.message : String(err)}). Nothing was resolved. Repair it with update_namespace.`
    );
  }
  if (!Array.isArray(list)) {
    throw new Error(`namespace ${namespace} has a CORRUPT repos mapping: expected a JSON array, got ${typeof list}.`);
  }
  if (list.length === 0) throw new Error(`namespace ${namespace} has no repo mapping`);
  let chosen: { repo: string; label?: string } | undefined;
  if (selector) {
    chosen = list.find((r) => r.label === selector) ?? list.find((r) => r.repo === selector);
    if (!chosen) {
      const labels = list.map((r) => r.label).filter(Boolean).join(", ") || "(none)";
      const repos = list.map((r) => r.repo).join(", ");
      throw new Error(
        `repo '${selector}' is not mapped to namespace ${namespace}. Valid labels: ${labels}. Valid repos: ${repos}.`
      );
    }
  } else {
    chosen = list.find((r) => r.label === "primary") ?? list[0];
  }
  const [owner, repo] = chosen.repo.split("/");
  if (!owner || !repo) throw new Error(`invalid repo entry for ${namespace}: ${chosen.repo}`);
  return { owner, repo, full: chosen.repo };
}

// encodePath preserves the "/" between segments (a real repo path has directories),
// so it CANNOT be the place that stops traversal on its own: it is why "../../x"
// survived as real slashes plus real "..". It now refuses a "." or ".." segment as
// an inner guard, and repoApiUrl asserts the assembled URL as the outer one. Both
// are kept: this gives a clear caller-facing error, that catches anything this
// misses. Exported for the traversal test.
export function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment === "." || segment === "..") {
        throw new Error(`refusing repo path with a '${segment}' segment: ${path}`);
      }
      return encodeURIComponent(segment);
    })
    .join("/");
}

// Refuse a caller-supplied repo argument (path, branch, ref or workflow) at the
// door, with a message that names the argument. The URL assertion in repoApiUrl is
// the backstop; this is the friendly error and the guard for arguments that reach
// GitHub through encodeURIComponent (refs, workflow names) rather than encodePath.
export function assertRepoArg(kind: string, value: string): void {
  const problem = repoPathProblem(value);
  if (problem) throw new Error(`${kind} ${problem}`);
}

// ---- read --------------------------------------------------------------------

export async function listRepoTree(env: Env, namespace: string, path = "", ref?: string, repoSelector?: string) {
  if (path) assertRepoArg("path", path);
  if (ref) assertRepoArg("ref", ref);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const resp = await cachedGet(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}${query}`);
  if (!resp.ok) throw new Error(`list_repo_tree failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as unknown;
  const entries = Array.isArray(data) ? data : [data];
  return {
    repo: `${owner}/${repo}`,
    path: path || "/",
    entries: (entries as Array<{ path: string; type: string; size: number; sha: string }>).map((e) => ({
      path: e.path,
      type: e.type,
      size: e.size,
      sha: e.sha,
    })),
  };
}

export async function readRepoFile(env: Env, namespace: string, path: string, ref?: string, repoSelector?: string) {
  assertRepoArg("path", path);
  if (ref) assertRepoArg("ref", ref);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const resp = await cachedGet(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}${query}`);
  if (!resp.ok) throw new Error(`read_repo_file failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as
    | { type: string; content?: string; encoding?: string; size: number; sha: string }
    | unknown[];
  if (Array.isArray(data)) throw new Error(`${path} is a directory; use list_repo_tree`);
  if (data.type !== "file") throw new Error(`${path} is not a file (type: ${data.type})`);
  let content: string;
  if (data.encoding === "base64" && data.content) {
    content = base64Decode(data.content);
  } else {
    // Files over 1 MB come back without inline content; fetch the blob by sha.
    const blob = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/blobs/${data.sha}`);
    if (!blob.ok) throw new Error(`read_repo_file blob fetch failed (${blob.status})`);
    const blobData = (await blob.json()) as { content: string; encoding: string };
    content = base64Decode(blobData.content);
  }
  return { repo: `${owner}/${repo}`, path, size: data.size, sha: data.sha, content };
}

// search_code fallback: a server-side tree walk, not the REST search API.
//
// Verified 2026-07-17 via the live search_code tool: GitHub's GET /search/code
// returns HTTP 200 with total_count 0 and an empty items array for these private
// repos when queried with a GitHub App installation token, even for terms that
// read_repo_file confirms are present (e.g. "normalizeDashes"). It is not a 403
// or 422 (those would surface as an error); the code search index simply does
// not serve App-token requests on private repos, which is why both Capsid and
// the hosted GitHub connector returned 0. So we fetch the repo tree and grep the
// blobs ourselves instead of trusting the search index.
const SEARCH_EXCLUDE_DIRS = ["node_modules/", ".git/", "dist/"];
const SEARCH_EXCLUDE_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);
const SEARCH_EXCLUDE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tgz", "tar", "bz2",
  "woff", "woff2", "ttf", "otf", "eot", "mp4", "mov", "webm", "mp3", "wav", "wasm",
  "bin", "exe", "dll", "so", "dylib", "class", "jar", "pyc", "lockb",
]);
const SEARCH_BLOB_LIMIT = 200 * 1024; // skip blobs over 200KB
const SEARCH_TREE_LIMIT = 5000; // refuse to scan a tree bigger than this whole

// Statuses that mean the scan itself is compromised rather than one file being
// unavailable. 401 and 403 cover token expiry, revoked installation access, and
// GitHub's primary and secondary rate limits (both of which answer 403); 429 is
// the explicit rate-limit status. None of them are per-file conditions, so a
// scan that keeps going past one is reporting on a repository it did not read.
function isScanAbortingStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

export async function searchCode(
  env: Env,
  namespace: string | undefined,
  query: string,
  opts: { pathPrefix?: string; ref?: string; repoSelector?: string; maxResults?: number; maxFiles?: number; start?: number } = {}
) {
  if (!namespace) {
    throw new Error("search_code needs a namespace: it walks one repo's tree. Pass namespace (and optional repo).");
  }
  const { owner, repo, full } = await resolveRepo(env, namespace, opts.repoSelector);
  const ref = opts.ref || (await getDefaultBranch(env, owner, repo));
  // Capped server-side, the same shape ci_status already uses for its limit. The
  // schema only said "positive", so a caller could pass max_files: 100000 and the
  // walk would fetch one blob per candidate file: a single call that burns the App
  // installation's hourly quota and leaves every later search_code, and every
  // other repo tool, answering errors. The 5,000-blob tree refusal does not cover
  // it, because the cost is per file FETCHED, not per candidate listed. Over the
  // cap it clamps rather than refusing, because the result already reports
  // truncation honestly and carries a next_start to resume from.
  const maxResults = Math.min(opts.maxResults && opts.maxResults > 0 ? opts.maxResults : DEFAULT_SCAN_RESULTS, MAX_SCAN_CAP);
  const maxFiles = Math.min(opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : DEFAULT_SCAN_FILES, MAX_SCAN_CAP);
  const start = opts.start && opts.start > 0 ? Math.floor(opts.start) : 0;
  const pathPrefix = (opts.pathPrefix ?? "").replace(/^\/+/, "");

  // GitHub resolves a branch, tag, or sha for the tree sha here. recursive=1
  // returns the whole tree in one call.
  const treeResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (!treeResp.ok) throw new Error(`search_code tree fetch failed (${treeResp.status}): ${await treeResp.text()}`);
  const tree = (await treeResp.json()) as {
    tree: Array<{ path: string; type: string; sha: string; size?: number }>;
    truncated: boolean;
  };
  if (tree.truncated || tree.tree.length > SEARCH_TREE_LIMIT) {
    throw new Error(
      `search_code: ${full}@${ref} tree is too large to scan whole (${tree.tree.length} entries, truncated=${tree.truncated}). Narrow it with path_prefix.`
    );
  }

  const candidates = tree.tree.filter((e) => {
    if (e.type !== "blob") return false;
    if (pathPrefix && !e.path.startsWith(pathPrefix)) return false;
    if (SEARCH_EXCLUDE_DIRS.some((d) => e.path.startsWith(d) || e.path.includes(`/${d}`))) return false;
    const base = e.path.split("/").pop() ?? e.path;
    if (SEARCH_EXCLUDE_FILES.has(base)) return false;
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
    if (SEARCH_EXCLUDE_EXTS.has(ext)) return false;
    if (typeof e.size === "number" && e.size > SEARCH_BLOB_LIMIT) return false;
    return true;
  });

  const needle = query.toLowerCase();
  const items: Array<{ path: string; line: number; text: string }> = [];
  // Blobs that returned a survivable error. Reported so a caller can see that a
  // zero-result scan did not actually read everything it counted.
  const unreadable: string[] = [];
  let filesScanned = 0;
  let index = start;
  let stoppedAtFileCap = false;
  for (; index < candidates.length; index++) {
    if (filesScanned >= maxFiles) {
      // Cap reached before candidates[index] was scanned, so it is the first
      // unsearched file: a caller can resume the scan from here.
      stoppedAtFileCap = true;
      break;
    }
    filesScanned++;
    const c = candidates[index];
    const blob = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/blobs/${c.sha}`);
    if (!blob.ok) {
      // A blob this scan could not read is NOT the same as a blob with no match,
      // and conflating the two is how this tool lied. On 2026-08-10 a scan for
      // EMAIL_QUEUE across foxhound returned total_results 0 with
      // truncated=false while that string sat on three lines of one file: the
      // installation's rate limit was exhausted, every blob fetch 403'd, and
      // each one hit the bare `continue` that used to be here. The caller could
      // not distinguish "not present" from "not checked", which is the exact
      // fail-open capsid/conventions.md rules against for guards.
      //
      // Quota and auth failures abort the whole scan, because they do not
      // apply to one file: once the limit is hit every subsequent fetch fails
      // the same way, so continuing produces a confidently empty answer over an
      // unread repository. Everything else (a 404 on a raced deletion, a 5xx on
      // one blob) is survivable, so it is counted and reported instead.
      if (isScanAbortingStatus(blob.status)) {
        throw new Error(
          `search_code aborted at ${filesScanned} of ${candidates.length} candidate files: GitHub returned ${blob.status} fetching ${c.path}. ` +
            `This is NOT an empty result. The scan could not read the repository, so no conclusion about whether "${query}" is present is available. ` +
            (blob.status === 429 || blob.status === 403
              ? "The App installation's rate limit is the usual cause; a full-tree scan costs one request per candidate file. Wait for the window to reset, narrow with path_prefix, or verify against a local checkout."
              : "Check the App installation's permissions for this repo.")
        );
      }
      unreadable.push(c.path);
      continue;
    }
    const blobData = (await blob.json()) as { content?: string; encoding?: string };
    if (blobData.encoding !== "base64" || !blobData.content) continue;
    let text: string;
    try {
      text = base64Decode(blobData.content);
    } catch {
      continue; // binary that slipped past the extension filter
    }
    // Match line by line, then let text and its lines fall out of scope so only
    // one blob is ever held in memory at a time.
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && items.length < maxResults; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        items.push({ path: c.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
    if (items.length >= maxResults) {
      index++;
      break;
    }
  }

  const remaining = candidates.length - index;
  const result: {
    repo: string;
    ref: string;
    query: string;
    candidates: number;
    start: number;
    files_scanned: number;
    total_results: number;
    truncated: boolean;
    next_start?: number;
    note?: string;
    unreadable_files?: number;
    unreadable_sample?: string[];
    items: typeof items;
  } = {
    repo: full,
    ref,
    query,
    candidates: candidates.length,
    start,
    files_scanned: filesScanned,
    total_results: items.length,
    truncated: false,
    items,
  };

  // Surfaced rather than swallowed: "0 results over 200 files, 12 of which were
  // unreadable" is a different claim from "0 results over 200 files".
  if (unreadable.length > 0) {
    result.unreadable_files = unreadable.length;
    result.unreadable_sample = unreadable.slice(0, 10);
  }

  // A boolean alone is not actionable: say WHY it stopped and what to do next.
  if (stoppedAtFileCap && remaining > 0) {
    result.truncated = true;
    result.next_start = index;
    result.note =
      `Stopped at the max_files cap (${maxFiles}): ${remaining} of ${candidates.length} candidate files were not searched, so matches past this point are NOT included. ` +
      `Narrow with path_prefix (a subdirectory), or pass start=${index} to continue this scan from where it left off.`;
  } else if (items.length >= maxResults && remaining > 0) {
    result.truncated = true;
    result.note =
      `Returned the first ${maxResults} matches (max_results cap) with files still unsearched; more matches may exist. ` +
      `Raise max_results, or narrow with path_prefix.`;
  }

  return result;
}

// ---- write -------------------------------------------------------------------

async function getDefaultBranch(env: Env, owner: string, repo: string): Promise<string> {
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}`);
  if (!resp.ok) throw new Error(`repo lookup failed (${resp.status}): ${await resp.text()}`);
  return ((await resp.json()) as { default_branch: string }).default_branch;
}

async function getRefSha(env: Env, owner: string, repo: string, branch: string): Promise<string> {
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (!resp.ok) throw new Error(`ref lookup failed for ${branch} (${resp.status}): ${await resp.text()}`);
  return ((await resp.json()) as { object: { sha: string } }).object.sha;
}

async function getFileSha(env: Env, owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  if (resp.status === 404) return undefined;
  if (!resp.ok) throw new Error(`file sha lookup failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { sha: string } | unknown[];
  if (Array.isArray(data)) throw new Error(`${path} is a directory`);
  return data.sha;
}

async function putFile(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string
): Promise<{ commitSha: string; fileSha: string }> {
  const sha = await getFileSha(env, owner, repo, path, branch);
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: base64Encode(content),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`commit failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { commit: { sha: string }; content: { sha: string } };
  // Invalidation is NOT here any more: commitOnBranch owns it for every mutation
  // that goes through the shared dance, so there is one site rather than one per
  // verb (quality audit 1.5).
  return { commitSha: data.commit.sha, fileSha: data.content.sha };
}

// The create-a-work-branch step, shared by write_repo_file and delete_repo_file in
// pr mode (audit 2, F24). create_branch does NOT use it: as an explicit tool it must
// fail when the branch already exists, and this tolerates that case on purpose.
async function ensureBranch(env: Env, owner: string, repo: string, branch: string, fromSha: string): Promise<void> {
  const created = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  // 422 means the branch already exists, which is fine when a caller passed one.
  if (!created.ok && created.status !== 422) {
    throw new Error(`branch create failed (${created.status}): ${await created.text()}`);
  }
}

export async function createBranch(env: Env, namespace: string, branch: string, from?: string, repoSelector?: string) {
  assertRepoArg("branch", branch);
  if (from) assertRepoArg("from", from);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const base = from || (await getDefaultBranch(env, owner, repo));
  const sha = await getRefSha(env, owner, repo, base);
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  if (!resp.ok) throw new Error(`create_branch failed (${resp.status}): ${await resp.text()}`);
  return { repo: `${owner}/${repo}`, branch, from: base, sha };
}

// Branch from an exact COMMIT, which createBranch cannot do: it takes a branch
// name and resolves it to whatever that branch points at now. The improve loop
// needs the other thing, because its whole model is "branch from the commit the
// lineage picked", and that commit is frequently not the tip of anything.
//
// ensureBranch is used rather than a raw ref POST so an existing branch of the
// same name is not an error. An attempt id is unique, so a collision means a
// retry of the same attempt, and a retry should land on the branch it made.
export async function createBranchAt(
  env: Env,
  namespace: string,
  branch: string,
  sha: string,
  repoSelector?: string
): Promise<{ repo: string; branch: string; sha: string }> {
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  await ensureBranch(env, owner, repo, branch, sha);
  return { repo: full, branch, sha };
}

export async function openPr(
  env: Env,
  namespace: string,
  title: string,
  head: string,
  base?: string,
  body?: string,
  repoSelector?: string
) {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const baseBranch = base || (await getDefaultBranch(env, owner, repo));
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, head, base: baseBranch, body: body ?? "" }),
  });
  if (!resp.ok) throw new Error(`open_pr failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { number: number; html_url: string };
  return { repo: `${owner}/${repo}`, number: data.number, url: data.html_url, head, base: baseBranch };
}

// The repo this Worker deploys from. A write landing on its default branch is a
// production deploy of the server itself, which is why commitOnBranch refuses
// direct mode (and pr mode aimed at the default branch) against it.
export const SELF_REPO = "DrDustinEdwards/capsid-mcp";

function branchSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
}

// THE REPO MUTATION DANCE, once (quality audit 1.5).
//
// write_repo_file and delete_repo_file are the same six steps with a different
// verb in the middle: resolve the repo, find the default branch, cut a work branch
// in pr mode, mutate, INVALIDATE THE READ CACHE, and open a PR in pr mode. They
// were written out twice, and the specific hazard is the fifth step: a stale read
// cache serves the pre-write body for up to 60 seconds, and the third mutation to
// be added here would have had to remember a call that nothing enforces.
// Invalidation now happens once, in this function, on a path neither verb can
// skip.
//
// Response SHAPING deliberately stays with each caller. The two responses really
// do differ (write carries a fileSha, delete does not, and write's pr mode omits
// it), and folding those differences in here would either change what a caller
// sees or push per-verb conditionals into the shared step.
async function commitOnBranch<R>(
  env: Env,
  namespace: string,
  path: string,
  message: string,
  mode: "pr" | "direct",
  branch: string | undefined,
  repoSelector: string | undefined,
  op: {
    branchPrefix: string;
    fallbackTitle: string;
    prBody: string;
    mutate: (owner: string, repo: string, target: string) => Promise<R>;
  }
): Promise<{
  base: { repo: string; mode: "pr" | "direct"; branch: string; path: string };
  result: R;
  pr: { number: number; url: string } | null;
}> {
  assertRepoArg("path", path);
  if (branch) assertRepoArg("branch", branch);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  // THE SERVER'S OWN DEFAULT BRANCH CANNOT BE WRITTEN (audit 2026-09-06, Fable
  // MAJOR 8, the self-inflicted rug pull): CI deploys this Worker on every push
  // to its default branch, so a commit landing there IS a production deploy
  // behind nothing but a write-grant key.
  //
  // SCOPED TO THE DEFAULT BRANCH, 2026-09-07. It used to refuse mode "direct"
  // against this repo outright, regardless of which branch was named, and that
  // was too wide in a way nothing caught: the improve loop pushes every attempt
  // with writeRepoFile(..., "direct", <attempt branch>), so on the capsid
  // namespace, which maps to this very repo, EVERY attempt threw on its first
  // file. capsid sat on the roster with a pinned anchor and a 30-case holdout
  // while api mode could not complete a single attempt on it (Opus MAJOR 5.3;
  // Grok records the same collision under its section 5 CLEAN list).
  //
  // The deploy is what the refusal is about, and only the default branch
  // deploys. A commit to `improve/<attempt-id>` is not a deploy and never was.
  // What is refused is now exactly that: any write whose target branch is this
  // repo's default branch, in either mode, which also subsumes the old pr-mode
  // check below it.
  // The cheap half, kept from the 2026-09-06 fix: direct mode with NO branch
  // always resolves to the default branch, so it can be refused without knowing
  // what that branch is called, and the refusal costs no GitHub round trip.
  if (`${owner}/${repo}` === SELF_REPO && mode === "direct" && !branch) {
    throw new Error(
      `refuses: a direct commit with no branch lands on the default branch of this server's own repo (${SELF_REPO}) and redeploys the Worker. Name a work branch, or use mode "pr" and merge through manage_pr.`
    );
  }
  const defaultBranch = await getDefaultBranch(env, owner, repo);
  if (`${owner}/${repo}` === SELF_REPO && branch === defaultBranch) {
    throw new Error(
      `refuses: ${defaultBranch} is the default branch of this server's own repo (${SELF_REPO}), and a commit landing there redeploys the Worker. Use mode "pr" with a work branch and merge through manage_pr, or name a non-default branch.`
    );
  }
  const target =
    mode === "direct"
      ? branch || defaultBranch
      : branch || `${op.branchPrefix}${branchSlug(path)}-${Date.now().toString(36)}`;

  if (mode === "pr") {
    const headSha = await getRefSha(env, owner, repo, defaultBranch);
    await ensureBranch(env, owner, repo, target, headSha);
  }

  const result = await op.mutate(owner, repo, target);

  // The commit has landed, so every cached read of this repo is now potentially
  // stale. Swept here, for both verbs, before the PR is opened.
  await invalidateRepoReads(env, owner, repo);

  const base = { repo: `${owner}/${repo}`, mode, branch: target, path };
  if (mode === "direct") return { base, result, pr: null };

  const title = message.split("\n")[0] || op.fallbackTitle;
  // Pass the resolved repo full name so the PR lands on the same repo the file
  // was committed to, not the namespace default.
  const pr = await openPr(env, namespace, title, target, defaultBranch, op.prBody, `${owner}/${repo}`);
  return { base, result, pr: { number: pr.number, url: pr.url } };
}

export async function writeRepoFile(
  env: Env,
  namespace: string,
  path: string,
  content: string,
  message: string,
  mode: "pr" | "direct" = "pr",
  branch?: string,
  repoSelector?: string
) {
  const { base, result, pr } = await commitOnBranch(env, namespace, path, message, mode, branch, repoSelector, {
    branchPrefix: "capsid/",
    fallbackTitle: `Update ${path}`,
    prBody: `Automated change to \`${path}\` via Capsid.`,
    mutate: (owner, repo, target) => putFile(env, owner, repo, path, content, message, target),
  });
  // direct carries the file sha as well as the commit sha; pr mode never has.
  // That asymmetry is preserved rather than tidied, because tidying it would
  // change what a caller receives.
  if (!pr) return { ...base, ...result };
  return { ...base, commitSha: result.commitSha, pr };
}

// Delete a file from a namespace's repo. PR mode (default) commits the deletion
// to a work branch and opens a PR; direct mode deletes on the default branch.
// GitHub's contents DELETE needs the current file sha, so a missing file errors.
export async function deleteRepoFile(
  env: Env,
  namespace: string,
  path: string,
  message: string,
  mode: "pr" | "direct" = "pr",
  branch?: string,
  repoSelector?: string
) {
  const { base, result, pr } = await commitOnBranch(env, namespace, path, message, mode, branch, repoSelector, {
    branchPrefix: "capsid/rm-",
    fallbackTitle: `Delete ${path}`,
    prBody: `Delete \`${path}\` via Capsid.`,
    mutate: async (owner, repo, target) => {
      // GitHub's contents DELETE needs the CURRENT file sha, so a missing file is
      // an error rather than a no-op. Read on the target branch, which in pr mode
      // is the work branch just cut from the default.
      const sha = await getFileSha(env, owner, repo, path, target);
      if (!sha) throw new Error(`delete_repo_file: ${path} does not exist on ${owner}/${repo}@${target}`);
      const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sha, branch: target }),
      });
      if (!resp.ok) throw new Error(`delete failed (${resp.status}): ${await resp.text()}`);
      const data = (await resp.json()) as { commit: { sha: string } };
      return { commitSha: data.commit.sha };
    },
  });
  if (!pr) return { ...base, commitSha: result.commitSha };
  return { ...base, commitSha: result.commitSha, pr };
}

// Merge or close an open pull request. Merging can trigger CI deploys in repos
// with deploy workflows, so callers gate by blast radius (see conventions).
// THE HEAD BRANCH IS DELETED WHEN A PR CLOSES OR MERGES (capsid/conventions.md,
// ruled 2026-09-06). write_repo_file's default PR mode creates a branch per write, and
// nothing was cleaning them up: a sweep across five repos on that date found 18
// deletable branches, one of them a Capsid PR-mode branch whose PR was never opened.
//
// THREE PROPERTIES, and each one is a refusal rather than a hope:
//   1. Never the default branch. A PR whose head IS the default branch is a
//      cross-fork PR or a misconfiguration, and deleting it would be catastrophic.
//   2. Never an improve-loop branch. The loop may still need the attempt, and its
//      own lifecycle owns those refs; delete_branch refuses them without force for
//      the same reason.
//   3. NEVER FAILS THE PR ACTION. The merge or close already succeeded by the time
//      this runs. Reporting the whole call as failed because a branch delete failed
//      would be a lie about the merge, which is the same rule invalidateRepoReads
//      follows above. The outcome is reported in head_branch_deleted either way, so a
//      caller reads what happened instead of assuming.
async function deleteHeadBranchAfterPr(
  env: Env,
  owner: string,
  repo: string,
  number: number
): Promise<{ head_branch: string | null; head_branch_deleted: boolean; head_branch_note?: string }> {
  try {
    const prResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}`);
    if (!prResp.ok) {
      return { head_branch: null, head_branch_deleted: false, head_branch_note: `could not read the PR to find its head branch (${prResp.status})` };
    }
    const pr = (await prResp.json()) as {
      head: { ref: string; repo?: { full_name?: string } | null };
      base: { ref: string };
    };
    const branch = pr.head.ref;

    // A head branch on a FORK is not ours to delete, and the App token could not
    // anyway. Compared by full_name rather than assumed from the ref.
    const headRepo = pr.head.repo?.full_name;
    if (headRepo && headRepo !== `${owner}/${repo}`) {
      return { head_branch: branch, head_branch_deleted: false, head_branch_note: `head is on ${headRepo}, not this repo, so it was left alone` };
    }
    if (branch === pr.base.ref) {
      return { head_branch: branch, head_branch_deleted: false, head_branch_note: "head and base are the same branch, so nothing was deleted" };
    }
    const defaultBranch = await getDefaultBranch(env, owner, repo);
    if (branch === defaultBranch) {
      return { head_branch: branch, head_branch_deleted: false, head_branch_note: "head is the default branch, which is never deleted" };
    }
    if (isImproveBranch(branch)) {
      return {
        head_branch: branch,
        head_branch_deleted: false,
        head_branch_note: `head is under the improve loop's prefix (${IMPROVE_BRANCH_PREFIX}), which owns its own refs, so it was left alone`,
      };
    }
    const del = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/refs/heads/${encodePath(branch)}`, { method: "DELETE" });
    if (!del.ok) {
      return { head_branch: branch, head_branch_deleted: false, head_branch_note: `delete failed (${del.status}); the PR action itself succeeded` };
    }
    return { head_branch: branch, head_branch_deleted: true };
  } catch (err) {
    return {
      head_branch: null,
      head_branch_deleted: false,
      head_branch_note: `branch cleanup errored: ${err instanceof Error ? err.message : String(err)}; the PR action itself succeeded`,
    };
  }
}

export async function managePr(
  env: Env,
  namespace: string,
  number: number,
  action: "merge" | "close",
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
  repoSelector?: string
) {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  if (action === "merge") {
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merge_method: mergeMethod }),
    });
    if (!resp.ok) throw new Error(`merge failed (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as { sha: string; merged: boolean; message: string };
    // A merge changes the base branch's contents, so it is a write to every path the
    // PR touched. Which paths those are is not known here, which is the other reason
    // invalidation sweeps the repo prefix instead of computing keys.
    await invalidateRepoReads(env, owner, repo);
    const cleanup = await deleteHeadBranchAfterPr(env, owner, repo, number);
    return {
      repo: `${owner}/${repo}`,
      number,
      action: "merge",
      merged: data.merged,
      sha: data.sha,
      message: data.message,
      ...cleanup,
    };
  }
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
  if (!resp.ok) throw new Error(`close failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { number: number; state: string; html_url: string };
  const cleanup = await deleteHeadBranchAfterPr(env, owner, repo, number);
  return { repo: `${owner}/${repo}`, number: data.number, action: "close", state: data.state, url: data.html_url, ...cleanup };
}

// Recent CI workflow runs for a namespace's repo, via the GitHub App. Read-only.
// For the most recent failed run it also returns the failing jobs/steps and a
// bounded log tail, so a green-or-not verdict is reachable from claude.ai without
// opening the Actions tab. Needs the App's Actions: Read permission; a 403 is
// surfaced as a clear, actionable error rather than an opaque failure.
//
// THE LOG TAIL IS GATED OFF READ-ONLY KEYS. Ruled 2026-08-13. Run metadata (name,
// sha, conclusion) is inert; raw job logs are not the same class of data. A build
// log carries whatever the workflow echoed: resolved binding ids, account ids,
// wrangler output, and the contents of any variable a step printed by accident. An
// `ro:` key exists so an agent can read the knowledge base, and handing it the
// deploy logs of every repo in the portfolio is a wider grant than that. The
// runs list stays open to ro: keys, because the green-or-not verdict is the part
// they need.
// A ref that looks like a hex object name is filtered as a head sha, anything else
// as a branch. GitHub has two different query parameters for these and no single one
// that accepts either, so the tool takes one `ref` and decides here rather than
// making the caller know which kind of thing they are holding.
const SHA_SHAPE = /^[0-9a-f]{7,40}$/i;

export async function ciStatus(
  env: Env,
  namespace: string,
  repoSelector?: string,
  opts: { limit?: number; logTail?: boolean; ref?: string; runId?: number } = {}
) {
  if (opts.ref) assertRepoArg("ref", opts.ref);
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 20) : 10;
  let query = `/repos/${owner}/${repo}/actions/runs?per_page=${limit}`;
  if (opts.runId) {
    // One run, by id. Wrapped back into the same shape as the list so everything
    // downstream, including the failed-run drill-in, has one code path.
    const one = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs/${opts.runId}`);
    if (one.status === 404) throw new Error(`ci_status: run ${opts.runId} does not exist on ${full}`);
    if (!one.ok) throw new Error(`ci_status run lookup failed (${one.status}): ${(await one.text()).slice(0, 200)}`);
    const run = await one.json();
    return ciStatusFromRuns(env, owner, repo, full, [run as CiRun], opts.logTail === true, { run_id: opts.runId });
  }
  if (opts.ref) {
    if (SHA_SHAPE.test(opts.ref)) {
      // AN ABBREVIATED SHA MUST BE EXPANDED FIRST. Measured 2026-09-06 against
      // dustinedwards-info: `head_sha=3bcf858` returns total_count 0 while the full
      // 40-character sha returns the run. GitHub matches this parameter exactly and
      // says nothing about it, so the failure is an empty run list for precisely the
      // input a human types. One extra GET, only when the ref is short.
      let full40 = opts.ref;
      if (opts.ref.length < 40) {
        const commit = await cachedGet(env, owner, repo, `/repos/${owner}/${repo}/commits/${encodeURIComponent(opts.ref)}`);
        if (!commit.ok) {
          throw new Error(
            `ci_status: ${opts.ref} does not resolve to a commit on ${full} (${commit.status}), so runs cannot be filtered by it`
          );
        }
        full40 = ((await commit.json()) as { sha: string }).sha;
      }
      query += `&head_sha=${encodeURIComponent(full40)}`;
    } else {
      query += `&branch=${encodeURIComponent(opts.ref)}`;
    }
  }
  const resp = await ghFetch(env, owner, repo, query);
  if (resp.status === 403) {
    throw new Error(
      "ci_status: the capsid-repo-access GitHub App lacks Actions: Read. Add that permission in the App settings and accept the installation prompt, then retry."
    );
  }
  if (!resp.ok) throw new Error(`ci_status failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { workflow_runs: CiRun[] };
  return ciStatusFromRuns(env, owner, repo, full, data.workflow_runs, opts.logTail === true, opts.ref ? { ref: opts.ref } : {});
}

interface CiRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  html_url: string;
}

// THE FAILING STEP'S LOG, 64KB FROM ITS END, for write-grant keys.
//
// This REVERSES the earlier 2000-character job tail for the write tier only, and the
// reason is measured rather than stylistic: a job log ends with post-run cleanup, so
// the last 2000 characters of a failed run on these repos were `git config
// --unset-all` lines and the actual failure was thousands of lines earlier. A tail
// that reliably returns the wrong region is worse than no tail, because it reads as
// an answer. So the region is found by the failing STEP's group marker and then
// tailed, which puts the diagnosis in view. The ro: tier is unchanged; see
// capsid/decisions.md, 2026-09-06.
export const CI_LOG_BUDGET = 64 * 1024;

// THE STEP IS FOUND BY TIMESTAMP, NOT BY NAME, and the first attempt at this got it
// wrong in a way worth recording. Actions labels each group `##[group]Run <command>`,
// NOT `##[group]<step name>`, so a step called "Gates" appears nowhere in its own
// log. Searching for the name matched an incidental later occurrence and the tool
// then reported a region it had not actually located: a false claim, which is worse
// than the tail it replaced. Measured on dustinedwards-info run 34002625535.
//
// Every log line carries an ISO timestamp and the jobs API gives each step's
// started_at and completed_at, so the step's own output is the lines inside that
// window. On that run it is 51 lines and 3137 bytes, with the real `check:floors ...
// FAILED` inside it and no post-run cleanup, against a 93KB job log.
function failingStepLog(
  log: string,
  step: { name?: string; started_at?: string | null; completed_at?: string | null } | undefined
): { text: string; how: string } {
  const name = step?.name;
  const from = step?.started_at ? Date.parse(step.started_at) : NaN;
  const to = step?.completed_at ? Date.parse(step.completed_at) : NaN;

  if (Number.isFinite(from) && Number.isFinite(to)) {
    const windowed = log
      .split("\n")
      .filter((line) => {
        const stamp = /^(\S+Z)/.exec(line);
        if (!stamp) return false;
        const at = Date.parse(stamp[1]);
        return Number.isFinite(at) && at >= from && at <= to;
      })
      .join("\n");
    if (windowed.length > 0) {
      return {
        text: windowed.length > CI_LOG_BUDGET ? windowed.slice(-CI_LOG_BUDGET) : windowed,
        how:
          windowed.length > CI_LOG_BUDGET
            ? `failing step "${name}" by timestamp window, last ${CI_LOG_BUDGET} bytes of it`
            : `failing step "${name}" by timestamp window, whole (${windowed.length} bytes)`,
      };
    }
  }

  // NAMED FALLBACK, not a silent one. If the window could not be applied the caller
  // is told so, because "the end of the job log" and "the failing step" are different
  // claims and only one of them is being made here.
  return {
    text: log.slice(-CI_LOG_BUDGET),
    how: name
      ? `step "${name}" had no usable timestamp window, so this is the last ${CI_LOG_BUDGET} bytes of the whole job, cleanup included`
      : `no failing step was named, so this is the last ${CI_LOG_BUDGET} bytes of the whole job, cleanup included`,
  };
}

async function ciStatusFromRuns(
  env: Env,
  owner: string,
  repo: string,
  full: string,
  workflowRuns: CiRun[],
  logTail: boolean,
  filter: { ref?: string; run_id?: number }
) {
  const runs = workflowRuns.map((r) => ({
    name: r.name,
    head_sha: r.head_sha?.slice(0, 7),
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    created_at: r.created_at,
    url: r.html_url,
  }));

  const result: {
    repo: string;
    filter?: { ref?: string; run_id?: number };
    runs: typeof runs;
    failed_run?: unknown;
  } = { repo: full, runs };
  if (filter.ref || filter.run_id) result.filter = filter;

  // Drill into the most recent failed run so the caller sees why, not just that.
  //
  // EVERY DEGRADED PATH IS NAMED (audit 2, F34). Both sub-fetches used to fail into
  // silence: a jobs fetch that errored dropped failed_run entirely, so the answer
  // looked like a run that failed for no reason, and a log fetch that errored
  // returned neither log_tail nor log_tail_withheld, so a caller with a write grant
  // could not tell "no log" from "the log was refused for you". A tool reporting on
  // whether CI is healthy is the last place to answer by omission.
  const failed = workflowRuns.find((r) => r.conclusion === "failure");
  if (failed) {
    const failedRun: Record<string, unknown> = {
      name: failed.name,
      head_sha: failed.head_sha?.slice(0, 7),
      url: failed.html_url,
    };
    const jobsResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs/${failed.id}/jobs`);
    if (!jobsResp.ok) {
      failedRun.jobs_unavailable = `${jobsResp.status}: ${(await jobsResp.text()).slice(0, 200) || "no response body"}`;
    } else {
      const jobsData = (await jobsResp.json()) as {
        jobs: Array<{
          id: number;
          name: string;
          conclusion: string | null;
          steps?: Array<{ name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }>;
        }>;
      };
      failedRun.jobs = jobsData.jobs
        .filter((j) => j.conclusion === "failure")
        .map((j) => ({
          name: j.name,
          failed_steps: (j.steps ?? []).filter((s) => s.conclusion === "failure").map((s) => s.name),
        }));
      const firstFailedJob = jobsData.jobs.find((j) => j.conclusion === "failure");
      if (!logTail) {
        // Unchanged: this is the read-only tier's boundary, not a degraded path.
        failedRun.log_tail_withheld =
          "read-only key: run metadata only. A write-grant key returns the failing step's log.";
      } else if (!firstFailedJob) {
        failedRun.log_tail_unavailable = "the run is marked failed but no job in it is, so there is no job log to read";
      } else {
        const logResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/jobs/${firstFailedJob.id}/logs`);
        if (logResp.ok) {
          const failedStep = (firstFailedJob.steps ?? []).find((s) => s.conclusion === "failure");
          const picked = failingStepLog(await logResp.text(), failedStep);
          failedRun.failing_job = firstFailedJob.name;
          failedRun.failing_step = failedStep?.name ?? null;
          failedRun.log_region = picked.how;
          failedRun.log = picked.text;
        } else {
          failedRun.log_tail_unavailable = `${logResp.status}: ${(await logResp.text()).slice(0, 200) || "no response body"}`;
        }
      }
    }
    result.failed_run = failedRun;
  }
  return result;
}

// ---- the improve loop's two GitHub needs -------------------------------------
//
// Both live here rather than in src/improve-scorer.ts, and the reason is the one
// already written above commitOnBranch: the App token dance, the 401 retry and
// the per-owner installation lookup exist ONCE in this module. A second module
// calling api.github.com would be a second copy of that dance, and the copy that
// drifts is always the one nobody is looking at.

// Fire a workflow_dispatch. The REF IS DELIBERATELY NOT THE ATTEMPT BRANCH.
//
// workflow_dispatch runs the workflow file as it exists AT `ref`, so dispatching
// against the attempt branch would let an attempt rewrite its own scorer: change
// improve-score.yml on the branch, and the thing measuring the change is the
// change. Dispatching against the default branch and passing the branch as an
// INPUT means the scorer is always the reviewed copy on main, and the attempt is
// data to it rather than code.
//
// The deterministic monitor also refuses any diff touching .github/, so this is
// belt and braces. Both are kept: the monitor is a policy that could be relaxed,
// this is a mechanism that cannot be argued with.
// THE REF ARGUMENT IS OPTIONAL AND DEFAULTS TO THE DEFAULT BRANCH, which is what
// the paragraph above is about. It was added for ci_dispatch, where a human asking
// to run a workflow on a branch means that branch. The improve loop passes no ref
// and therefore still dispatches against the default branch, unchanged, so the
// property above is intact for the caller it was written for. Do not give this
// parameter a value at the improve loop's call site.
export async function dispatchWorkflow(
  env: Env,
  namespace: string,
  workflowFile: string,
  inputs: Record<string, string>,
  repoSelector?: string,
  refOverride?: string
): Promise<{ repo: string; workflow: string; ref: string; inputs: Record<string, string> }> {
  assertRepoArg("workflow", workflowFile);
  if (refOverride) assertRepoArg("ref", refOverride);
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const ref = refOverride ?? (await getDefaultBranch(env, owner, repo));
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs }),
    }
  );
  // 204 is the success code here, and there is no body to read on either path.
  if (!resp.ok) {
    throw new Error(
      `workflow dispatch failed for ${full} ${workflowFile} (${resp.status}): ${(await resp.text()).slice(0, 300) || "no response body"}`
    );
  }
  return { repo: full, workflow: workflowFile, ref, inputs };
}

// What CI is doing on one branch. Read by the tick so a timeout can say WHICH
// failure it was: the workflow never started, the workflow is still running, or
// the workflow finished and the report never arrived. Those three have different
// fixes and a bare "timed out" distinguishes none of them.
// `id` and `head_sha` are returned ADDITIVELY, for ci_dispatch. workflow_dispatch
// replies 204 with no body, so the only way to name the run it started is to look
// for a run that did not exist before; that needs the id, which this used to drop.
// The tick reads status, conclusion and the timestamps and is unaffected.
export async function workflowRunsForBranch(
  env: Env,
  namespace: string,
  branch: string,
  repoSelector?: string
): Promise<
  Array<{
    id: number;
    head_sha: string;
    name: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    updated_at: string;
    url: string;
  }>
> {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=5`
  );
  if (!resp.ok) throw new Error(`workflow run lookup failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as {
    workflow_runs: Array<{
      id: number;
      head_sha: string;
      name: string;
      status: string;
      conclusion: string | null;
      created_at: string;
      updated_at: string;
      html_url: string;
    }>;
  };
  return data.workflow_runs.map((r) => ({
    id: r.id,
    head_sha: r.head_sha,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    created_at: r.created_at,
    updated_at: r.updated_at,
    url: r.html_url,
  }));
}

// ---- the repo fallthrough widening, 2026-09-06 --------------------------------
//
// WHY THESE FOUR EXIST. The claude.ai GitHub connector authenticates and then 404s
// on every private repo in the portfolio (open Anthropic issues #68517, #71542,
// #72032, #79083 since June). This module's App installation token already reaches
// every mapped repo. So these are not new capability, they are existing reach made
// callable, which is the whole of the argument recorded in capsid/decisions.md
// under the second lean-surface exception of 2026-09-06.
//
// Every one of them goes through resolveRepo, ghFetch and cachedGet like the tools
// above. Nothing here opens its own path to api.github.com; that is the rule the
// comment over dispatchWorkflow states, and it applies to reads too.

/** Branches, tags and open PRs in one call. The triage question is almost always
 *  "what is in flight here", which is three GETs the caller should not have to make
 *  separately. Ahead/behind is per branch against the default branch. */
export async function repoRefs(env: Env, namespace: string, repoSelector?: string) {
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const base = `/repos/${owner}/${repo}`;
  const defaultBranch = await getDefaultBranch(env, owner, repo);

  const [branchResp, tagResp, prResp] = await Promise.all([
    cachedGet(env, owner, repo, `${base}/branches?per_page=100`),
    cachedGet(env, owner, repo, `${base}/tags?per_page=100`),
    cachedGet(env, owner, repo, `${base}/pulls?state=open&per_page=100`),
  ]);
  if (!branchResp.ok) throw new Error(`repo_refs branches failed (${branchResp.status}): ${(await branchResp.text()).slice(0, 200)}`);
  if (!tagResp.ok) throw new Error(`repo_refs tags failed (${tagResp.status}): ${(await tagResp.text()).slice(0, 200)}`);
  if (!prResp.ok) throw new Error(`repo_refs pulls failed (${prResp.status}): ${(await prResp.text()).slice(0, 200)}`);

  const branchRows = (await branchResp.json()) as Array<{ name: string; commit: { sha: string } }>;
  const tagRows = (await tagResp.json()) as Array<{ name: string; commit: { sha: string } }>;
  const prRows = (await prResp.json()) as Array<{
    number: number;
    title: string;
    head: { ref: string };
    base: { ref: string };
    updated_at: string;
    html_url: string;
  }>;

  const prByHead = new Map(prRows.map((p) => [p.head.ref, p.number]));

  // Ahead/behind comes from the compare endpoint, one call per branch, and the
  // default branch is skipped because comparing it with itself is always 0/0. The
  // fan-out is bounded by the 100-branch page above; a repo with more branches than
  // that reports its first hundred and sets truncated.
  const branches = await Promise.all(
    branchRows.map(async (b) => {
      const row: {
        name: string;
        sha: string;
        committed_date: string | null;
        ahead_by: number | null;
        behind_by: number | null;
        open_pr: number | null;
        is_default: boolean;
      } = {
        name: b.name,
        sha: b.commit.sha,
        committed_date: null,
        ahead_by: null,
        behind_by: null,
        open_pr: prByHead.get(b.name) ?? null,
        is_default: b.name === defaultBranch,
      };
      if (b.name === defaultBranch) {
        row.ahead_by = 0;
        row.behind_by = 0;
        return row;
      }
      const cmp = await cachedGet(
        env,
        owner,
        repo,
        `${base}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(b.name)}`
      );
      if (cmp.ok) {
        const c = (await cmp.json()) as {
          ahead_by: number;
          behind_by: number;
          commits?: Array<{ commit: { committer: { date: string } } }>;
        };
        row.ahead_by = c.ahead_by;
        row.behind_by = c.behind_by;
        const last = c.commits?.[c.commits.length - 1];
        if (last) row.committed_date = last.commit.committer.date;
      }
      return row;
    })
  );

  return {
    repo: full,
    default_branch: defaultBranch,
    truncated: branchRows.length === 100 || tagRows.length === 100 || prRows.length === 100,
    branches,
    tags: tagRows.map((t) => ({ name: t.name, sha: t.commit.sha })),
    pull_requests: prRows.map((p) => ({
      number: p.number,
      title: p.title,
      head: p.head.ref,
      base: p.base.ref,
      updated_at: p.updated_at,
      url: p.html_url,
    })),
  };
}

export const REPO_HISTORY_DEFAULT_LIMIT = 20;
export const REPO_HISTORY_MAX_LIMIT = 100;
export const REPO_PATCH_BUDGET = 200 * 1024;

function summariseCommit(c: { sha: string; commit: { message: string; author: { name: string; date: string } } }) {
  return {
    sha: c.sha,
    date: c.commit.author.date,
    author: c.commit.author.name,
    // FIRST LINE ONLY. A commit body in this repo family runs to paragraphs, and a
    // history listing that inlined them would bury the shape of the history in the
    // prose of it. Read one commit by sha for the full message.
    subject: c.commit.message.split("\n")[0],
  };
}

// Patch bodies are OFF by default and budgeted when on. The file list is always
// returned: names, status and line counts answer most questions and cost nothing.
function filesWithBudget(
  files: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>,
  wantPatch: boolean
) {
  let spent = 0;
  let truncated = false;
  const out = files.map((f) => {
    const row: { path: string; status: string; additions: number; deletions: number; patch?: string } = {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    };
    if (wantPatch && f.patch) {
      if (spent + f.patch.length <= REPO_PATCH_BUDGET) {
        row.patch = f.patch;
        spent += f.patch.length;
      } else {
        truncated = true;
      }
    }
    return row;
  });
  return { count: out.length, patch_truncated: truncated, patch_bytes: spent, entries: out };
}

/** Commits, a comparison, or one commit. THE MODE IS CHOSEN BY WHICH ARGS ARE
 *  PRESENT, and an ambiguous combination is refused rather than resolved by
 *  precedence: a caller who passes both sha and base has two questions and should
 *  ask them separately, rather than silently getting the answer to one. */
export async function repoHistory(
  env: Env,
  namespace: string,
  args: { ref?: string; base?: string; head?: string; sha?: string; limit?: number; patch?: boolean },
  repoSelector?: string
) {
  for (const [kind, value] of [["ref", args.ref], ["base", args.base], ["head", args.head], ["sha", args.sha]] as const) {
    if (value) assertRepoArg(kind, value);
  }
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const apiBase = `/repos/${owner}/${repo}`;

  if (args.base && !args.head) throw new Error("repo_history: base was given without head; a comparison needs both");
  if (args.head && !args.base) throw new Error("repo_history: head was given without base; a comparison needs both");
  const hasCompare = Boolean(args.base && args.head);
  const asked = [args.sha ? "sha" : null, hasCompare ? "base+head" : null, args.ref ? "ref" : null].filter(Boolean);
  if (asked.length > 1) {
    throw new Error(`repo_history: ${asked.join(" and ")} are different questions; pass exactly one of sha, base+head, or ref`);
  }
  if (asked.length === 0) {
    throw new Error("repo_history: pass ref for commits on a ref, base and head to compare, or sha for one commit");
  }

  const limit = Math.min(Math.max(args.limit ?? REPO_HISTORY_DEFAULT_LIMIT, 1), REPO_HISTORY_MAX_LIMIT);

  if (args.sha) {
    const resp = await cachedGet(env, owner, repo, `${apiBase}/commits/${encodeURIComponent(args.sha)}`);
    if (!resp.ok) throw new Error(`repo_history commit failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    const c = (await resp.json()) as {
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
      parents: Array<{ sha: string }>;
      files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
    };
    return {
      repo: full,
      mode: "commit" as const,
      commit: {
        sha: c.sha,
        date: c.commit.author.date,
        author: c.commit.author.name,
        message: c.commit.message,
        parents: c.parents.map((p) => p.sha),
      },
      files: filesWithBudget(c.files ?? [], args.patch === true),
    };
  }

  if (hasCompare) {
    const resp = await cachedGet(
      env,
      owner,
      repo,
      `${apiBase}/compare/${encodeURIComponent(args.base as string)}...${encodeURIComponent(args.head as string)}`
    );
    if (!resp.ok) throw new Error(`repo_history compare failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    const c = (await resp.json()) as {
      status: string;
      ahead_by: number;
      behind_by: number;
      total_commits: number;
      commits: Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>;
      files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
    };
    return {
      repo: full,
      mode: "compare" as const,
      base: args.base,
      head: args.head,
      status: c.status,
      ahead_by: c.ahead_by,
      behind_by: c.behind_by,
      total_commits: c.total_commits,
      commits: c.commits.slice(0, limit).map(summariseCommit),
      files: filesWithBudget(c.files ?? [], args.patch === true),
    };
  }

  const resp = await cachedGet(env, owner, repo, `${apiBase}/commits?sha=${encodeURIComponent(args.ref as string)}&per_page=${limit}`);
  if (!resp.ok) throw new Error(`repo_history commits failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const rows = (await resp.json()) as Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>;
  return { repo: full, mode: "commits" as const, ref: args.ref, limit, commits: rows.map(summariseCommit) };
}

/** Delete a branch. THREE REFUSALS, each naming itself, and force lifts only two of
 *  them: the default branch is never deletable through this tool at all. */
export async function deleteBranch(
  env: Env,
  namespace: string,
  branch: string,
  opts: { force?: boolean } = {},
  repoSelector?: string
) {
  assertRepoArg("branch", branch);
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const base = `/repos/${owner}/${repo}`;
  const defaultBranch = await getDefaultBranch(env, owner, repo);

  // NOT LIFTABLE BY force. Deleting a repo's default branch is never something a
  // triage seat meant to do, and a flag that could do it is a flag that eventually
  // will. This refusal is checked before force is even read.
  if (branch === defaultBranch) {
    throw new Error(`delete_branch refuses: ${branch} is the default branch of ${full}. force does not lift this refusal.`);
  }

  if (!opts.force) {
    if (isImproveBranch(branch)) {
      throw new Error(
        `delete_branch refuses: ${branch} is under the improve loop's branch prefix (${IMPROVE_BRANCH_PREFIX}), so it may be an attempt the loop still needs. Pass force: true to delete it anyway.`
      );
    }
    const prResp = await cachedGet(env, owner, repo, `${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    // FAIL CLOSED (audit 2026-09-06): a lookup that errors is not "no open PRs".
    // Skipping the refusal on a 5xx would delete exactly the branches this check
    // exists to protect, on exactly the days GitHub is flaky.
    if (!prResp.ok) {
      throw new Error(
        `delete_branch refuses: could not verify open pull requests for ${branch} on ${full} (${prResp.status}), so the open-PR refusal cannot run. Retry, or pass force: true to delete without the check.`
      );
    }
    const prs = (await prResp.json()) as Array<{ number: number; html_url: string }>;
    if (prs.length > 0) {
      throw new Error(
        `delete_branch refuses: ${branch} has open pull request #${prs[0].number} (${prs[0].html_url}). Pass force: true to delete it anyway.`
      );
    }
  }

  const resp = await ghFetch(env, owner, repo, `${base}/git/refs/heads/${encodePath(branch)}`, { method: "DELETE" });
  if (resp.status === 422 || resp.status === 404) {
    throw new Error(`delete_branch failed: ${branch} does not exist on ${full} (${resp.status})`);
  }
  if (!resp.ok) throw new Error(`delete_branch failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  await invalidateRepoReads(env, owner, repo);
  return { repo: full, branch, deleted: true, forced: opts.force === true };
}

export const CI_DISPATCH_POLL_MS = 30_000;
export const CI_DISPATCH_POLL_INTERVAL_MS = 3_000;

/** Trigger a workflow_dispatch, or rerun a run's failed jobs. Reuses
 *  dispatchWorkflow and workflowRunsForBranch; there is no second dispatch path in
 *  this codebase and there must not become one. */
export async function ciDispatch(
  env: Env,
  namespace: string,
  args: { workflow?: string; ref?: string; run_id?: number; inputs?: Record<string, string> },
  repoSelector?: string,
  // THE POLL TIMING IS INJECTABLE FOR TESTS ONLY, and it is a seam rather than a
  // setting: the tool never passes it, so production always uses the constants
  // above. Without this the timeout case costs 30 seconds of real waiting in the
  // suite, and a test nobody will run is a test that stops being true.
  poll: { timeoutMs?: number; intervalMs?: number } = {}
) {
  const timeoutMs = poll.timeoutMs ?? CI_DISPATCH_POLL_MS;
  const intervalMs = poll.intervalMs ?? CI_DISPATCH_POLL_INTERVAL_MS;
  // THE SCORER IS NOT HAND-DISPATCHABLE THROUGH THIS TOOL (audit 2026-09-06,
  // Fable MAJOR 7). improve-score.yml signs whatever it measured with the repo's
  // score key, so a ci_dispatch of it against an arbitrary ref mints a genuinely
  // signed report the ingest endpoint has no reason to doubt. Ingest also binds
  // the report to the run's in-flight attempt and head sha, but that is the
  // second lock; this is the first. The loop dispatches its own scorer through
  // dispatchScorer, and a human shakedown goes through GitHub directly.
  if (args.workflow === SCORER_WORKFLOW) {
    throw new Error(
      `ci_dispatch refuses: ${SCORER_WORKFLOW} is the improve loop's scorer, and a hand dispatch of it can mint a signed score report for an arbitrary ref. The loop dispatches it itself; run a shakedown from GitHub directly.`
    );
  }
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);

  if (args.run_id) {
    if (args.workflow) throw new Error("ci_dispatch: pass workflow and ref to start a run, or run_id to rerun one, not both");
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs/${args.run_id}/rerun-failed-jobs`, {
      method: "POST",
    });
    if (!resp.ok) {
      throw new Error(
        `ci_dispatch rerun failed for run ${args.run_id} (${resp.status}): ${(await resp.text()).slice(0, 300) || "no response body"}`
      );
    }
    return { repo: full, mode: "rerun" as const, run_id: args.run_id, rerun_requested: true };
  }

  if (!args.workflow || !args.ref) throw new Error("ci_dispatch: workflow and ref are both required to start a run");

  // The runs that already exist for this ref, so the new one can be told apart. The
  // dispatch endpoint answers 204 with no body and names nothing it started.
  const before = new Set((await workflowRunsForBranch(env, namespace, args.ref, repoSelector)).map((r) => r.id));

  try {
    await dispatchWorkflow(env, namespace, args.workflow, args.inputs ?? {}, repoSelector, args.ref);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // GitHub answers 422 naming workflow_dispatch when the workflow file has no
    // such trigger. Saying so is the difference between "this workflow cannot be
    // started by hand" and an opaque 422 the caller has to go and read the YAML for.
    if (/workflow_dispatch/i.test(message)) {
      throw new Error(
        `ci_dispatch refuses: ${args.workflow} has no workflow_dispatch trigger on ${full}, so it cannot be started by hand. Add "on: workflow_dispatch:" to that workflow, or trigger it the way it is configured. GitHub said: ${message.slice(0, 200)}`
      );
    }
    throw err;
  }

  // POLL, because 204 means accepted, not started. A caller with no run id has
  // nothing to watch, which is the whole reason this tool returns one.
  const deadline = Date.now() + timeoutMs;
  let appeared: Awaited<ReturnType<typeof workflowRunsForBranch>>[number] | undefined;
  let polls = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    polls += 1;
    appeared = (await workflowRunsForBranch(env, namespace, args.ref, repoSelector)).find((r) => !before.has(r.id));
    if (appeared) break;
  }

  if (!appeared) {
    return {
      repo: full,
      mode: "dispatch" as const,
      workflow: args.workflow,
      ref: args.ref,
      dispatched: true,
      run_id: null,
      polls,
      note: `dispatch was accepted, but no new run appeared for ${args.ref} within ${timeoutMs / 1000}s. It may still start; check ci_status with this ref. A dispatch that is accepted and never runs usually means the workflow's own conditions excluded it.`,
    };
  }
  return {
    repo: full,
    mode: "dispatch" as const,
    workflow: args.workflow,
    ref: args.ref,
    dispatched: true,
    run_id: appeared.id,
    status: appeared.status,
    url: appeared.url,
    polls,
  };
}

export const REPO_BATCH_MAX_FILES = 20;
export const REPO_FILE_BUDGET = 200 * 1024;

/** Read up to REPO_BATCH_MAX_FILES files, each independently. ONE MISSING PATH DOES
 *  NOT FAIL THE BATCH: the point of a batch is triage, and a triage call that throws
 *  because one of twenty paths moved is a call the caller has to retry by bisection.
 *
 *  THE PER-FILE BUDGET APPLIES HERE AND NOT TO THE SINGLE-PATH READ. There was no
 *  repo read budget before this, so applying one to readRepoFile would have made an
 *  existing call start truncating silently. New surface takes the new bound. */
export async function readRepoFiles(env: Env, namespace: string, paths: string[], ref?: string, repoSelector?: string) {
  if (paths.length === 0) throw new Error("read_repo_file: paths was empty");
  if (paths.length > REPO_BATCH_MAX_FILES) {
    throw new Error(`read_repo_file: ${paths.length} paths exceeds the batch maximum of ${REPO_BATCH_MAX_FILES}`);
  }
  const { full } = await resolveRepo(env, namespace, repoSelector);
  const files = await Promise.all(
    paths.map(async (path) => {
      const problem = pathProblem(path);
      if (problem) return { path, error: problem };
      try {
        const one = await readRepoFile(env, namespace, path, ref, repoSelector);
        const truncated = one.content.length > REPO_FILE_BUDGET;
        return {
          path,
          size: one.size,
          sha: one.sha,
          truncated,
          content: truncated ? one.content.slice(0, REPO_FILE_BUDGET) : one.content,
        };
      } catch (err) {
        return { path, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
  const failed = files.filter((f) => "error" in f).length;
  return {
    repo: full,
    requested: paths.length,
    ok: files.length - failed,
    failed,
    bytes: files.reduce((n, f) => n + ("content" in f && f.content ? f.content.length : 0), 0),
    files,
  };
}

// THE DEFAULT BRANCH'S HEAD COMMIT SHA, which the improve loop needs and could not
// get. It read `(await listRepoTree(...)).sha`, and listRepoTree returns
// { repo, path, entries } with no top-level sha at all: the shas it carries are the
// per-entry BLOB shas. So the expression was always undefined, defaultSha was always
// null, and selectBase always fell through to "no base could be resolved" whenever
// there was no best record and no kept attempt, which is exactly the state of a
// namespace's FIRST EVER run. Found 2026-09-06 by asking why a dry run said that.
//
// The two halves already existed here as private helpers and were never composed.
export async function defaultBranchSha(env: Env, namespace: string, repoSelector?: string): Promise<string> {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const branch = await getDefaultBranch(env, owner, repo);
  return getRefSha(env, owner, repo, branch);
}
