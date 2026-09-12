import { base64Decode, base64Encode } from "../encoding";
import { DEFAULT_SCAN_FILES, DEFAULT_SCAN_RESULTS, MAX_SCAN_CAP, pathProblem } from "../limits";
import type { AttemptEnv as Env } from "../env";
import {
  assertRepoArg,
  cachedGet,
  encodePath,
  getDefaultBranch,
  getFileSha,
  getRefSha,
  ghFetch,
  invalidateRepoReads,
  resolveRepo,
} from "./client";
import { ensureBranch, openPr } from "./refs";

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
// repos under a GitHub App installation token, even for terms read_repo_file
// confirms are present. It is not a 403 or 422; the code search index does not
// serve App-token requests on private repos, which is why the hosted GitHub
// connector returns 0 as well.
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
// GitHub's primary and secondary rate limits, which both answer 403; 429 is the
// explicit rate-limit status. None is a per-file condition.
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
  // Capped server-side, the same shape ci_status uses for its limit. The schema
  // only said "positive", so max_files: 100000 would fetch one blob per candidate
  // file and burn the App installation's hourly quota for every later repo call.
  // The 5,000-entry tree refusal does not cover it: the cost is per file FETCHED,
  // not per candidate listed. Over the cap it clamps rather than refusing, because
  // the result reports truncation and carries a next_start to resume from.
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
  // Blobs that returned a survivable error. Reported so a zero-result scan cannot
  // pass for one that read everything it counted.
  const unreadable: string[] = [];
  let filesScanned = 0;
  let index = start;
  let stoppedAtFileCap = false;
  for (; index < candidates.length; index++) {
    if (filesScanned >= maxFiles) {
      // Cap reached before candidates[index] was scanned, so it is the first
      // unsearched file and a caller can resume from here.
      stoppedAtFileCap = true;
      break;
    }
    filesScanned++;
    const c = candidates[index];
    const blob = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/blobs/${c.sha}`);
    if (!blob.ok) {
      // A blob this scan could not read is NOT the same as a blob with no match.
      // On 2026-08-10 a scan for EMAIL_QUEUE across foxhound returned total_results
      // 0 with truncated=false while that string sat on three lines of one file:
      // the installation's rate limit was exhausted, every blob fetch 403'd, and
      // each one hit the bare `continue` that used to be here. That is the
      // fail-open capsid/conventions.md rules against.
      //
      // Quota and auth failures abort the whole scan: once the limit is hit every
      // later fetch fails the same way. Everything else (a 404 on a raced deletion,
      // a 5xx on one blob) is survivable, so it is counted and reported.
      if (blob.status === 401 || blob.status === 403 || blob.status === 429) {
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
    // Match line by line, then let text and its lines fall out of scope, so only one
    // blob is held in memory at a time.
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

async function putFile(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string,
  allowWorkflowWrite?: boolean
): Promise<{ commitSha: string; fileSha: string }> {
  // The write primitive's own copy of the workflow refusal, so a caller added later
  // inherits it. See workflowWriteRefusal.
  const workflowRefusal = workflowWriteRefusal(path, allowWorkflowWrite);
  if (workflowRefusal) throw new Error(workflowRefusal);
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
  // Invalidation is not here: commitOnBranch owns it for every mutation through the
  // shared dance, so there is one site rather than one per verb (quality audit 1.5).
  return { commitSha: data.commit.sha, fileSha: data.content.sha };
}

// The repo this Worker deploys from. A write landing on its default branch is a
// production deploy of the server itself, which is why commitOnBranch refuses direct
// mode, and pr mode aimed at the default branch, against it.
export const SELF_REPO = "DrDustinEdwards/capsid";

// THE WORKFLOW DIRECTORY IS NOT ORDINARY REPO CONTENT. The App holds Workflows:
// write, verified by probe. A workflow is code CI executes with that repo's secrets
// in scope.
//
// Refused unless the caller passes allow_workflow_write, which is audit-logged.
// Checked in TWO places: commitOnBranch covers both verbs including the delete path
// (which never reaches putFile), and putFile covers the write primitive, so a third
// caller added later inherits the refusal.
//
// The improve loop never passes the flag: .github/ is a protected path, so an
// attempt touching one is reverted before it is pushed.
export const WORKFLOW_DIR = ".github/workflows/";

export function workflowWriteRefusal(path: string, allow: boolean | undefined): string | null {
  if (allow === true) return null;
  // Normalised the way encodePath will see it, so "./.github/workflows/x.yml" and a
  // leading slash cannot slip past a bare startsWith.
  const segments = path.split("/").filter((seg) => seg.length > 0 && seg !== ".");
  const joined = `${segments.join("/")}/`;
  if (!joined.startsWith(WORKFLOW_DIR)) return null;
  return (
    `refuses: ${path} is under ${WORKFLOW_DIR}, and a workflow is code CI executes with this repo's secrets in scope, not ordinary file content. ` +
    `Pass allow_workflow_write: true to write it anyway; the flag is audit-logged.`
  );
}

function branchSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
}

// THE REPO MUTATION DANCE, once (quality audit 1.5).
//
// write_repo_file and delete_repo_file are the same six steps with a different verb
// in the middle: resolve the repo, find the default branch, cut a work branch in pr
// mode, mutate, INVALIDATE THE READ CACHE, and open a PR in pr mode. The fifth step
// is the hazard: a stale read cache serves the pre-write body for up to 60 seconds,
// and nothing enforced the call when the steps were written out twice.
//
// Response SHAPING stays with each caller. The two responses differ (write carries a
// fileSha, delete does not, and write's pr mode omits it), and folding that in here
// would either change what a caller sees or push per-verb conditionals into the
// shared step.
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
    allowWorkflowWrite?: boolean;
    mutate: (owner: string, repo: string, target: string) => Promise<R>;
  }
): Promise<{
  base: { repo: string; mode: "pr" | "direct"; branch: string; path: string };
  result: R;
  pr: { number: number; url: string } | null;
}> {
  assertRepoArg("path", path);
  if (branch) assertRepoArg("branch", branch);
  // BEFORE ANY NETWORK CALL, and before the repo is resolved: a refusal that costs a
  // round trip is a refusal an attacker can probe with. This covers
  // delete_repo_file too, whose mutate does its own ghFetch and never reaches
  // putFile.
  const workflowRefusal = workflowWriteRefusal(path, op.allowWorkflowWrite);
  if (workflowRefusal) throw new Error(workflowRefusal);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  // THE SERVER'S OWN DEFAULT BRANCH CANNOT BE WRITTEN: CI deploys this Worker on
  // every push to it, so a commit landing there IS a production deploy behind a
  // write-grant key.
  //
  // SCOPED TO THE DEFAULT BRANCH. Refusing mode "direct" against this repo outright
  // was too wide: the improve loop pushes every attempt to a branch in direct mode,
  // so on the namespace mapping to this repo EVERY attempt threw on its first file.
  //
  // The cheap half, kept from the 2026-09-06 fix: direct mode with NO branch always
  // resolves to the default branch, so it is refused without a GitHub round trip.
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

  // The commit has landed, so every cached read of this repo is potentially stale.
  // Swept here, for both verbs, before the PR is opened.
  await invalidateRepoReads(env, owner, repo);

  const base = { repo: `${owner}/${repo}`, mode, branch: target, path };
  if (mode === "direct") return { base, result, pr: null };

  const title = message.split("\n")[0] || op.fallbackTitle;
  // Pass the resolved repo full name so the PR lands on the repo the file was
  // committed to, not the namespace default.
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
  repoSelector?: string,
  allowWorkflowWrite?: boolean
) {
  const { base, result, pr } = await commitOnBranch(env, namespace, path, message, mode, branch, repoSelector, {
    branchPrefix: "capsid/",
    fallbackTitle: `Update ${path}`,
    prBody: `Automated change to \`${path}\` via Capsid.`,
    allowWorkflowWrite,
    mutate: (owner, repo, target) => putFile(env, owner, repo, path, content, message, target, allowWorkflowWrite),
  });
  // The flag is RETURNED so it lands in audit_log via guardedWrite, which files the
  // whole result. A workflow authored through this tool is greppable afterwards.
  const flag = allowWorkflowWrite === true ? { allow_workflow_write: true } : {};
  // direct carries the file sha as well as the commit sha; pr mode never has. The
  // asymmetry is preserved because tidying it would change what a caller receives.
  if (!pr) return { ...base, ...result, ...flag };
  return { ...base, commitSha: result.commitSha, pr, ...flag };
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
  repoSelector?: string,
  allowWorkflowWrite?: boolean
) {
  const { base, result, pr } = await commitOnBranch(env, namespace, path, message, mode, branch, repoSelector, {
    branchPrefix: "capsid/rm-",
    fallbackTitle: `Delete ${path}`,
    prBody: `Delete \`${path}\` via Capsid.`,
    allowWorkflowWrite,
    mutate: async (owner, repo, target) => {
      // GitHub's contents DELETE needs the CURRENT file sha, so a missing file is an
      // error rather than a no-op. Read on the target branch, which in pr mode is
      // the work branch just cut from the default.
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
  const flag = allowWorkflowWrite === true ? { allow_workflow_write: true } : {};
  if (!pr) return { ...base, commitSha: result.commitSha, ...flag };
  return { ...base, commitSha: result.commitSha, pr, ...flag };
}

export const REPO_BATCH_MAX_FILES = 20;
export const REPO_FILE_BUDGET = 200 * 1024;

/** Read up to REPO_BATCH_MAX_FILES files, each independently. ONE MISSING PATH DOES
 *  NOT FAIL THE BATCH: a batch is triage, and a triage call that throws because one
 *  of twenty paths moved has to be retried by bisection.
 *
 *  THE PER-FILE BUDGET APPLIES HERE AND NOT TO THE SINGLE-PATH READ. There was no
 *  repo read budget before this, so applying one to readRepoFile would make an
 *  existing call start truncating silently. */
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

// EVERY BLOB PATH ON THE DEFAULT BRANCH, in one call.
//
// Added 2026-09-07 for the truth report's doc-vs-code drift check, which asks a
// set-membership question about a few hundred paths. It reuses searchCode's tree
// fetch and size refusal: a recursive tree on a large repo is one response, and
// GitHub truncates it silently past a limit.
//
// Returns null rather than throwing when the tree cannot be read or is too large.
// The caller reports that check as UNRUN; an empty set would report every cited path
// as drift.
export async function repoBlobPaths(env: Env, namespace: string, repoSelector?: string): Promise<Set<string> | null> {
  try {
    const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
    const ref = await getDefaultBranch(env, owner, repo);
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (!resp.ok) return null;
    const tree = (await resp.json()) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
    if (!Array.isArray(tree.tree) || tree.truncated || tree.tree.length > SEARCH_TREE_LIMIT) return null;
    return new Set(tree.tree.filter((e) => e.type === "blob").map((e) => e.path));
  } catch {
    return null;
  }
}
