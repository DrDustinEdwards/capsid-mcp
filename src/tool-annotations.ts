// MCP tool annotations, and the reason they are a table rather than 30 inline
// literals.
//
// An annotation is a HINT a client acts on. `readOnlyHint: true` on a tool that
// writes is worse than no annotation at all, because a client that trusts it will
// stop asking. So the values here are a CACHE, exactly like src/counts.ts, and
// test/tool-annotations.test.ts is the source of truth: it derives each flag from
// the handler's own source and fails when the table and the code disagree, in
// both directions.
//
// The two derivations, each mechanical:
//
//   readOnlyHint     the NEGATION of the write gate. A tool is write-gated iff its
//                    handler reaches `if (!mayWrite) return fail(DENIED)` or goes
//                    through `guardedWrite(`. Nothing about this is a judgement
//                    call, and it is the flag a client is most likely to trust.
//   destructiveHint  true iff a write-gated handler can overwrite or remove state
//                    that already exists, matched by SHAPE (an UPDATE, a DELETE, a
//                    pathMutation, a repo delete, a merge). Additive-only tools
//                    (create_branch, open_pr, register_namespace) are false.
//
// idempotentHint and openWorldHint are deliberately ABSENT, and openWorldHint was
// written and then removed on the day this file was added. The obvious derivation
// ("the handler calls into src/github.ts") is one hop deep, and the scan
// immediately disagreed with the table twice: register_namespace and
// update_namespace DO reach GitHub, through repoTokenOk, while improve_run reaches
// it only through improve-run.ts and so read as closed-world while dispatching a
// workflow. A transitive derivation over modules is too coarse to fix that, and a
// hand-maintained list is the thing this file exists to avoid. So the two hints
// that can be derived are the two hints that ship. A hint nothing checks is the
// kind of claim this file exists to stop.

export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

const read = (): ToolHints => ({ readOnlyHint: true, destructiveHint: false });
const additive = (): ToolHints => ({ readOnlyHint: false, destructiveHint: false });
const destructive = (): ToolHints => ({ readOnlyHint: false, destructiveHint: true });

export const TOOL_HINTS: Record<string, ToolHints> = {
  // ---- the store, read ----
  list: read(),
  read: read(),
  brief: read(),
  backlinks: read(),
  find: read(),
  search: read(),
  namespaces: read(),
  history: read(),

  // ---- the store, write ----
  // write overwrites a body in replace and patch mode; append and meta do not, but
  // one tool gets one hint and the honest one is the destructive reading.
  write: destructive(),
  delete: destructive(),
  move: destructive(),
  // restore writes a snapshot back over the current body. It snapshots first and is
  // itself undoable, which makes it recoverable, not non-destructive.
  restore: destructive(),
  // lint's gather half is read-only and its finalize half archives by rewriting the
  // path column. One tool, one hint, and finalize is what decides it.
  lint: destructive(),
  register_namespace: additive(),
  update_namespace: destructive(),

  // ---- the repos ----
  list_repo_tree: read(),
  read_repo_file: read(),
  search_code: read(),
  repo_refs: read(),
  repo_history: read(),
  ci_status: read(),
  write_repo_file: destructive(),
  create_branch: additive(),
  open_pr: additive(),
  delete_repo_file: destructive(),
  // manage_pr merges or closes, and deletes the head branch either way.
  manage_pr: destructive(),
  delete_branch: destructive(),
  // ci_dispatch starts a workflow run. It removes nothing, and what the run then
  // does is the workflow's business rather than this tool's.
  ci_dispatch: additive(),

  // ---- the improve loop ----
  improve_status: read(),
  // improve_run's control actions change the loop's mode, pause a namespace and
  // revert attempts.
  improve_run: destructive(),
};

// The lookup used at every registration site. Object.hasOwn rather than a bare
// index, for the reason recorded in src/counts.ts: a bare lookup of "constructor"
// on an object literal returns the Object function, which is not nullish, so a
// `?? fallback` never fires and the caller gets a function where it expected a
// record. Measured on this codebase 2026-09-06.
export function hintsFor(tool: string): ToolHints {
  if (!Object.hasOwn(TOOL_HINTS, tool)) {
    // A tool with no entry is annotated as neither read-only nor safe. Failing
    // closed here means a new tool is under-claimed rather than over-claimed until
    // the table catches up, and test/tool-annotations.test.ts fails the build in
    // the same commit.
    return { readOnlyHint: false, destructiveHint: true };
  }
  return TOOL_HINTS[tool];
}
