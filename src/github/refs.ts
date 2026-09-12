import { IMPROVE_BRANCH_PREFIX, isImproveBranch } from "../improve-schema";
import type { AttemptEnv as Env } from "../env";
import {
  assertRepoArg,
  cachedGet,
  encodePath,
  getDefaultBranch,
  getRefSha,
  ghFetch,
  invalidateRepoReads,
  resolveRepo,
} from "./client";

// The create-a-work-branch step, shared by write_repo_file and delete_repo_file in
// pr mode (audit 2, F24). create_branch does NOT use it: as an explicit tool it must
// fail when the branch already exists, and this tolerates that case on purpose.
export async function ensureBranch(env: Env, owner: string, repo: string, branch: string, fromSha: string): Promise<void> {
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

// Branch from an exact COMMIT, which createBranch cannot do: it takes a branch name
// and resolves it to whatever that branch points at now. The improve loop branches
// from the commit the lineage picked, which is frequently not the tip of anything.
//
// ensureBranch is used rather than a raw ref POST so an existing branch of the same
// name is not an error. An attempt id is unique, so a collision is a retry of the
// same attempt, and a retry should land on the branch it made.
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

// Merge or close an open pull request. Merging can trigger CI deploys in repos with
// deploy workflows, so callers gate by blast radius (see conventions).

// THE HEAD BRANCH IS DELETED WHEN A PR CLOSES OR MERGES (capsid/conventions.md,
// ruled 2026-09-06). write_repo_file's default PR mode creates a branch per write
// and nothing was cleaning them up: a sweep across five repos on that date found 18
// deletable branches.
//
// Three refusals:
//   1. Never the default branch. A PR whose head IS the default branch is a
//      cross-fork PR or a misconfiguration.
//   2. Never an improve-loop branch. The loop may still need the attempt and its own
//      lifecycle owns those refs; delete_branch refuses them without force too.
//   3. NEVER FAILS THE PR ACTION. The merge or close already succeeded, and failing
//      the call because a branch delete failed would misreport the merge. Same rule
//      as invalidateRepoReads. The outcome is reported in head_branch_deleted.
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

    // A head branch on a FORK is not this App's to delete, and the token could not
    // anyway. Compared by full_name rather than inferred from the ref.
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
  action: "merge" | "close" | "comment",
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
  repoSelector?: string,
  comment?: string
) {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  // A COMMENT LEAVES THE PULL REQUEST OPEN AND CHANGES NO BRANCH. It is handled
  // before the other two for that reason: it must never reach the head-branch
  // cleanup below, which exists because merge and close END a pull request.
  if (action === "comment") {
    if (!comment) throw new Error("comment needs a body; a comment action with nothing to say is a call that did nothing.");
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: comment }),
    });
    if (!resp.ok) throw new Error(`comment failed (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as { id: number; html_url: string };
    return { repo: `${owner}/${repo}`, number, action: "comment", comment_id: data.id, url: data.html_url };
  }
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

// ---- the repo fallthrough widening, 2026-09-06 --------------------------------
//
// WHY THESE FOUR EXIST. The claude.ai GitHub connector authenticates and then 404s
// on every private repo in the portfolio (open Anthropic issues #68517, #71542,
// #72032, #79083 since June). This module's App installation token already reaches
// every mapped repo, so these make existing reach callable rather than adding
// capability. Recorded in capsid/decisions.md under the second lean-surface
// exception of 2026-09-06.
//
// Each goes through resolveRepo, ghFetch and cachedGet. Nothing here opens its own
// path to api.github.com, which is the rule stated over dispatchWorkflow.

/** Branches, tags and open PRs in one call. The triage question is "what is in flight
 *  here", which is three GETs the caller would otherwise make separately.
 *  Ahead/behind is per branch against the default branch. */
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

  // Ahead/behind comes from the compare endpoint, one call per branch. The default
  // branch is skipped: comparing it with itself is always 0/0. The fan-out is bounded
  // by the 100-branch page above; a repo with more branches reports its first hundred
  // and sets truncated.
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
    // FIRST LINE ONLY. A commit body in this repo family runs to paragraphs, and
    // inlining them buries the shape of the history. Read one commit by sha for the
    // full message.
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
 *  PRESENT. An ambiguous combination is refused rather than resolved by precedence:
 *  a caller passing both sha and base has two questions and gets neither answered
 *  silently. */
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

/** Delete a branch. THREE REFUSALS, each naming itself. force lifts only two: the
 *  default branch is never deletable through this tool. */
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

  // NOT LIFTABLE BY force. A flag that could delete a repo's default branch is a flag
  // that eventually will, so this refusal is checked before force is read.
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
    // Skipping the refusal on a 5xx would delete the branches this check protects, on
    // the days GitHub is flaky.
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
