import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLES, roleMintCommand, selectAgents } from "../scripts/mint-agents.mjs";
import { SCOPE_FLAGS, allowsToolAction, defaultScopes, parseScopes, serializeScopes } from "../src/agents-schema.ts";
import { type Agent } from "../src/agents.ts";
import { checkScope, repoWriteFlags } from "../src/scope.ts";

// GROUP 1: NAMED ROLES, AND THE ONE THING THE SCOPE VOCABULARY COULD NOT SAY.
//
// Three of the four roles are expressible with the axes that already exist. The
// watcher is not: "post a job and nothing else" is an ACTION inside one tool, and
// the tools axis names tools. So a tools entry may now be qualified, `jobs.post`,
// and the jobs handler asks the enforcement point about the qualified name at the
// point where the action is known. That is the same shape hard rule 6 already
// permits for `jobs` and `lint`, not a second enforcement point.

function scopedAgent(mutate: (scopes: ReturnType<typeof defaultScopes>) => void = () => {}): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  mutate(scopes);
  return { id: "agent_aaaaaaaaaaaa", name: "t", kind: "driver", actor: "agent:t", scopes, admin: false, row: null };
}

// ---- the qualified tool entry, as a pure rule ----------------------------------

test("a wildcard tools axis allows every action, so no existing agent changes behaviour", () => {
  // The innocent case first. Every agent minted before this change carries "*", and
  // a guard that refuses them would be found by an outage rather than by a test.
  assert.equal(allowsToolAction("*", "jobs", "post"), true);
  assert.equal(allowsToolAction("*", "jobs", "claim"), true);
  assert.equal(allowsToolAction("*", "jobs", undefined), true);
});

test("an UNQUALIFIED tool entry still allows every action of that tool", () => {
  // Backward compatible on purpose: listing a bare tool name is how the axis has
  // always been written, and it keeps meaning what it meant. Narrowing is something
  // a caller OPTS INTO by naming actions, not something that happens to it.
  const list = ["jobs", "read"];
  assert.equal(allowsToolAction(list, "jobs", "post"), true);
  assert.equal(allowsToolAction(list, "jobs", "claim"), true);
  assert.equal(allowsToolAction(list, "read", undefined), true);
});

test("naming ONE action narrows the tool to the actions named, and the rest are refused", () => {
  const list = ["jobs", "jobs.post"];
  assert.equal(allowsToolAction(list, "jobs", "post"), true);
  assert.equal(allowsToolAction(list, "jobs", "claim"), false, "a qualified entry that did not narrow would be decoration");
  assert.equal(allowsToolAction(list, "jobs", "complete"), false);
  assert.equal(allowsToolAction(list, "jobs", "resume"), false);
});

test("a qualified entry narrows ONLY its own tool", () => {
  // The failure worth guarding: a `jobs.post` entry that also narrowed `lint` would
  // refuse an action nobody restricted, and the refusal would read as a scope error.
  const list = ["jobs", "jobs.post", "lint"];
  assert.equal(allowsToolAction(list, "lint", "gather"), true);
  assert.equal(allowsToolAction(list, "lint", "finalize"), true);
});

test("a tool absent from the list is refused whether or not an action is named", () => {
  const list = ["jobs", "jobs.post"];
  assert.equal(allowsToolAction(list, "write", "post"), false);
  assert.equal(allowsToolAction(list, "write", undefined), false);
  assert.equal(allowsToolAction([], "jobs", "post"), false, "an empty list is the fail-closed value and must allow nothing");
});

test("the qualified name is what a scopes column round-trips, so the narrowing survives storage", () => {
  const scopes = defaultScopes(["capsid"]);
  scopes.tools = ["jobs", "jobs.post"];
  const back = parseScopes(serializeScopes(scopes));
  assert.deepEqual(back.tools, ["jobs", "jobs.post"]);
});

// ---- the same rule, at the one enforcement point --------------------------------

test("checkScope refuses an action the tools axis narrowed away, and names the action", () => {
  const watcher = scopedAgent((s) => {
    s.namespaces = "*";
    s.tools = ["jobs", "jobs.post"];
  });
  assert.equal(checkScope(watcher, { tool: "jobs", action: "post", namespace: "capsid", grant: "write" }), null);

  const refusal = checkScope(watcher, { tool: "jobs", action: "claim", namespace: "capsid", grant: "write" });
  assert.match(String(refusal), /jobs\.claim/, "a refusal that does not name the action leaves the caller guessing which half failed");
  assert.match(String(refusal), /jobs, jobs\.post/, "a refusal that does not say what the scope IS costs a round trip");
});

test("checkScope with no action is exactly what it was, so every other tool is untouched", () => {
  const agent = scopedAgent((s) => {
    s.tools = ["write", "read"];
  });
  assert.equal(checkScope(agent, { tool: "write", namespace: "capsid", grant: "write" }), null);
  assert.match(String(checkScope(agent, { tool: "delete", namespace: "capsid", grant: "write" })), /not scoped to the 'delete' tool/);
});

test("the jobs tool asks the enforcement point about the qualified name", async () => {
  // The unit rules above are worth nothing if the handler never passes the action.
  // Read the source rather than trusting that it does.
  const { sourceFile } = await import("./source-files.ts");
  const jobs = sourceFile("tools/jobs.ts");
  assert.match(
    jobs,
    /ctx\.scope\(\{\s*tool:\s*"jobs",\s*action:\s*args\.action/,
    "tools/jobs.ts does not pass the action to the enforcement point, so a qualified entry narrows nothing"
  );
});

// ---- the reviewer's flag --------------------------------------------------------

test("can_comment_pr is a real flag and a comment is what requires it", () => {
  assert.ok((SCOPE_FLAGS as readonly string[]).includes("can_comment_pr"));
  assert.deepEqual(repoWriteFlags("manage_pr", { action: "comment" }), ["can_comment_pr"]);
});

test("commenting needs can_comment_pr and NOT can_merge, which is the whole point of the role", () => {
  assert.deepEqual(repoWriteFlags("manage_pr", { action: "merge" }), ["can_merge"]);
  assert.ok(!repoWriteFlags("manage_pr", { action: "comment" }).includes("can_merge"));
});

// ---- the four roles -------------------------------------------------------------

const byName = (name: string) => {
  const role = ROLES.find((r: (typeof ROLES)[number]) => r.name === name);
  assert.ok(role, `no role named ${name}`);
  return role;
};

test("the auditor reads everything and writes nothing", () => {
  const auditor = byName("auditor");
  assert.deepEqual(auditor.namespaces, ["*"]);
  assert.deepEqual(auditor.repos, ["*"]);
  assert.deepEqual(auditor.grants, ["read"], "an auditor holding the write grant is not an auditor");
  assert.equal(auditor.flags, undefined);
});

test("the reviewer reads everything and may comment, and holds nothing else", () => {
  const reviewer = byName("reviewer");
  assert.deepEqual(reviewer.grants, ["read", "write"], "commenting goes through a write tool, so the grant is needed");
  assert.deepEqual(reviewer.tools, ["manage_pr", "manage_pr.comment"], "an unqualified manage_pr would let a reviewer merge and close");
  assert.deepEqual(reviewer.flags, { can_comment_pr: true });
});

test("the watcher may post a job and cannot claim, complete or resume one", () => {
  const watcher = byName("watcher");
  assert.deepEqual(watcher.namespaces, ["*"]);
  assert.equal(watcher.flags, undefined, "a watcher with a blast-radius flag is a watcher that can act");
  const tools = watcher.tools;
  assert.ok(tools, "a watcher with no tools axis is scoped to every tool its grant allows, which is the hole this role exists to close");
  assert.ok(tools.includes("jobs.post"));
  for (const action of ["claim", "complete", "fail", "block", "resume", "heartbeat"]) {
    assert.equal(allowsToolAction(tools, "jobs", action), false, `a watcher must not be able to ${action} a job`);
  }
  assert.equal(allowsToolAction(tools, "jobs", "post"), true);
});

test("the site seat is one namespace and one repo, and merges nothing else", () => {
  const seat = byName("site-seat");
  assert.deepEqual(seat.namespaces, ["dustinedwards"]);
  assert.deepEqual(seat.repos, ["*"], "repos is scoped by the namespace mapping, which is the authorization boundary");
  assert.deepEqual(seat.flags, { can_merge: true });
  const held = Object.keys(seat.flags ?? {});
  for (const flag of ["can_direct_write", "can_write_workflows", "can_touch_protected", "money_paths"]) {
    assert.ok(!held.includes(flag), `the site seat must not hold ${flag}`);
  }
});

test("DERIVED: every role names only flags this system has", () => {
  // A flag invented in a mint command does not survive parseScopes, so it would mint
  // an agent that silently holds nothing. Caught here rather than in production.
  for (const role of ROLES) {
    for (const flag of Object.keys(role.flags ?? {})) {
      assert.ok((SCOPE_FLAGS as readonly string[]).includes(flag), `${role.name} names '${flag}', which is not a scope flag`);
    }
  }
});

test("DERIVED: no role is a driver in disguise", () => {
  // The arc's rule is that roles are FEW and SEPARATED. A role holding both the
  // write grant and a repo-mutating flag beyond its own is the shape that erodes it.
  for (const role of ROLES) {
    const flags = Object.keys(role.flags ?? {});
    assert.ok(flags.length <= 1, `${role.name} holds ${flags.length} flags; a role is one capability, not a bundle`);
  }
});

test("each role prints a mint command the script itself can parse", () => {
  for (const role of ROLES) {
    const command = roleMintCommand(role);
    assert.match(command, /node scripts\/mint-agents\.mjs --role /);
    assert.match(command, new RegExp(`--role ${role.name}\\b`));
    assert.match(command, /--apply/);
    assert.ok(!command.includes("CAPSID_OPERATOR_KEY=<"), "a command with a placeholder key is one nobody can paste");
    assert.match(command, /^CAPSID_OPERATOR_KEY=\$CAPSID_OPERATOR_KEY /);
  }
});

test("--role selects exactly one agent, and an unknown role is refused rather than matching nothing", () => {
  assert.deepEqual(
    selectAgents(undefined, undefined, "auditor").map((a) => a.name),
    ["auditor"]
  );
  assert.throws(() => selectAgents(undefined, undefined, "nope"), /no role named 'nope'/);
});

test("a role is NOT reachable through --namespace, so the two selectors cannot collide", () => {
  // site-seat is scoped to dustinedwards. If --namespace dustinedwards picked it up,
  // a routine driver mint would quietly mint a credential holding can_merge.
  const picked = selectAgents("dustinedwards").map((a) => a.name);
  assert.deepEqual(picked, ["dustinedwards-driver"]);
  assert.ok(!picked.includes("site-seat"), "a namespace mint must never reach a role that holds can_merge");
});
