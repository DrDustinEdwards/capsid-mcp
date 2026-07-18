// GitHub App repo access for Capsid's repo fallthrough.
//
// Mints short-lived installation tokens from the App private key (RS256 JWT via
// Web Crypto) and caches them in APP_KV for ~55 minutes. Resolves the target
// repo per namespace from the D1 namespaces table, then reads and writes files
// over the live GitHub REST API. No PAT, no clone.

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

export interface RepoRef {
  owner: string;
  repo: string;
  full: string;
}

// ---- base64url + key handling ------------------------------------------------

function b64urlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromString(text: string): string {
  return b64urlFromBytes(new TextEncoder().encode(text));
}

function decodeBase64Utf8(b64: string): string {
  const bytes = Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

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
  const header = b64urlFromString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlFromString(JSON.stringify({ iss: env.GITHUB_APP_CLIENT_ID, iat: now - 60, exp: now + 540 }));
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
  const cacheKey = `gh:install:${owner}`;
  const cached = await env.APP_KV.get(cacheKey);
  if (cached) return cached;
  if (env.GITHUB_APP_INSTALLATION_ID) {
    await env.APP_KV.put(cacheKey, env.GITHUB_APP_INSTALLATION_ID, { expirationTtl: INSTALL_TTL_SECONDS });
    return env.GITHUB_APP_INSTALLATION_ID;
  }
  const resp = await appFetch(env, `/repos/${owner}/${repo}/installation`);
  if (!resp.ok) {
    throw new Error(`could not resolve GitHub App installation for ${owner}/${repo} (${resp.status}): ${await resp.text()}`);
  }
  const data = (await resp.json()) as { id: number };
  const id = String(data.id);
  await env.APP_KV.put(cacheKey, id, { expirationTtl: INSTALL_TTL_SECONDS });
  return id;
}

async function getInstallationToken(env: Env, owner: string, repo: string): Promise<string> {
  const cacheKey = `gh:token:${owner}`;
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
    await env.APP_KV.delete(`gh:token:${owner}`);
    resp = await call(await getInstallationToken(env, owner, repo));
  }
  return resp;
}

async function cachedGet(env: Env, owner: string, repo: string, path: string): Promise<Response> {
  const cacheKey = `gh:get:${path}`;
  const cached = (await env.APP_KV.get(cacheKey, "json")) as { status: number; body: string } | null;
  if (cached) return new Response(cached.body, { status: cached.status });
  const resp = await ghFetch(env, owner, repo, path);
  const body = await resp.text();
  if (resp.ok) {
    await env.APP_KV.put(cacheKey, JSON.stringify({ status: resp.status, body }), { expirationTtl: READ_CACHE_TTL_SECONDS });
  }
  return new Response(body, { status: resp.status });
}

// ---- repo resolution ---------------------------------------------------------

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
  let list: Array<{ repo: string; label?: string }> = [];
  try {
    list = JSON.parse(row.repos || "[]");
  } catch {
    list = [];
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
    content = decodeBase64Utf8(data.content);
  } else {
    // Files over 1 MB come back without inline content; fetch the blob by sha.
    const blob = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/blobs/${data.sha}`);
    if (!blob.ok) throw new Error(`read_repo_file blob fetch failed (${blob.status})`);
    const blobData = (await blob.json()) as { content: string; encoding: string };
    content = decodeBase64Utf8(blobData.content);
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

export async function searchCode(
  env: Env,
  namespace: string | undefined,
  query: string,
  opts: { pathPrefix?: string; ref?: string; repoSelector?: string; maxResults?: number; maxFiles?: number } = {}
) {
  if (!namespace) {
    throw new Error("search_code needs a namespace: it walks one repo's tree. Pass namespace (and optional repo).");
  }
  const { owner, repo, full } = await resolveRepo(env, namespace, opts.repoSelector);
  const ref = opts.ref || (await getDefaultBranch(env, owner, repo));
  const maxResults = opts.maxResults && opts.maxResults > 0 ? opts.maxResults : 20;
  const maxFiles = opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : 50;
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
  let filesScanned = 0;
  let capped = false;
  for (const c of candidates) {
    if (filesScanned >= maxFiles) {
      capped = true;
      break;
    }
    filesScanned++;
    const blob = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/blobs/${c.sha}`);
    if (!blob.ok) continue;
    const blobData = (await blob.json()) as { content?: string; encoding?: string };
    if (blobData.encoding !== "base64" || !blobData.content) continue;
    let text: string;
    try {
      text = decodeBase64Utf8(blobData.content);
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
      capped = filesScanned < candidates.length;
      break;
    }
  }

  return {
    repo: full,
    ref,
    query,
    candidates: candidates.length,
    files_scanned: filesScanned,
    total_results: items.length,
    truncated: capped,
    items,
  };
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
      content: encodeBase64Utf8(content),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`commit failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { commit: { sha: string }; content: { sha: string } };
  return { commitSha: data.commit.sha, fileSha: data.content.sha };
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
  const created = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${work}`, sha: headSha }),
  });
  if (!created.ok && created.status !== 422) {
    // 422 means the branch already exists, which is fine when a caller passed one.
    throw new Error(`branch create failed (${created.status}): ${await created.text()}`);
  }
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
