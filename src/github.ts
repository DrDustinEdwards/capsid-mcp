// GitHub App repo access for Capsid's repo fallthrough.
//
// Mints short-lived installation tokens from the App private key (RS256 JWT via
// Web Crypto) and caches them in APP_KV for ~55 minutes. Resolves the target
// repo per namespace from the D1 namespaces table, then reads and writes files
// over the live GitHub REST API. No PAT, no clone.

import { b64urlFromBytes, b64urlEncode, base64Decode, base64Encode } from "./encoding";
import type { Env } from "./server";

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
const tokenKey = (owner: string) => `gh:token:v2:${owner}`;
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
  const cacheKey = tokenKey(owner);
  const cached = await env.APP_KV.get(cacheKey);
  if (cached) return cached;
  const installationId = await getInstallationId(env, owner, repo);
  const resp = await appFetch(env, `/app/installations/${installationId}/access_tokens`, { method: "POST" });
  if (!resp.ok) throw new Error(`installation token request failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { token: string };
  await env.APP_KV.put(cacheKey, data.token, { expirationTtl: TOKEN_TTL_SECONDS });
  return data.token;
}

// One installation covers every repo under a single owner, so tokens are cached
// per owner and reused across that owner's repos.
async function ghFetch(env: Env, owner: string, repo: string, path: string, init?: RequestInit): Promise<Response> {
  const call = (token: string) =>
    fetch(`${GH}${path}`, {
      ...init,
      headers: { ...GH_HEADERS, ...(init?.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
  let resp = await call(await getInstallationToken(env, owner, repo));
  if (resp.status === 401) {
    await env.APP_KV.delete(tokenKey(owner));
    resp = await call(await getInstallationToken(env, owner, repo));
  }
  return resp;
}

// The cache key is the full API path, which already carries owner, repo, the file
// path and the ref (as the literal ?ref= query), so entries for different refs are
// different keys and cannot collide. What was missing was deletion.
async function cachedGet(env: Env, owner: string, repo: string, path: string): Promise<Response> {
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
      for (const key of page.keys) {
        await env.APP_KV.delete(key.name);
        deleted++;
      }
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

// The shape of a single repos entry: "owner/name" with no spaces or extra slashes.
export const REPO_SHAPE = /^[^/\s]+\/[^/\s]+$/;

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
    if (!r || typeof r.repo !== "string" || !REPO_SHAPE.test(r.repo)) {
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

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

// ---- read --------------------------------------------------------------------

export async function listRepoTree(env: Env, namespace: string, path = "", ref?: string, repoSelector?: string) {
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
  const MAX_SCAN_CAP = 200;
  const maxResults = Math.min(opts.maxResults && opts.maxResults > 0 ? opts.maxResults : 20, MAX_SCAN_CAP);
  const maxFiles = Math.min(opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : 200, MAX_SCAN_CAP);
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
  // Both write modes reach the repo through here, so one call covers write_repo_file
  // direct and pr alike.
  await invalidateRepoReads(env, owner, repo);
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

function branchSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
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
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const defaultBranch = await getDefaultBranch(env, owner, repo);

  if (mode === "direct") {
    const target = branch || defaultBranch;
    const res = await putFile(env, owner, repo, path, content, message, target);
    return { repo: `${owner}/${repo}`, mode: "direct", branch: target, path, ...res };
  }

  const work = branch || `capsid/${branchSlug(path)}-${Date.now().toString(36)}`;
  const headSha = await getRefSha(env, owner, repo, defaultBranch);
  await ensureBranch(env, owner, repo, work, headSha);
  const res = await putFile(env, owner, repo, path, content, message, work);
  const title = message.split("\n")[0] || `Update ${path}`;
  // Pass the resolved repo full name so the PR lands on the same repo the file
  // was committed to, not the namespace default.
  const pr = await openPr(env, namespace, title, work, defaultBranch, `Automated change to \`${path}\` via Capsid.`, `${owner}/${repo}`);
  return {
    repo: `${owner}/${repo}`,
    mode: "pr",
    branch: work,
    path,
    commitSha: res.commitSha,
    pr: { number: pr.number, url: pr.url },
  };
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
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const defaultBranch = await getDefaultBranch(env, owner, repo);
  const target =
    mode === "direct" ? branch || defaultBranch : branch || `capsid/rm-${branchSlug(path)}-${Date.now().toString(36)}`;

  if (mode === "pr") {
    const headSha = await getRefSha(env, owner, repo, defaultBranch);
    await ensureBranch(env, owner, repo, target, headSha);
  }

  const sha = await getFileSha(env, owner, repo, path, target);
  if (!sha) throw new Error(`delete_repo_file: ${path} does not exist on ${owner}/${repo}@${target}`);
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch: target }),
  });
  if (!resp.ok) throw new Error(`delete failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { commit: { sha: string } };
  await invalidateRepoReads(env, owner, repo);

  if (mode === "direct") {
    return { repo: `${owner}/${repo}`, mode: "direct", branch: target, path, commitSha: data.commit.sha };
  }
  const title = message.split("\n")[0] || `Delete ${path}`;
  const pr = await openPr(env, namespace, title, target, defaultBranch, `Delete \`${path}\` via Capsid.`, `${owner}/${repo}`);
  return {
    repo: `${owner}/${repo}`,
    mode: "pr",
    branch: target,
    path,
    commitSha: data.commit.sha,
    pr: { number: pr.number, url: pr.url },
  };
}

// Merge or close an open pull request. Merging can trigger CI deploys in repos
// with deploy workflows, so callers gate by blast radius (see conventions).
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
    return { repo: `${owner}/${repo}`, number, action: "merge", merged: data.merged, sha: data.sha, message: data.message };
  }
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
  if (!resp.ok) throw new Error(`close failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { number: number; state: string; html_url: string };
  return { repo: `${owner}/${repo}`, number: data.number, action: "close", state: data.state, url: data.html_url };
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
export async function ciStatus(
  env: Env,
  namespace: string,
  repoSelector?: string,
  opts: { limit?: number; logTail?: boolean } = {}
) {
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 20) : 10;
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs?per_page=${limit}`);
  if (resp.status === 403) {
    throw new Error(
      "ci_status: the capsid-repo-access GitHub App lacks Actions: Read. Add that permission in the App settings and accept the installation prompt, then retry."
    );
  }
  if (!resp.ok) throw new Error(`ci_status failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as {
    workflow_runs: Array<{
      id: number;
      name: string;
      head_sha: string;
      status: string;
      conclusion: string | null;
      event: string;
      created_at: string;
      html_url: string;
    }>;
  };
  const runs = data.workflow_runs.map((r) => ({
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
    runs: typeof runs;
    failed_run?: unknown;
  } = { repo: full, runs };

  // Drill into the most recent failed run so the caller sees why, not just that.
  //
  // EVERY DEGRADED PATH IS NAMED (audit 2, F34). Both sub-fetches used to fail into
  // silence: a jobs fetch that errored dropped failed_run entirely, so the answer
  // looked like a run that failed for no reason, and a log fetch that errored
  // returned neither log_tail nor log_tail_withheld, so a caller with a write grant
  // could not tell "no log" from "the log was refused for you". A tool reporting on
  // whether CI is healthy is the last place to answer by omission.
  const failed = data.workflow_runs.find((r) => r.conclusion === "failure");
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
        jobs: Array<{ id: number; name: string; conclusion: string | null; steps?: Array<{ name: string; conclusion: string | null }> }>;
      };
      failedRun.jobs = jobsData.jobs
        .filter((j) => j.conclusion === "failure")
        .map((j) => ({
          name: j.name,
          failed_steps: (j.steps ?? []).filter((s) => s.conclusion === "failure").map((s) => s.name),
        }));
      const firstFailedJob = jobsData.jobs.find((j) => j.conclusion === "failure");
      if (!opts.logTail) {
        // Unchanged: this is the read-only tier's boundary, not a degraded path.
        failedRun.log_tail_withheld =
          "read-only key: run metadata only. A write-grant key returns the failing job's log tail.";
      } else if (!firstFailedJob) {
        failedRun.log_tail_unavailable = "the run is marked failed but no job in it is, so there is no job log to tail";
      } else {
        const logResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/jobs/${firstFailedJob.id}/logs`);
        if (logResp.ok) failedRun.log_tail = (await logResp.text()).slice(-2000);
        else failedRun.log_tail_unavailable = `${logResp.status}: ${(await logResp.text()).slice(0, 200) || "no response body"}`;
      }
    }
    result.failed_run = failedRun;
  }
  return result;
}
