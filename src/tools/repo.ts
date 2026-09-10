import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import {
  CI_DISPATCH_POLL_MS,
  CI_LOG_BUDGET,
  ciDispatch,
  ciStatus,
  createBranch,
  deleteBranch,
  deleteRepoFile,
  listRepoTree,
  managePr,
  openPr,
  readRepoFile,
  readRepoFiles,
  REPO_BATCH_MAX_FILES,
  REPO_FILE_BUDGET,
  REPO_HISTORY_DEFAULT_LIMIT,
  REPO_HISTORY_MAX_LIMIT,
  REPO_PATCH_BUDGET,
  repoHistory,
  repoRefs,
  searchCode,
  writeRepoFile,
} from "../github";
import { bounded, CI_DISPATCH_MAX_INPUTS, DEFAULT_SCAN_FILES, DEFAULT_SCAN_RESULTS, MAX_BODY, MAX_COMMIT_MESSAGE, MAX_PATH, MAX_PR_BODY, MAX_PR_TITLE, MAX_QUERY, MAX_REF, MAX_REPO_SELECTOR, MAX_SCAN_CAP, MAX_SHA, nsName } from "../limits";
import { DENIED, fail, ok, type ToolCtx } from "./docs";

export function registerRepoTools(server: McpServer, ctx: ToolCtx): void {
  const { env, db, mayWrite, actor } = ctx;

  // Repo fallthrough: live GitHub access via the Capsid GitHub App. Reads are
  // open to any admitted client; writes require the operator key. The target
  // repo is resolved per namespace from the namespaces table.
  const guarded = async (fn: () => Promise<unknown>) => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  // Repo writes are operator-gated and audit-logged. The whole result (which
  // includes the resolved repo) goes into params so a misdirected write is
  // diagnosable from the log; path is the file path where one applies.
  const guardedWrite = async (
    action: string,
    namespace: string,
    path: string | null,
    fn: () => Promise<Record<string, unknown>>
  ) => {
    if (!mayWrite) return fail(DENIED);
    let result: Record<string, unknown>;
    try {
      result = await fn();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    // THE MUTATION ALREADY LANDED (audit 2, F17). fn() has committed to GitHub by the
    // time this row is written, and the audit INSERT is a separate statement that
    // cannot be rolled into it. When it failed the caller was told the tool failed, so
    // "the branch exists, the PR is open, and the log does not know" came out as
    // "nothing happened", and a caller acting on that retries into a second commit.
    //
    // The D1-only tools do not need this: delete, move and finalize put the audit
    // INSERT inside the same batch as the mutation. GitHub cannot join that
    // transaction.
    try {
      await db
        .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(actor, action, namespace, path, JSON.stringify(result))
        .run();
    } catch (err) {
      console.error(`AUDIT_INSERT_FAILED ${action} ${namespace}/${path ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
      return ok({
        ...result,
        audit_warning:
          `THE ${action} SUCCEEDED and is described by this result, but the audit_log row could not be written: ` +
          `${err instanceof Error ? err.message : String(err)}. Do not retry this call; the change is already made.`,
      });
    }
    return ok(result);
  };

  // A namespace can map to more than one repo (foxhound -> foxhound primary plus
  // recova legacy). The optional `repo` argument on every repo tool selects one: a
  // label ("primary", "legacy") or a full "owner/name" mapped to the namespace. Omit
  // it to target the primary. `namespaces` shows the mapping.
  const REPO_ARG = "Optional repo selector for a multi-repo namespace: a label (\"primary\", \"legacy\") or a mapped \"owner/name\". Defaults to the primary repo.";

  server.registerTool(
    "list_repo_tree",
    {
      annotations: hintsFor("list_repo_tree"),
      description: "List a directory in a namespace's GitHub repo. Omit path for the repo root. Live GitHub, briefly cached.",
      inputSchema: { namespace: nsName, path: bounded(MAX_PATH).optional(), ref: bounded(MAX_REF).optional(), repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG) },
    },
    ({ namespace, path, ref, repo }) => guarded(() => listRepoTree(env, namespace, path ?? "", ref, repo))
  );

  server.registerTool(
    "read_repo_file",
    {
      annotations: hintsFor("read_repo_file"),
      description: `Read a file from a namespace's GitHub repo, decoded to text. Optional ref (branch, tag, or sha). Live GitHub, briefly cached. Pass EITHER path for one file, or paths for up to ${REPO_BATCH_MAX_FILES} in one call; in the batch form each file succeeds or fails independently, so one missing path returns its error beside the others instead of failing the call, and each file is capped at ${REPO_FILE_BUDGET} bytes with truncated:true when it is cut. REFUSES: both path and paths together, neither of them, an empty paths array, more than ${REPO_BATCH_MAX_FILES} paths, and a directory (use list_repo_tree).`,
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH).optional(),
        paths: z
          .array(bounded(MAX_PATH))
          .max(REPO_BATCH_MAX_FILES)
          .optional()
          .describe(`Up to ${REPO_BATCH_MAX_FILES} paths, read independently. Alternative to path, not combinable with it.`),
        ref: bounded(MAX_REF).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, path, paths, ref, repo }) =>
      guarded(() => {
        // EXACTLY ONE OF THE TWO. Accepting both and preferring one would make the
        // ignored argument invisible.
        if (path && paths) throw new Error("read_repo_file: pass path for one file or paths for several, not both");
        if (!path && !paths) throw new Error("read_repo_file: pass path for one file, or paths for several");
        return paths ? readRepoFiles(env, namespace, paths, ref, repo) : readRepoFile(env, namespace, path as string, ref, repo);
      })
  );

  server.registerTool(
    "search_code",
    {
      annotations: hintsFor("search_code"),
      description:
        "Case-insensitive substring search across a namespace repo's files. Walks the repo tree and greps blobs server-side (GitHub's code-search index does not serve these private repos over an App token), so scope with path_prefix on large repos. Returns path, line number, and the matching line. When it stops early it sets truncated:true with a note explaining why and a next_start to resume from (or raise max_files); a truncated result is a partial scan, not an empty repo. namespace is required.",
      inputSchema: {
        query: bounded(MAX_QUERY),
        namespace: nsName,
        path_prefix: bounded(MAX_PATH).optional().describe("Only scan files whose path starts with this prefix, e.g. 'app/lib/billing'."),
        ref: bounded(MAX_REF).optional().describe("Branch, tag, or sha to search. Defaults to the default branch."),
        max_results: z.number().int().positive().optional().describe(`Cap on returned matches (default ${DEFAULT_SCAN_RESULTS}, max ${MAX_SCAN_CAP}).`),
        max_files: z.number().int().positive().optional().describe(`Cap on files fetched and scanned (default ${DEFAULT_SCAN_FILES}, max ${MAX_SCAN_CAP}). A wider sweep resumes with start, because each file costs one GitHub request against the App installation's quota; narrowing path_prefix is cheaper.`),
        start: z.number().int().nonnegative().optional().describe("Candidate-file offset to resume a truncated scan; pass the previous result's next_start."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ query, namespace, path_prefix, ref, max_results, max_files, start, repo }) =>
      guarded(() =>
        searchCode(env, namespace, query, {
          pathPrefix: path_prefix,
          ref,
          maxResults: max_results,
          maxFiles: max_files,
          start,
          repoSelector: repo,
        })
      )
  );

  server.registerTool(
    "write_repo_file",
    {
      annotations: hintsFor("write_repo_file"),
      description:
        "Write a file to a namespace's GitHub repo. mode 'pr' (default) commits to a new branch and opens a PR; mode 'direct' commits straight to the default branch. REFUSES any path under .github/workflows/ unless allow_workflow_write: true is passed, which is audit-logged: a workflow is code CI executes with the repo's secrets in scope. Requires operator key.",
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH),
        content: bounded(MAX_BODY),
        message: bounded(MAX_COMMIT_MESSAGE),
        mode: z.enum(["pr", "direct"]).optional(),
        branch: bounded(MAX_REF).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
        allow_workflow_write: z
          .boolean()
          .optional()
          .describe(
            "Opt in to writing under .github/workflows/. Refused without it: a workflow is code CI executes with this repo's secrets in scope, not ordinary file content, and this App holds Workflows: write on every mapped repo. Audit-logged when passed."
          ),
      },
    },
    ({ namespace, path, content, message, mode, branch, repo, allow_workflow_write }) =>
      guardedWrite("write_repo_file", namespace, path, () =>
        writeRepoFile(env, namespace, path, content, message, mode ?? "pr", branch, repo, allow_workflow_write)
      )
  );

  server.registerTool(
    "create_branch",
    {
      annotations: hintsFor("create_branch"),
      description: "Create a branch in a namespace's GitHub repo. Branches off the default branch unless 'from' is given. Requires operator key.",
      inputSchema: { namespace: nsName, branch: bounded(MAX_REF), from: bounded(MAX_REF).optional(), repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG) },
    },
    ({ namespace, branch, from, repo }) =>
      guardedWrite("create_branch", namespace, null, () => createBranch(env, namespace, branch, from, repo))
  );

  server.registerTool(
    "open_pr",
    {
      annotations: hintsFor("open_pr"),
      description: "Open a pull request in a namespace's GitHub repo. Base defaults to the repo's default branch. Requires operator key.",
      inputSchema: {
        namespace: nsName,
        title: bounded(MAX_PR_TITLE),
        head: bounded(MAX_REF),
        base: bounded(MAX_REF).optional(),
        body: bounded(MAX_PR_BODY).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, title, head, base, body, repo }) =>
      guardedWrite("open_pr", namespace, null, () => openPr(env, namespace, title, head, base, body, repo))
  );

  server.registerTool(
    "delete_repo_file",
    {
      annotations: hintsFor("delete_repo_file"),
      description:
        "Delete a file from a namespace's GitHub repo. mode 'pr' (default) commits the deletion to a new branch and opens a PR; mode 'direct' deletes on the default branch. The file must exist. REFUSES any path under .github/workflows/ unless allow_workflow_write: true is passed, which is audit-logged. Requires operator key.",
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH),
        message: bounded(MAX_COMMIT_MESSAGE),
        mode: z.enum(["pr", "direct"]).optional(),
        branch: bounded(MAX_REF).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
        allow_workflow_write: z
          .boolean()
          .optional()
          .describe(
            "Opt in to writing under .github/workflows/. Refused without it: a workflow is code CI executes with this repo's secrets in scope, not ordinary file content, and this App holds Workflows: write on every mapped repo. Audit-logged when passed."
          ),
      },
    },
    ({ namespace, path, message, mode, branch, repo, allow_workflow_write }) =>
      guardedWrite("delete_repo_file", namespace, path, () =>
        deleteRepoFile(env, namespace, path, message, mode ?? "pr", branch, repo, allow_workflow_write)
      )
  );

  server.registerTool(
    "manage_pr",
    {
      annotations: hintsFor("manage_pr"),
      description:
        "Merge or close an open pull request in a namespace's repo. action 'merge' uses merge_method (default 'squash'); action 'close' just closes it. EITHER WAY IT DELETES THE HEAD BRANCH, because write_repo_file's PR mode creates one per write and nothing else cleans them up (capsid/conventions.md, 2026-09-06); the result carries head_branch and head_branch_deleted, plus head_branch_note when it declined. It REFUSES to delete the default branch, a branch under the improve loop's prefix, or a head branch on a fork, and a cleanup failure never fails the merge or close itself since that already succeeded. Merging can trigger CI deploys in repos with deploy workflows (foxhound): prefer PR mode plus manage_pr for anything touching live behavior, per conventions. Requires operator key.",
      inputSchema: {
        namespace: nsName,
        number: z.number().int().positive(),
        action: z.enum(["merge", "close"]),
        merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, number, action, merge_method, repo }) =>
      guardedWrite("manage_pr", namespace, null, () => managePr(env, namespace, number, action, merge_method ?? "squash", repo))
  );

  server.registerTool(
    "ci_status",
    {
      annotations: hintsFor("ci_status"),
      description: `Recent CI workflow runs for a namespace's repo (name, head sha, status, conclusion, timestamps). Optional ref narrows to one branch or head sha; optional run_id returns just that run. For the most recent failed run it also returns the failing jobs and steps, and for write-grant keys the FAILING STEP's log, up to ${CI_LOG_BUDGET} bytes from its end, with log_region naming which region was returned. A read-only key gets the metadata and a note saying the log was withheld, because job logs can echo ids and variables. REFUSES: a run_id that does not exist on the repo. Read-only; use it to verify a deploy is green after a merge instead of guessing. Needs the GitHub App's Actions: Read permission.`,
      inputSchema: {
        namespace: nsName,
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
        limit: z.number().int().positive().optional().describe("How many recent runs to return (default 10, max 20)."),
        ref: bounded(MAX_REF)
          .optional()
          .describe("Narrow to one branch or head sha. A hex object name is filtered as a sha, anything else as a branch."),
        run_id: z.number().int().positive().optional().describe("Return only this run, by its GitHub run id."),
      },
    },
    ({ namespace, repo, limit, ref, run_id }) =>
      guarded(() => ciStatus(env, namespace, repo, { limit, logTail: mayWrite, ref, runId: run_id }))
  );

  // THE REPO FALLTHROUGH WIDENING, the SECOND ruled exception to hard rule 1 in one
  // day (capsid/decisions.md, 2026-09-06). The justification is not that these are
  // useful: the claude.ai GitHub connector authenticates and then 404s on every
  // private repo in the portfolio, while Capsid's App token has reached them all since
  // 2026-07-06. These four make existing reach callable.
  //
  // repo_refs and repo_history are READS and stay open to ro: keys. delete_branch and
  // ci_dispatch are write-gated: one destroys refs, the other spends CI minutes and
  // can start a deploy.

  server.registerTool(
    "repo_refs",
    {
      annotations: hintsFor("repo_refs"),
      description:
        "What is in flight in a namespace's repo, in one call: branches (name, head sha, last commit date, ahead/behind the default branch, and the open PR number if the branch has one), tags, and open pull requests. Answers the triage question that otherwise costs three separate calls. Sets truncated:true when any of the three lists hit its 100-item page. Read-only, live GitHub, briefly cached.",
      inputSchema: { namespace: nsName, repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG) },
    },
    ({ namespace, repo }) => guarded(() => repoRefs(env, namespace, repo))
  );

  server.registerTool(
    "repo_history",
    {
      annotations: hintsFor("repo_history"),
      description: `Commits, a comparison, or one commit, chosen by which argument is present: ref for the commits on a ref (default ${REPO_HISTORY_DEFAULT_LIMIT}, max ${REPO_HISTORY_MAX_LIMIT}); base and head together for a comparison (ahead/behind, the commit list, and changed files with status and line counts); sha for one commit (full message, parents, changed files). Patch bodies are omitted unless patch:true, and are then budgeted to ${REPO_PATCH_BUDGET} bytes across the whole response with patch_truncated:true when the budget runs out. Commit subjects are the first line only; read one commit by sha for its whole message. REFUSES: more than one of sha / base+head / ref, since those are different questions; base without head or head without base; and none of them. Read-only.`,
      inputSchema: {
        namespace: nsName,
        ref: bounded(MAX_REF).optional().describe("Commits on this branch, tag or sha."),
        base: bounded(MAX_REF).optional().describe("Comparison base. Requires head."),
        head: bounded(MAX_REF).optional().describe("Comparison head. Requires base."),
        sha: bounded(MAX_SHA).optional().describe("One commit, in full."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`How many commits (default ${REPO_HISTORY_DEFAULT_LIMIT}, max ${REPO_HISTORY_MAX_LIMIT}).`),
        patch: z.boolean().optional().describe("Include patch bodies, budgeted. Off by default."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, ref, base, head, sha, limit, patch, repo }) =>
      guarded(() => repoHistory(env, namespace, { ref, base, head, sha, limit, patch }, repo))
  );

  server.registerTool(
    "delete_branch",
    {
      annotations: hintsFor("delete_branch"),
      description:
        "Delete a branch in a namespace's GitHub repo. REFUSES, naming which refusal it is: the repo's default branch, ALWAYS, and force does not lift that one; a branch under the improve loop's branch prefix, because it may be an attempt the loop still needs; and a branch with an open pull request. The last two are lifted by force:true. Also refuses a branch that does not exist rather than reporting a no-op as success. Requires an operator key with the write grant; audit-logged.",
      inputSchema: {
        namespace: nsName,
        branch: bounded(MAX_REF),
        force: z
          .boolean()
          .optional()
          .describe("Lift the improve-prefix and open-PR refusals. Does NOT lift the default-branch refusal."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, branch, force, repo }) =>
      guardedWrite("delete_branch", namespace, null, () => deleteBranch(env, namespace, branch, { force }, repo))
  );

  server.registerTool(
    "ci_dispatch",
    {
      annotations: hintsFor("ci_dispatch"),
      description: `Start a workflow, or rerun one's failed jobs. Pass workflow (the file name, e.g. ci.yml) and ref to trigger a workflow_dispatch: the dispatch endpoint answers 204 with no body, so this then polls for up to ${CI_DISPATCH_POLL_MS / 1000}s and returns the run_id of the run that appeared, or run_id null with a note saying the dispatch was accepted but nothing started. Pass run_id alone to rerun that run's failed jobs. REFUSES, naming it: a workflow with no workflow_dispatch trigger, which cannot be started by hand at all; and workflow together with run_id, which are two different requests. Requires an operator key with the write grant; audit-logged. Spends CI minutes and can start a deploy.`,
      inputSchema: {
        namespace: nsName,
        workflow: bounded(MAX_PATH).optional().describe("Workflow file name, e.g. ci.yml. Requires ref."),
        ref: bounded(MAX_REF).optional().describe("The branch or sha to run the workflow on. Requires workflow."),
        run_id: z.number().int().positive().optional().describe("Rerun this run's failed jobs. Not combinable with workflow."),
        inputs: z
          .record(bounded(MAX_REF), bounded(MAX_REF))
          .refine((map) => Object.keys(map).length <= CI_DISPATCH_MAX_INPUTS, {
            message: `at most ${CI_DISPATCH_MAX_INPUTS} workflow inputs: GitHub's own workflow_dispatch ceiling is ${CI_DISPATCH_MAX_INPUTS}, so a larger map can never be valid`,
          })
          .optional()
          .describe("workflow_dispatch inputs, as a flat string map."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, workflow, ref, run_id, inputs, repo }) =>
      guardedWrite("ci_dispatch", namespace, null, () => ciDispatch(env, namespace, { workflow, ref, run_id, inputs }, repo))
  );
}
