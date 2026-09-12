// GitHub App repo access for Capsid's repo fallthrough.
//
// Mints short-lived installation tokens from the App private key (RS256 JWT via Web
// Crypto) and caches them in APP_KV for ~55 minutes. Resolves the target repo per
// namespace from the D1 namespaces table, then reads and writes over the GitHub
// REST API. No PAT, no clone.

import { b64urlFromBytes, b64urlEncode } from "../encoding";
import { repoPathProblem } from "../limits";
// AttemptEnv, not Env: this module must not be able to name HOLDOUT.
import type { AttemptEnv as Env } from "../env";

const GH = "https://api.github.com";
const GH_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "capsid",
};

const TOKEN_TTL_SECONDS = 3300; // installation tokens live 60 min; refresh a little early
const INSTALL_TTL_SECONDS = 86400; // installation id is stable
const READ_CACHE_TTL_SECONDS = 60; // brief cache for read tools

const installKey = (owner: string) => `gh:install:v2:${owner}`;
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


async function getInstallationId(env: Env, owner: string, repo: string): Promise<string> {
  const cached = await env.APP_KV.get(installKey(owner));
  if (cached) return cached;
  const resp = await appFetch(env, `/repos/${owner}/${repo}/installation`);
  if (!resp.ok) {
    // A valid App JWT with no installation covering the repo answers 404; a bad JWT
    // answers 401 (measured 2026-07-06). So a 404 means the credentials are fine and
    // the App is not installed on that repo.
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
  // SCOPED TO THE ONE REPO BEING ASKED ABOUT (audit 2026-09-06, Grok MAJOR 10). An
  // access_tokens POST with no body mints a token for every repo the installation
  // covers, and that token then sits in APP_KV. With `repositories` it holds exactly
  // the repo the caller resolved.
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

// One installation covers every repo under a single owner, but each minted token is
// scoped to one repo, so the cache is per owner+repo to match.

// THE URL BUILT FOR A REPO CALL CANNOT ESCAPE /repos/<owner>/<repo>/ (audit
// 2026-09-06, CRITICAL). Every ghFetch and cachedGet path in this module is under
// that prefix; a "../.." smuggled through a file path or branch used to normalize
// out of it once fetch() parsed the string as a URL. This check runs AFTER assembly
// and AFTER WHATWG normalization, so it sees the escape the input-level
// repoPathProblem guard is also there to stop. owner and repo come from the
// namespace mapping (REPO_SHAPE excludes "." and ".."), so the expected base is
// itself traversal-free.
//
// It builds the same URL new URL() will, which is why a fake fetch keyed on the raw
// concatenated string cannot substitute for this guard: the raw string still
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

export async function ghFetch(env: Env, owner: string, repo: string, path: string, init?: RequestInit): Promise<Response> {
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
// path and the ref as the literal ?ref= query, so entries for different refs are
// different keys. What was missing was deletion.
export async function cachedGet(env: Env, owner: string, repo: string, path: string): Promise<Response> {
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

// INVALIDATION AFTER A WRITE. Nothing deleted these entries, so for up to
// READ_CACHE_TTL_SECONDS after a commit a read returned the body the write
// replaced. Capsid writes and then reads back, so this is the ordinary path.
//
// Swept by REPO PREFIX rather than by computed key. A key-precise invalidation has
// to reproduce the exact spelling of every affected entry (the encoded path, the
// parent listing, the root listing's trailing slash, each in both the no-ref and the
// ?ref= spelling), and one missed spelling is a stale read. The prefix sweep matches
// the SHAPE, and it covers a merge, whose affected paths are not known here. It
// over-invalidates by one GitHub GET.
export async function invalidateRepoReads(env: Env, owner: string, repo: string): Promise<number> {
  const prefix = readPrefix(owner, repo);
  let cursor: string | undefined;
  let deleted = 0;
  try {
    do {
      const page = await env.APP_KV.list({ prefix, cursor });
      // Per PAGE, not per key (quality audit 9.4). Deletes within a page are
      // independent and this runs on the write path where a caller is waiting. Pages
      // stay sequential because the next cursor is only known once the current page
      // returns.
      await Promise.all(page.keys.map((key) => env.APP_KV.delete(key.name)));
      deleted += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err) {
    // The commit already landed. Failing the tool call because a cache sweep failed
    // would misreport the write, so this is logged by name and the stale window
    // stays bounded by the 60 second TTL.
    console.error(
      `GH_CACHE_INVALIDATION_FAILED ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return deleted;
}

// ---- repo resolution ---------------------------------------------------------

// The shape of a single repos entry: "owner/name". Tightened 2026-09-06 from
// /^[^/\s]+\/[^/\s]+$/, which admitted "../other" as a legal mapping and made the
// authorization boundary traversable. GitHub owner and repo names are drawn from
// [A-Za-z0-9._-]; a segment that is exactly "." or ".." is additionally rejected by
// repoTokenOk below, because the charset alone still matches "..".
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
// update_namespace: a non-empty array of { repo: "owner/name", label? } with label
// defaulting to "primary". Returns the normalized list or a caller-facing error.
// It does NOT enforce a single primary; update_namespace layers that on top.
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

// Resolve a namespace to one of its mapped repos. `selector` is the optional `repo`
// tool argument: a label from the namespace's repos array ("primary", "legacy") or a
// full "owner/name" that MUST appear in that array. The namespace mapping is the
// authorization boundary, so an unknown selector is rejected with the valid values
// rather than falling through to an arbitrary repo. With no selector the default is
// the entry labeled "primary", or the first entry.
export async function resolveRepo(env: Env, namespace: string, selector?: string): Promise<RepoRef> {
  const row = await env.DB.prepare("SELECT repos FROM namespaces WHERE namespace = ?1")
    .bind(namespace)
    .first<{ repos: string }>();
  if (!row) throw new Error(`unknown namespace: ${namespace}`);
  // FAILS CLOSED (audit 2, F25). A corrupt repos column used to be swallowed into an
  // empty array and reported as "has no repo mapping". That is a different fact with
  // a different fix, and indistinguishable to the caller, so the damage read as an
  // unconfigured namespace and got "fixed" by overwriting the mapping.
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

// encodePath preserves the "/" between segments, so it cannot stop traversal on its
// own: that is why "../../x" survived as real slashes plus real "..". It refuses a
// "." or ".." segment as an inner guard, and repoApiUrl asserts the assembled URL as
// the outer one. Both are kept: this gives a clear caller-facing error, that catches
// anything this misses. Exported for the traversal test.
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
// door, naming the argument. The URL assertion in repoApiUrl is the backstop; this
// is the friendly error, and the guard for arguments that reach GitHub through
// encodeURIComponent (refs, workflow names) rather than encodePath.
export function assertRepoArg(kind: string, value: string): void {
  const problem = repoPathProblem(value);
  if (problem) throw new Error(`${kind} ${problem}`);
}

export async function getDefaultBranch(env: Env, owner: string, repo: string): Promise<string> {
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}`);
  if (!resp.ok) throw new Error(`repo lookup failed (${resp.status}): ${await resp.text()}`);
  return ((await resp.json()) as { default_branch: string }).default_branch;
}

export async function getRefSha(env: Env, owner: string, repo: string, branch: string): Promise<string> {
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (!resp.ok) throw new Error(`ref lookup failed for ${branch} (${resp.status}): ${await resp.text()}`);
  return ((await resp.json()) as { object: { sha: string } }).object.sha;
}

export async function getFileSha(env: Env, owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  if (resp.status === 404) return undefined;
  if (!resp.ok) throw new Error(`file sha lookup failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { sha: string } | unknown[];
  if (Array.isArray(data)) throw new Error(`${path} is a directory`);
  return data.sha;
}

// THE DEFAULT BRANCH'S HEAD COMMIT SHA, which the improve loop needs. It read
// `(await listRepoTree(...)).sha`, and listRepoTree returns { repo, path, entries }
// with no top-level sha: the shas it carries are per-entry BLOB shas. So the
// expression was always undefined, defaultSha was always null, and selectBase always
// fell through to "no base could be resolved" with no best record and no kept
// attempt, which is a namespace's FIRST EVER run. Found 2026-09-06.
//
// The two halves already existed here as private helpers and were never composed.
export async function defaultBranchSha(env: Env, namespace: string, repoSelector?: string): Promise<string> {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const branch = await getDefaultBranch(env, owner, repo);
  return getRefSha(env, owner, repo, branch);
}
