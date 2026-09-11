import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOPE_FLAGS, defaultScopes, type ScopeFlag } from "../src/agents-schema.ts";
import { adminAgent, legacyAgent, type Agent } from "../src/agents.ts";
import { TOOL_GRANTS, checkScope, isMoneyPath, repoWriteFlags, requiredGrant } from "../src/scope.ts";
import { sourceFile, toolBlocks } from "./source-files.ts";

// GROUP 3: ONE ENFORCEMENT POINT, and the refusal names what is missing.
//
// The unit half. test/blast-radius.test.ts is the behavioural half, which drives the
// real handlers over a real MCP connection with a narrowed caller and proves each
// flag is refused at every path that needs it.

function scopedAgent(mutate: (scopes: ReturnType<typeof defaultScopes>) => void = () => {}): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  mutate(scopes);
  return { id: "agent_aaaaaaaaaaaa", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

test("a caller inside every axis is not refused", () => {
  // The innocent case first. A guard that fires on correct calls gets deleted rather
  // than fixed, so it is asserted before any of the refusals below.
  const agent = scopedAgent();
  assert.equal(checkScope(agent, { tool: "write", namespace: "capsid", grant: "write" }), null);
  assert.equal(checkScope(agent, { tool: "read", namespace: "capsid", grant: "read" }), null);
  assert.equal(checkScope(adminAgent("DrDustinEdwards"), { tool: "manage_pr", namespace: "foxhound", grant: "write", flags: SCOPE_FLAGS }), null);
});

test("the refusal names the axis that failed, and names the scope the caller actually has", () => {
  const agent = scopedAgent();
  const namespace = checkScope(agent, { tool: "write", namespace: "foxing", grant: "write" });
  assert.match(String(namespace), /not scoped to the 'foxing' namespace/);
  assert.match(String(namespace), /namespace scope is capsid/, "a refusal that does not say what the scope IS costs a round trip");

  const readOnly = scopedAgent((s) => {
    s.grants = ["read"];
  });
  assert.match(String(checkScope(readOnly, { tool: "write", namespace: "capsid", grant: "write" })), /requires the write grant/);

  const narrowTools = scopedAgent((s) => {
    s.tools = ["read", "search"];
  });
  assert.match(String(checkScope(narrowTools, { tool: "write", namespace: "capsid", grant: "write" })), /not scoped to the 'write' tool/);

  const narrowRepos = scopedAgent((s) => {
    s.repos = ["primary"];
  });
  assert.match(String(checkScope(narrowRepos, { tool: "read_repo_file", namespace: "capsid", repo: "legacy", grant: "read" })), /not scoped to the 'legacy' repo/);
});

test("a missing flag is refused by name, and the refusal says why the flag exists", () => {
  const agent = scopedAgent();
  for (const flag of SCOPE_FLAGS) {
    const refusal = checkScope(agent, { tool: "write_repo_file", namespace: "capsid", grant: "write", flags: [flag] });
    assert.match(String(refusal), new RegExp(`needs the ${flag} flag`), `${flag} was not refused by name`);
    assert.match(String(refusal), /because /, `the ${flag} refusal does not say why the flag exists`);
  }
});

test("the tool check comes before the namespace check, so a refusal does not leak which namespaces exist", () => {
  const agent = scopedAgent((s) => {
    s.tools = ["read"];
  });
  const refusal = checkScope(agent, { tool: "write", namespace: "a-namespace-this-caller-cannot-see", grant: "write" });
  assert.match(String(refusal), /not scoped to the 'write' tool/);
  assert.doesNotMatch(String(refusal), /a-namespace-this-caller-cannot-see/);
});

test("a caller with no scopes at all is refused everything, which is what the fail-closed parse relies on", () => {
  const empty: Agent = {
    id: "agent_000000000000",
    name: "corrupt",
    kind: "driver",
    actor: "agent:corrupt",
    scopes: { namespaces: [], repos: [], tools: [], grants: [], flags: Object.fromEntries(SCOPE_FLAGS.map((f) => [f, false])) as Record<ScopeFlag, boolean> },
    admin: false,
    row: null,
  };
  assert.match(String(checkScope(empty, { tool: "read", namespace: "capsid", grant: "read" })), /not scoped to the 'read' tool/);
  assert.match(String(checkScope(empty, { tool: "list" })), /not scoped to the 'list' tool/);
});

test("the legacy caller passes every check, which is the one thing this migration must not break", () => {
  const legacy = legacyAgent("write", "opkey:0123456789ab");
  for (const tool of Object.keys(TOOL_GRANTS)) {
    assert.equal(checkScope(legacy, { tool, namespace: "foxhound", repo: "legacy", grant: "write", flags: SCOPE_FLAGS }), null, `the legacy key was refused ${tool}`);
  }
});

test("requiredGrant fails closed for a tool nobody has classified", () => {
  assert.equal(requiredGrant("a_tool_nobody_classified"), "write");
  // And not because the lookup answers for Object.prototype, which has bitten this
  // repo twice (counts.ts, tool-annotations.ts).
  assert.equal(requiredGrant("constructor"), "write");
  assert.equal(requiredGrant("toString"), "write");
});

test("repoWriteFlags derives the flags from the CALL, not from the tool name", () => {
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "src/x.ts", mode: "pr" }), []);
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "src/x.ts", mode: "direct" }), ["can_direct_write"]);
  assert.deepEqual(repoWriteFlags("manage_pr", { action: "merge" }), ["can_merge"]);
  assert.deepEqual(repoWriteFlags("manage_pr", { action: "close" }), []);
  assert.deepEqual(repoWriteFlags("ci_dispatch", { path: "improve-score.yml" }), ["can_dispatch"]);
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: ".github/workflows/ci.yml", mode: "pr", allow_workflow_write: true }), [
    "can_write_workflows",
    "can_touch_protected",
  ]);
  // The protected list is the improve loop's, not a second copy.
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "package.json", mode: "pr" }), ["can_touch_protected"]);
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "test/thing.test.ts", mode: "pr" }), ["can_touch_protected"]);
  assert.deepEqual(repoWriteFlags("write_repo_file", { path: "app/billing/charge.ts", mode: "pr" }), ["money_paths"]);
});

test("a money path is matched by name, and an innocent path is not", () => {
  for (const path of ["app/billing/charge.ts", "src/payments.ts", "lib/stripe-client.ts", "routes/checkout/index.tsx", "src/invoice-pdf.ts"]) {
    assert.ok(isMoneyPath(path), `${path} should trip the money-path tripwire`);
  }
  for (const path of ["src/server.ts", "app/routes/billboards.ts", "docs/repayment-history.md", "src/unsubscribe-token.ts"]) {
    assert.equal(isMoneyPath(path), false, `${path} is not a money path and a guard that fires on it gets deleted rather than fixed`);
  }
});

test("the registrar is installed BEFORE any tool module registers, or it guards nothing", () => {
  // Order is the whole property: the wrapper only covers registrations that happen
  // after it is installed, so a registration moved above it would be silently
  // unguarded while every other test still passed.
  const server = sourceFile("server.ts");
  const guard = server.indexOf("guardRegistrations(server, agent)");
  assert.ok(guard > 0, "src/server.ts no longer installs the registrar guard");
  for (const register of ["registerDocTools(", "registerLintTools(", "registerRepoTools(", "registerImproveTools(", "registerJobTools("]) {
    const at = server.indexOf(register);
    assert.ok(at > guard, `${register} runs before the registrar guard is installed, so its tools are unguarded`);
  }
});

test("no tool handler carries a private gate of its own any more", () => {
  // The old shape, gone. A handler that re-introduces `mayWrite` is a second
  // enforcement point, which is the thing this group exists to remove.
  const offenders = toolBlocks().filter((b) => /\bmayWrite\b/.test(b.body)).map((b) => `${b.name} (src/${b.file})`);
  assert.deepEqual(
    offenders,
    [],
    `these handlers still decide the grant themselves instead of going through checkScope: ${offenders.join(", ")}`
  );
});
