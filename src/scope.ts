import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Agent } from "./agents";
import { allowsScope, allowsToolAction, describeScope, type AgentGrant, type ScopeFlag } from "./agents-schema";
import { protectedHits } from "./improve-schema";

// ONE ENFORCEMENT POINT. Every tool call, and every repo mutation inside one, is
// checked here and nowhere else.
//
// WHAT THIS REPLACES. Each write tool carried its own `if (!mayWrite) return
// fail(DENIED)`, and `mayWrite` was a boolean computed from a two-value grant. That
// shape had three problems and only the first was visible:
//
//   1. A NEW TOOL COULD SIMPLY NOT HAVE THE LINE. test/invariants.test.ts caught the
//      case where the handler contained mutating SQL, which is the common case and
//      not the dangerous one: a tool whose writes happen a module away (the queue,
//      the improve loop, every repo write) was invisible to that scan and had to be
//      named in it by hand.
//   2. THE GATE WAS THE WHOLE VOCABULARY. "May write" said nothing about WHICH
//      namespace, which repo, or whether this caller should be able to merge a pull
//      request into a repo that deploys on push.
//   3. IT WAS SPELLED N TIMES, so widening it meant finding N sites, which is the
//      failure mode capsid/conventions.md calls "a fix that lands in all but one
//      affected site".
//
// THE SHAPE. `checkScope` answers one question and returns a REFUSAL STRING naming
// the missing scope, or null. It is called from two places, and the split is not a
// compromise, it is where the information is:
//
//   - THE REGISTRAR (`guardRegistrations`), before any handler runs, for what is
//     knowable from the tool and its arguments: the tool allowlist, the grant, the
//     namespace and the repo selector.
//   - THE HANDLER, for the FLAGS, which depend on what the call is actually asking
//     to do. `mode: "direct"` needs can_direct_write and `mode: "pr"` does not, and
//     no wrapper can know that before reading the arguments.

// WHAT EACH TOOL REQUIRES, stated once. This is the artifact the registrar enforces
// and the artifact src/tool-annotations.ts's readOnlyHint is derived from, so the
// two cannot disagree about whether a tool writes.
//
// "action" means the requirement depends on the action argument, so the registrar
// cannot decide it and the handler calls checkScope itself at the point where the
// action is known. Exactly two tools are like this and both are subsystem tools with
// a read action: `jobs` (list) and `lint` (gather).
export type ToolRequirement = "read" | "write" | "action";

export const TOOL_GRANTS: Record<string, ToolRequirement> = {
  list: "read",
  read: "read",
  brief: "read",
  backlinks: "read",
  find: "read",
  search: "read",
  namespaces: "read",
  history: "read",

  write: "write",
  delete: "write",
  move: "write",
  restore: "write",
  register_namespace: "write",
  update_namespace: "write",
  // gather reads, finalize archives.
  lint: "action",

  list_repo_tree: "read",
  read_repo_file: "read",
  search_code: "read",
  repo_refs: "read",
  repo_history: "read",
  ci_status: "read",
  write_repo_file: "write",
  create_branch: "write",
  open_pr: "write",
  delete_repo_file: "write",
  manage_pr: "write",
  delete_branch: "write",
  ci_dispatch: "write",

  improve_status: "read",
  improve_run: "write",

  // list reads; every other action changes the queue.
  jobs: "action",

  // The credential control plane. Write at the registrar, and admin-only inside the
  // handler: the registrar can say whether a caller may write, and only the handler
  // can say whether a caller may widen another caller.
  agents: "write",
};

// FAIL CLOSED. A tool with no entry requires the write grant, so a tool added
// without touching this table is refused for a read-only caller rather than being
// waved through. test/scope.test.ts asserts the table and the registrations name the
// same set, so the fallback is a backstop and not the normal path.
export function requiredGrant(tool: string): ToolRequirement {
  return Object.hasOwn(TOOL_GRANTS, tool) ? TOOL_GRANTS[tool] : "write";
}

export interface ScopeNeed {
  tool: string;
  // The action, for a tool whose action decides what it does. Passed by the two
  // "action" tools at the point where the action is known, and by nothing else.
  // Present means the tools axis may narrow this call to the actions it names; see
  // allowsToolAction in agents-schema.ts for the rule.
  action?: string;
  // The namespace this call touches, when it names one. `undefined` means the call
  // does not name one; see namespaceRequired below for why that is not the same as
  // "allowed".
  namespace?: string;
  // The repo selector as the caller passed it (a label, or "owner/name").
  repo?: string;
  grant?: AgentGrant;
  // Flags whose absence refuses the call. Every one is checked, and the refusal
  // names the FIRST missing one.
  flags?: readonly ScopeFlag[];
}

// WHY A FLAG IS NEEDED, in one sentence each, so a refusal tells the caller what to
// ask for rather than only what it lacks.
const FLAG_REASON: Record<ScopeFlag, string> = {
  can_merge: "merging a pull request can trigger a deploy on a repo that deploys on push",
  can_direct_write: "a direct-mode commit lands on the default branch with no review",
  can_dispatch: "dispatching a workflow spends CI minutes and runs code with that repo's secrets in scope",
  can_write_workflows: "a workflow is what MEASURES the code, and a caller that can edit its own measurements has none",
  can_touch_protected: "a protected path is tests, CI, lint or compiler config, a lockfile, a manifest, the agent steering layer, or a migration",
  money_paths: "the path names a billing or payment surface",
  can_comment_pr: "commenting on a pull request writes to a repo, and a reviewer that may comment must not thereby be able to merge or close",
};

// THE ONE CHECK. Returns a refusal naming the missing scope, or null.
//
// Order is deliberate: tool, then grant, then namespace, then repo, then flags. A
// caller that cannot use the tool at all should be told that rather than being told
// its namespace is out of scope, which would leak which namespaces exist.
export function checkScope(agent: Agent, need: ScopeNeed): string | null {
  const scopes = agent.scopes;
  if (!allowsToolAction(scopes.tools, need.tool, need.action)) {
    // The refusal names the QUALIFIED thing that failed. A watcher told it is "not
    // scoped to the 'jobs' tool" after being minted with jobs in its list would go
    // looking for the wrong bug.
    const asked = need.action === undefined ? need.tool : `${need.tool}.${need.action}`;
    return `unauthorized: ${agent.actor} is not scoped to the '${asked}' tool. Its tool scope is ${describeScope(scopes.tools)}.`;
  }
  if (need.grant && !scopes.grants.includes(need.grant)) {
    return (
      `unauthorized: '${need.tool}' requires the ${need.grant} grant and ${agent.actor} holds ${scopes.grants.length ? scopes.grants.join(", ") : "no grant at all"}. ` +
      `A read-only caller can use the read tools and nothing else.`
    );
  }
  if (need.namespace !== undefined && !allowsScope(scopes.namespaces, need.namespace)) {
    return `unauthorized: ${agent.actor} is not scoped to the '${need.namespace}' namespace. Its namespace scope is ${describeScope(scopes.namespaces)}.`;
  }
  if (need.repo !== undefined && !allowsScope(scopes.repos, need.repo)) {
    return `unauthorized: ${agent.actor} is not scoped to the '${need.repo}' repo. Its repo scope is ${describeScope(scopes.repos)}.`;
  }
  for (const flag of need.flags ?? []) {
    if (!scopes.flags[flag]) {
      return `unauthorized: '${need.tool}' needs the ${flag} flag and ${agent.actor} does not hold it, because ${FLAG_REASON[flag]}.`;
    }
  }
  return null;
}

// THE DOCUMENT-SIDE TWIN OF THE PROTECTED-PATH FLAG. `allow_improve_paths` is how a
// caller writes the improve loop's own control surface (its run documents, its
// prompts, its skills, its anchors), and before agents it was open to anything
// holding the write grant. Named here rather than in the tool module so the flag
// vocabulary stays inside the enforcement point.
export const IMPROVE_OVERRIDE_FLAGS = ["can_touch_protected"] as const;

// THE MCP REFUSAL SHAPE. tools/docs.ts has fail() for a handler's own errors; this
// is the same shape spelled here so the enforcement point does not import the tool
// modules it guards, which would be a cycle.
function deny(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// A NAMED NAMESPACE THAT IS OMITTED IS NOT THE SAME AS AN ALLOWED ONE.
//
// Several tools take an optional namespace and mean "every namespace" when it is
// left out: list, search, find, improve_status, jobs list. For a caller scoped to
// "*" that is unchanged. For a NARROWED caller it would be a hole with no check in
// it at all, and the hole would be invisible because the tool works.
//
// So a namespace-restricted caller that omits the namespace on a tool that accepts
// one is refused, and told to name it. Derived from the tool's OWN input schema
// rather than from a list kept here, so a tool that gains a namespace argument is
// covered without anybody remembering to add it.
function namespaceRefusal(agent: Agent, tool: string): string | null {
  if (agent.scopes.namespaces === "*") return null;
  return (
    `unauthorized: ${agent.actor} is scoped to ${describeScope(agent.scopes.namespaces)}, so it must name a namespace on '${tool}'. ` +
    `Omitting it asks for every namespace, which is wider than this caller's scope.`
  );
}

interface RegisteredConfig {
  inputSchema?: Record<string, unknown>;
}

type ToolHandler = (...args: unknown[]) => unknown;

// THE REGISTRAR GATE. Wraps the registration method ONCE, before any tool module
// runs, so every registration that follows is guarded whether or not its author
// thought about it. That is the property the old per-tool line could not have: this
// cannot be forgotten by a new tool, because a new tool has to be registered to
// exist.
//
// It wraps the server rather than replacing the call sites deliberately. Every
// registration stays a literal call on the server object, which is what the source
// guards read (test/invariants.test.ts, test/tool-annotations.test.ts and
// test/counts.test.ts all parse those calls by that exact spelling), so the
// enforcement point lands without blinding the scanners that check the surface it
// enforces over. This module must never spell that call itself, for the same reason:
// a scanner counting registrations would count this one.
export function guardRegistrations(server: McpServer, agent: Agent): void {
  const original = server.registerTool.bind(server) as (name: string, config: unknown, handler: ToolHandler) => unknown;
  const patched = (name: string, config: RegisteredConfig, handler: ToolHandler) => {
    const takesNamespace = Boolean(config?.inputSchema && Object.hasOwn(config.inputSchema, "namespace"));
    const requirement = requiredGrant(name);
    const guarded: ToolHandler = (...callArgs: unknown[]) => {
      const args = (callArgs[0] ?? {}) as Record<string, unknown>;
      const namespace = typeof args.namespace === "string" ? args.namespace : undefined;
      const repo = typeof args.repo === "string" ? args.repo : undefined;
      const refusal = checkScope(agent, {
        tool: name,
        namespace,
        repo,
        // An "action" tool is checked by its handler, where the action is known.
        ...(requirement === "action" ? {} : { grant: requirement }),
      });
      if (refusal) return deny(refusal);
      if (takesNamespace && namespace === undefined) {
        const missing = namespaceRefusal(agent, name);
        if (missing) return deny(missing);
      }
      return handler(...callArgs);
    };
    return original(name, config, guarded);
  };
  (server as unknown as { registerTool: unknown }).registerTool = patched;
}

// MONEY PATHS. A repo path that names a billing or payment surface, matched by NAME,
// which is exactly as strong as that sounds: it is a tripwire on the paths where a
// mistake costs real money, not an authorization boundary. The boundary is the
// namespace-to-repo mapping and the flags beside this one.
//
// Broad on purpose. A false positive costs one refusal that names the flag to ask
// for; a false negative is a payment file edited by a credential nobody scoped for
// it. foxhound is the namespace this exists for and the patterns are portfolio-wide,
// because a payment path is not less dangerous in a repo nobody expected one in.
//
// THE RESIDUAL, STATED RATHER THAN GLOSSED: a word separator counts as a boundary, so
// `stripe-client.ts` trips it and so would `subscription-less.ts`. That is the trade
// taken deliberately, because the common spelling of a real payment file is the
// hyphenated one. The cost is a refusal naming the flag to ask for, which is the
// cheap direction.
const MONEY_PATH = /(^|\/)(billing|payments?|checkout|invoices?|pricing|subscriptions?|stripe|payouts?|refunds?)(\/|[-_.]|$)/i;

export function isMoneyPath(path: string): boolean {
  return MONEY_PATH.test(path);
}

// EVERY FLAG A REPO MUTATION NEEDS, derived from the call rather than from the tool
// name, and computed in ONE function so write_repo_file, delete_repo_file, manage_pr,
// ci_dispatch and delete_branch cannot each decide a different answer.
export function repoWriteFlags(
  tool: string,
  args: { path?: string; mode?: string; action?: string; allow_workflow_write?: boolean }
): ScopeFlag[] {
  const flags: ScopeFlag[] = [];
  if (args.mode === "direct") flags.push("can_direct_write");
  if (args.allow_workflow_write === true) flags.push("can_write_workflows");
  if (tool === "manage_pr" && args.action === "merge") flags.push("can_merge");
  // A COMMENT IS A WRITE, AND IT IS THE SMALLEST ONE THIS TOOL MAKES. Separated from
  // can_merge rather than folded into it so the reviewer role can hold one without
  // the other, which is the whole reason the role exists.
  if (tool === "manage_pr" && args.action === "comment") flags.push("can_comment_pr");
  if (tool === "ci_dispatch") flags.push("can_dispatch");
  // THE SAME PROTECTED LIST THE IMPROVE LOOP ENFORCES (src/improve-schema.ts), not a
  // second copy of it. Those paths are what MEASURE a repo: its tests, its CI, its
  // lint and compiler config, its lockfiles and manifests, its agent steering layer
  // and its migrations. The loop may never touch them at all; a scoped caller may,
  // and only while holding the flag that says so.
  if (args.path && protectedHits([args.path]).length > 0) flags.push("can_touch_protected");
  if (args.path && isMoneyPath(args.path)) flags.push("money_paths");
  return flags;
}
